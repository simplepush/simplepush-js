// Best-effort in-place decryption of base64-string fields inside an event's
// `data` payload. Cheap heuristic: spush ciphertext is base64 of >=28 bytes,
// so the encoded form is >=40 chars and consists of base64 characters.

import { decrypt } from "./crypto.js";
import { isEncrypted, type EncryptionMarker, type Event } from "./events.js";
import { Keyring } from "./keyring.js";

export async function tryDecryptEventData(event: Event, keyring: Keyring): Promise<unknown | undefined> {
  if (!isEncrypted(event)) return undefined;
  // Personal markers resolve to a fingerprint-keyed derived key; org markers to
  // a master_key by version (present only if org keys were supplied). Either
  // way, undefined means we hold no matching key, so leave the data as-is.
  const key = keyring.keyForMarker(event.encryption!);
  if (!key) return undefined;
  return decryptInPlace(structuredClone(event.data), key);
}

async function decryptInPlace(value: unknown, key: Uint8Array): Promise<unknown> {
  if (typeof value === "string") {
    if (looksLikeCiphertext(value)) {
      try { return await decrypt(key, value); }
      catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = await decryptInPlace(value[i], key);
    return value;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) obj[k] = await decryptInPlace(obj[k], key);
    return obj;
  }
  return value;
}

/** Best-effort decryption of an arbitrary wire tree (a task payload, a chain,
 * a submission, a task summary). Any object carrying its own `encryption`
 * marker decrypts its ciphertext-looking strings under that key; nested
 * objects inherit the nearest ancestor's marker (`inherited` seeds the root,
 * e.g. an event envelope's marker for its `data`). Markers are stripped from
 * the result. Strings whose key the keyring does not hold are left as they
 * are and counted in `undecryptable`, so a caller can say so instead of
 * presenting base64 as content. The input is not mutated. */
export async function tryDecryptTree(
  value: unknown,
  keyring: Keyring,
  inherited?: EncryptionMarker,
): Promise<{ value: unknown; undecryptable: number }> {
  const state = { undecryptable: 0 };
  const out = await decryptNode(structuredClone(value), keyring, inherited, state);
  return { value: out, undecryptable: state.undecryptable };
}

async function decryptNode(value: unknown, keyring: Keyring, marker: EncryptionMarker | undefined, state: { undecryptable: number }): Promise<unknown> {
  if (typeof value === "string") {
    if (marker === undefined || !looksLikeCiphertext(value)) return value;
    const key = keyring.keyForMarker(marker);
    if (key === undefined) { state.undecryptable++; return value; }
    try { return await decrypt(key, value); }
    catch { state.undecryptable++; return value; }
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = await decryptNode(value[i], keyring, marker, state);
    return value;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const own = obj.encryption as EncryptionMarker | undefined;
    const effective = own && typeof own === "object" && "type" in own ? own : marker;
    delete obj.encryption;
    for (const k of Object.keys(obj)) obj[k] = await decryptNode(obj[k], keyring, effective, state);
    return obj;
  }
  return value;
}

const CIPHERTEXT_RE = /^[A-Za-z0-9+/=]+$/;

export function looksLikeCiphertext(s: string): boolean {
  return s.length >= 40 && s.length <= 8192 && CIPHERTEXT_RE.test(s);
}
