// Decryption of a raw event's `data` payload via a `Keyring`, driven by the
// per-event-type field map in decrypt-wire.ts, the same fields the watch
// views decrypt.

import { decryptEvent } from "./decrypt-wire.js";
import { isEncrypted, type Event } from "./events.js";
import { Keyring } from "./keyring.js";

/** Returns a decrypted copy of `event.data`, or undefined when the event
 * isn't encrypted or no held key matches its marker. A field that fails to
 * decrypt (e.g. sealed under a newer org key) is left as ciphertext. */
export async function tryDecryptEventData(event: Event, keyring: Keyring): Promise<unknown | undefined> {
  if (!isEncrypted(event)) return undefined;
  const key = keyring.keyForMarker(event.encryption!);
  if (!key) return undefined;
  const { value } = await decryptEvent(event, keyring);
  return (value as { data?: unknown }).data;
}
