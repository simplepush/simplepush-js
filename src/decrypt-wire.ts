// Schema-driven decryption of the wire JSON the read surface returns (task
// payloads, chains, summaries, submissions, raw events). The encrypted fields
// are EXACTLY the ones the send side seals (`encryptInput` / the build*Data
// helpers in client.ts) and the view layer decrypts (event-views.ts); this
// module mirrors that map field by field.
//
// Marker rules, matching the view layer:
//   - a payload/summary/entry marker covers its sender-authored fields;
//   - an upload record's own `encryption` wins over the envelope's (answers
//     sealed after an org key rotation carry newer keys than the task);
//   - replies, decline notes and cancel notes carry STRICTLY their own marker
//     (they are authored after the send; absent marker = plaintext note);
//   - a `location`'s coords ride as one `encrypted` JSON blob, expanded in
//     place, exactly like a slider input's sealed scale.
//
// Every known-encrypted field under a marker either decrypts or increments
// `undecryptable` — nothing else is ever attempted. The price of precision is
// that a NEW encrypted wire field must be added here (and to event-views);
// the payoff is that "undecryptable: N" always means real sealed content.

import { decrypt } from "./crypto.js";
import type { EncryptionMarker } from "./events.js";
import { Keyring } from "./keyring.js";

export type DecryptedWire = { value: unknown; undecryptable: number };

type State = { undecryptable: number };
type Rec = Record<string, unknown>;

function obj(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function markerOf(v: unknown): EncryptionMarker | undefined {
  const m = obj(v);
  return m && typeof m.type === "string" ? (m as unknown as EncryptionMarker) : undefined;
}

/** Decrypt `o[field]` in place when it is a string and a marker applies.
 * No marker = plaintext field, left alone; a marker with no matching key or a
 * failed authentication counts as undecryptable and leaves the ciphertext. */
async function decField(o: Rec, field: string, marker: EncryptionMarker | undefined, kr: Keyring, st: State): Promise<void> {
  const v = o[field];
  if (typeof v !== "string" || marker === undefined) return;
  const key = kr.keyForMarker(marker);
  if (!key) {
    st.undecryptable++;
    return;
  }
  try {
    o[field] = await decrypt(key, v);
  } catch {
    st.undecryptable++;
  }
}

/** Decrypt-and-JSON-expand a `{ encrypted: "…" }` blob (slider scale,
 * location coords) onto the record itself, dropping the blob on success. */
async function decBlob(o: Rec, marker: EncryptionMarker | undefined, kr: Keyring, st: State): Promise<void> {
  const v = o.encrypted;
  if (typeof v !== "string" || marker === undefined) return;
  const key = kr.keyForMarker(marker);
  if (!key) {
    st.undecryptable++;
    return;
  }
  try {
    const plain = JSON.parse(await decrypt(key, v)) as Rec;
    delete o.encrypted;
    Object.assign(o, plain);
  } catch {
    st.undecryptable++;
  }
}

async function decInput(input: unknown, marker: EncryptionMarker | undefined, kr: Keyring, st: State): Promise<void> {
  const i = obj(input);
  if (!i) return;
  await decField(i, "description", marker, kr, st);
  if (i.type === "text") await decField(i, "defaultValue", marker, kr, st);
  if (i.type === "choice" && Array.isArray(i.options)) {
    for (let k = 0; k < i.options.length; k++) {
      const wrap: Rec = { v: i.options[k] };
      await decField(wrap, "v", marker, kr, st);
      i.options[k] = wrap.v;
    }
  }
  if (i.type === "actions" && Array.isArray(i.actions)) {
    for (const a of i.actions) {
      const act = obj(a);
      if (!act) continue;
      await decField(act, "key", marker, kr, st);
      await decField(act, "label", marker, kr, st);
    }
  }
  if (i.type === "slider") await decBlob(i, marker, kr, st);
}

async function decLocation(loc: unknown, marker: EncryptionMarker | undefined, kr: Keyring, st: State): Promise<void> {
  const l = obj(loc);
  if (l) await decBlob(l, marker, kr, st);
}

/** An answer record (`textUploaded`, `choiceSelected`, …), as it appears both
 * in event data and in a payload's `uploads`. Own marker wins over the
 * envelope's. File-kind records carry only plaintext metadata. */
async function decUpload(u: unknown, envelope: EncryptionMarker | undefined, kr: Keyring, st: State): Promise<void> {
  const r = obj(u);
  if (!r) return;
  const marker = markerOf(r.encryption) ?? envelope;
  delete r.encryption;
  switch (r.type) {
    case "textUploaded":
    case "sliderUploaded":
      await decField(r, "value", marker, kr, st);
      return;
    case "choiceSelected":
      await decField(r, "selectedValue", marker, kr, st);
      return;
    case "multiChoiceSelected":
      if (Array.isArray(r.selectedValues)) {
        for (let k = 0; k < r.selectedValues.length; k++) {
          const wrap: Rec = { v: r.selectedValues[k] };
          await decField(wrap, "v", marker, kr, st);
          r.selectedValues[k] = wrap.v;
        }
      }
      return;
    case "actionSelected":
      await decField(r, "selectedKey", marker, kr, st);
      return;
    case "locationUploaded":
      // Backend flattens the coords onto the record itself — no nested key.
      await decBlob(r, marker, kr, st);
      return;
    default:
      return; // photo/voice/file: plaintext metadata only
  }
}

/** A reply/submission body plus inline location, under the given marker. */
async function decMessageBody(container: Rec, marker: EncryptionMarker | undefined, kr: Keyring, st: State): Promise<void> {
  const body = obj(container.body);
  if (body && body.type === "text") await decField(body, "value", marker, kr, st);
  await decLocation(container.location, marker, kr, st);
}

/** A reply record off a payload's `replies` — its own marker only. */
async function decReplyRecord(r: unknown, kr: Keyring, st: State): Promise<void> {
  const rep = obj(r);
  if (!rep) return;
  const marker = markerOf(rep.encryption);
  delete rep.encryption;
  await decMessageBody(rep, marker, kr, st);
}

/** A decline record / the cancellation block — the note's own marker only. */
async function decNoteRecord(r: unknown, kr: Keyring, st: State): Promise<void> {
  const rec = obj(r);
  if (!rec) return;
  const marker = markerOf(rec.encryption);
  delete rec.encryption;
  await decField(rec, "note", marker, kr, st);
}

/** Task or subtask payload, in place (chain reads return payloads verbatim). */
async function decPayloadInPlace(p: Rec, kr: Keyring, st: State): Promise<void> {
  const marker = markerOf(p.encryption);
  delete p.encryption;
  await decField(p, "tag", marker, kr, st);
  await decField(p, "title", marker, kr, st);
  await decField(p, "content", marker, kr, st);
  if (Array.isArray(p.attachments)) {
    for (const a of p.attachments) {
      const att = obj(a);
      if (att && att.type === "link") await decField(att, "url", marker, kr, st);
    }
  }
  if (Array.isArray(p.inputs)) for (const i of p.inputs) await decInput(i, marker, kr, st);
  if (Array.isArray(p.uploads)) for (const u of p.uploads) await decUpload(u, marker, kr, st);
  if (Array.isArray(p.replies)) for (const r of p.replies) await decReplyRecord(r, kr, st);
  if (Array.isArray(p.declines)) for (const d of p.declines) await decNoteRecord(d, kr, st);
  await decNoteRecord(p.cancellation, kr, st);
}

/** Decrypts a task or subtask payload (the shapes chain reads return). */
export async function decryptTaskPayload(value: unknown, kr: Keyring): Promise<DecryptedWire> {
  const st: State = { undecryptable: 0 };
  const out = structuredClone(value);
  const p = obj(out);
  if (p) await decPayloadInPlace(p, kr, st);
  return { value: out, undecryptable: st.undecryptable };
}

/** Decrypts a task index / group roster row: `title` and `tag` are its sealed fields. */
export async function decryptTaskSummary(value: unknown, kr: Keyring): Promise<DecryptedWire> {
  const st: State = { undecryptable: 0 };
  const out = structuredClone(value);
  const s = obj(out);
  if (s) {
    const marker = markerOf(s.encryption);
    delete s.encryption;
    await decField(s, "title", marker, kr, st);
    await decField(s, "tag", marker, kr, st);
  }
  return { value: out, undecryptable: st.undecryptable };
}

/** Decrypts a submission (body + inline location) under the entry's marker —
 * the submission carries no marker of its own; the feed envelope's applies. */
export async function decryptSubmission(value: unknown, kr: Keyring, marker: EncryptionMarker | undefined): Promise<DecryptedWire> {
  const st: State = { undecryptable: 0 };
  const out = structuredClone(value);
  const s = obj(out);
  if (s) await decMessageBody(s, marker, kr, st);
  return { value: out, undecryptable: st.undecryptable };
}

/** Decrypts one wire event's `data` in place on a clone of the event, by
 * event-data type — the same per-type map the watch views use. Unrecognized
 * types pass through untouched. */
export async function decryptEvent(event: unknown, kr: Keyring): Promise<DecryptedWire> {
  const st: State = { undecryptable: 0 };
  const out = structuredClone(event);
  const ev = obj(out);
  const data = ev ? obj(ev.data) : undefined;
  if (!ev || !data) return { value: out, undecryptable: st.undecryptable };
  const marker = markerOf(ev.encryption);
  switch (data.type) {
    case "taskInputUploaded":
    case "taskInputCompleted":
    case "subtaskInputUploaded":
    case "subtaskInputCompleted":
      await decUpload(data.inputUploaded, marker, kr, st);
      break;
    case "taskCompleted":
    case "subtaskCompleted":
      if (Array.isArray(data.inputsUploaded)) for (const u of data.inputsUploaded) await decUpload(u, marker, kr, st);
      break;
    case "replyAppended": {
      const reply = obj(data.reply);
      if (reply) await decMessageBody(reply, marker, kr, st);
      break;
    }
    case "submissionCreated": {
      const submission = obj(data.submission);
      if (submission) await decMessageBody(submission, marker, kr, st);
      break;
    }
    case "notificationCompleted": {
      const reply = obj(data.reply);
      if (reply) {
        if (reply.type === "text") await decField(reply, "value", marker, kr, st);
        if (reply.type === "choice") await decField(reply, "selectedValue", marker, kr, st);
        if (reply.type === "actions") await decField(reply, "selectedKey", marker, kr, st);
      }
      break;
    }
    // The envelope marker on these IS the note's own marker — the note is the
    // event's only encrypted field (reason/supersededBy stay plaintext).
    case "taskCanceled":
    case "subtaskCanceled":
    case "taskDeclinedByRecipient":
    case "subtaskDeclinedByRecipient":
    case "taskDeclined":
    case "subtaskDeclined":
      await decField(data, "note", marker, kr, st);
      break;
    default:
      break;
  }
  return { value: out, undecryptable: st.undecryptable };
}
