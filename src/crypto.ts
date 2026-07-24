// Pipeline: sha256(salt) -> Argon2id(password) -> HKDF-SHA256("symmetric-key")
//   -> 32-byte XChaCha20-Poly1305 key.
// Fingerprint: base64(sha256(symmetric_key)[0:8]).
// Wire format: base64(24-byte nonce || ciphertext || 16-byte Poly1305 tag).
//
// One library (libsodium-wrappers-sumo) for every primitive — Argon2id,
// HKDF expand, SHA-256, AEAD — keeping the SDK's crypto identical in shape
// to the CLI's `cli/src/crypto/*` (which uses the same dependency) and to
// the app's `react-native-libsodium`-backed org-encryption code. The
// "personal symmetric" wire format is XChaCha20-Poly1305, matching the
// org-encryption AEAD; only the marker (fingerprint vs version) tells the
// recipient which key to use.

import _sodium from "libsodium-wrappers-sumo";

// Cached singleton — concurrent callers share one await rather than racing
// to re-resolve the WASM ready promise. Top-level await isn't an option
// here because consumers (the CLI) bundle this with tsdown and we don't
// want to force them onto a specific bundler config.
let readyPromise: Promise<typeof _sodium> | null = null;
async function sodium(): Promise<typeof _sodium> {
  if (!readyPromise) readyPromise = _sodium.ready.then(() => _sodium);
  return readyPromise;
}

const ARGON2_MEMORY_BYTES = 64 * 1024 * 1024;
const ARGON2_ITERATIONS = 3;
const ARGON2_OUTPUT_LEN = 64;
const HKDF_INFO = new TextEncoder().encode("symmetric-key");
const SYMMETRIC_KEY_LEN = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

export type DerivedKey = {
  symmetricKey: Uint8Array;
  fingerprint: string;
};

// `salt` is expected to be the topic value (the user-typed topic name), NOT
// the topic id. This is deliberate so external senders (API-key writers, the
// CLI's `-k <topic>` flag) can derive the key from just public info — topic
// name + password — without a prior backend lookup to fetch the topic's UUID.
// Argon2's per-attempt cost defends against the lower salt entropy. Same
// fingerprint property would hold if we used the topic id (also identical
// across users for a given topic), but value-as-salt keeps senders self-
// contained. The app's TopicCryptoService uses the same convention.
export async function deriveKey(password: string, salt: string): Promise<DerivedKey> {
  const s = await sodium();
  // SHA-256 over the salt string gives us a fixed 32-byte Argon2 salt,
  // matching the CLI's pipeline.
  const saltBytes = s.crypto_hash_sha256(new TextEncoder().encode(salt));
  // crypto_pwhash returns the raw Argon2id output (no PHC string), 64 bytes
  // here per ARGON2_OUTPUT_LEN. Sumo variant required for crypto_pwhash;
  // standard libsodium-wrappers omits it.
  const master = s.crypto_pwhash(
    ARGON2_OUTPUT_LEN,
    password,
    saltBytes.subarray(0, s.crypto_pwhash_SALTBYTES),
    ARGON2_ITERATIONS,
    ARGON2_MEMORY_BYTES,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
  // HKDF-SHA256 expand. libsodium-wrappers only ships the constants for
  // hkdf_sha256, not the function — so we hand-roll the one-block expand
  // we actually need (RFC 5869): T(1) = HMAC(PRK, info ‖ 0x01), take the
  // first L bytes. Output identical to Web Crypto's `subtle.deriveBits`
  // for the same (PRK, info, L) tuple.
  const symmetricKey = await hkdfSha256ExpandOneBlock(s, master, HKDF_INFO, SYMMETRIC_KEY_LEN);
  const fingerprint = await fingerprintFor(symmetricKey);
  return { symmetricKey, fingerprint };
}

export async function fingerprintFor(symmetricKey: Uint8Array): Promise<string> {
  const s = await sodium();
  const digest = s.crypto_hash_sha256(symmetricKey);
  return s.to_base64(digest.subarray(0, 8), s.base64_variants.ORIGINAL);
}

export async function encrypt(symmetricKey: Uint8Array, plaintext: string): Promise<string> {
  const s = await sodium();
  if (symmetricKey.length !== SYMMETRIC_KEY_LEN) {
    throw new Error(`expected ${SYMMETRIC_KEY_LEN}-byte key, got ${symmetricKey.length}`);
  }
  const nonce = s.randombytes_buf(NONCE_BYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(plaintext),
    null,
    null,
    nonce,
    symmetricKey,
  );
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, nonce.length);
  return s.to_base64(blob, s.base64_variants.ORIGINAL);
}

/** Encrypt a raw byte buffer to the `nonce(24) || ciphertext || tag(16)` blob
 * format file uploads are stored in on S3 — the byte-level counterpart to
 * `encrypt` (which base64-encodes a string) and the inverse of `decryptBytes`.
 * The sending device AEAD-encrypts the whole file and uploads this binary blob
 * as-is. Matches the python library's `encrypt_bytes`. */
export async function encryptBytes(symmetricKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  if (symmetricKey.length !== SYMMETRIC_KEY_LEN) {
    throw new Error(`expected ${SYMMETRIC_KEY_LEN}-byte key, got ${symmetricKey.length}`);
  }
  const nonce = s.randombytes_buf(NONCE_BYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, symmetricKey);
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, nonce.length);
  return blob;
}

// One-block HKDF-SHA256 expand. Sufficient for our 32-byte symmetric_key
// derivation (one HMAC iteration). The streaming HMAC API accepts the
// variable-length 64-byte Argon2 output as the PRK; the single-call
// `crypto_auth_hmacsha256(message, key)` requires a fixed 32-byte key.
async function hkdfSha256ExpandOneBlock(
  s: typeof _sodium,
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (length < 1 || length > 32) {
    throw new Error(`hkdfSha256ExpandOneBlock: length must be 1..32, got ${length}`);
  }
  const msg = new Uint8Array(info.length + 1);
  msg.set(info, 0);
  msg[info.length] = 0x01;
  const state = s.crypto_auth_hmacsha256_init(prk);
  s.crypto_auth_hmacsha256_update(state, msg);
  const full = s.crypto_auth_hmacsha256_final(state);
  return full.subarray(0, length);
}

export async function decrypt(symmetricKey: Uint8Array, ciphertextB64: string): Promise<string> {
  const s = await sodium();
  const blob = s.from_base64(ciphertextB64, s.base64_variants.ORIGINAL);
  return new TextDecoder().decode(await decryptBytes(symmetricKey, blob));
}

/** Decrypt a raw `nonce(24) || ciphertext || tag(16)` blob (no base64). This is
 * the format file uploads are stored in on S3: the uploading device
 * AEAD-encrypts the whole file and uploads the binary blob as-is, so a
 * downloaded encrypted file decrypts with exactly this. */
export async function decryptBytes(symmetricKey: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  if (symmetricKey.length !== SYMMETRIC_KEY_LEN) {
    throw new Error(`expected ${SYMMETRIC_KEY_LEN}-byte key, got ${symmetricKey.length}`);
  }
  if (blob.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error(`ciphertext too short: ${blob.length} bytes`);
  }
  const nonce = blob.subarray(0, NONCE_BYTES);
  const body = blob.subarray(NONCE_BYTES);
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, body, null, nonce, symmetricKey);
}

/** base64(sha256(data)) — the upload checksum format (`checksumSha256`). */
export async function sha256Base64(data: Uint8Array): Promise<string> {
  const s = await sodium();
  return s.to_base64(s.crypto_hash_sha256(data), s.base64_variants.ORIGINAL);
}
