// In-memory mapping fingerprint -> DerivedKey, built once at startup.
// Per password we derive one key per salt: the user's `passwordSalt` (covers
// submission events under the personal-mode default key) and each `-k` topic
// value (covers task input events on those topics).

import { deriveKey, type DerivedKey } from "./crypto.js";
import type { EncryptionMarker } from "./events.js";

const ORG_MASTER_KEY_LEN = 32;

/** An org `master_key` for a given version. The key is the raw 32-byte
 * XChaCha20-Poly1305 key, obtained out-of-band from the org's encryption vault
 * (the SDK cannot derive it). */
export type OrgMasterKey = { version: number; key: Uint8Array };

export type KeyringInput = {
  passwords: string[];
  /** Server-issued per-user salt (urlsafe-base64). When provided, derives the
   * personal-mode default key alongside the topic keys. Fetched once via
   * `GET /v1/user` and passed in by the caller. */
  passwordSalt?: string;
  topics: string[];
  /** Org master keys (version -> 32-byte key) for decrypting org-mode content.
   * Without them, org ciphertext can't be read and is left as-is. */
  orgMasterKeys?: OrgMasterKey[];
  /** Personal keys supplied directly rather than derived from a password —
   * exported from the app, or unwrapped from an integration token. They match
   * by fingerprint exactly like derived keys do, because the wire marker is the
   * same `{type:"personal", keyFingerprint}` either way: a key is a key, and
   * nothing on the wire records how it was produced. */
  personalKeys?: DerivedKey[];
};

export class Keyring {
  // Personal/topic keys, matched by fingerprint.
  private readonly byFingerprint = new Map<string, DerivedKey>();
  // Org master keys, matched by version.
  private readonly byVersion = new Map<number, Uint8Array>();

  static async build(input: KeyringInput): Promise<Keyring> {
    const ring = new Keyring();

    // Org master keys are added before the password early-out so an org-only
    // consumer (no passwords) still gets a usable keyring.
    for (const { version, key } of input.orgMasterKeys ?? []) {
      if (key.length !== ORG_MASTER_KEY_LEN) {
        throw new Error(`org master key v${version} must be ${ORG_MASTER_KEY_LEN} bytes, got ${key.length}`);
      }
      ring.byVersion.set(version, key);
    }

    // Added before the early-out so a key-only consumer (no passwords) still
    // gets a usable keyring.
    for (const dk of input.personalKeys ?? []) ring.byFingerprint.set(dk.fingerprint, dk);

    const jobs: Array<{ password: string; salt: string }> = [];
    for (const password of input.passwords) {
      if (input.passwordSalt) jobs.push({ password, salt: input.passwordSalt });
      for (const topic of input.topics) jobs.push({ password, salt: topic });
    }
    if (jobs.length === 0) return ring;


    // Argon2id is CPU-bound; running them in parallel via Promise.all gives the
    // WASM scheduler room to interleave but is single-threaded in practice.
    // Acceptable for the typical 1-3 derivations done at startup.
    const derived = await Promise.all(jobs.map((j) => deriveKey(j.password, j.salt)));
    for (const dk of derived) ring.byFingerprint.set(dk.fingerprint, dk);
    return ring;
  }

  /** Fold in an already-derived key (e.g. a per-send key), matched by its
   * fingerprint. Cheap — no Argon2 — so the keyring can grow as sends happen,
   * letting the raw `events()` feed decrypt replies to those sends too. */
  add(key: DerivedKey): void {
    this.byFingerprint.set(key.fingerprint, key);
  }

  lookup(fingerprint: string): DerivedKey | undefined {
    return this.byFingerprint.get(fingerprint);
  }

  lookupOrg(version: number): Uint8Array | undefined {
    return this.byVersion.get(version);
  }

  /** Resolve the raw symmetric key for an encryption marker, or undefined.
   * Personal markers match a derived key by fingerprint; org markers a
   * master_key by version. */
  keyForMarker(marker: EncryptionMarker): Uint8Array | undefined {
    return marker.type === "personal"
      ? this.byFingerprint.get(marker.keyFingerprint)?.symmetricKey
      : this.byVersion.get(marker.v);
  }

  /** Number of personal/topic fingerprints held (org keys counted separately). */
  get size(): number {
    return this.byFingerprint.size;
  }

  get orgKeyCount(): number {
    return this.byVersion.size;
  }

  get isEmpty(): boolean {
    return this.byFingerprint.size === 0 && this.byVersion.size === 0;
  }
}
