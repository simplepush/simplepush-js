// Typed views over the raw WebSocket events, mirroring the Python SDK's event
// dataclasses + `_wrap_*` helpers. A handle's `inputs()` / `replies()` stream
// yields these instead of raw `Event`s. Each view carries a `kind` discriminator
// so consumers can `switch` on it. String fields that can be end-to-end encrypted
// (input values, reply text, choice labels) are decrypted when a matching key is
// available; otherwise the raw (possibly ciphertext) value is passed through.

import { makeDownloadable, type DownloadContext, type DownloadTransport, type Downloadable, type KeyResolver } from "./downloads.js";
import type { Actor, EncryptionMarker, Event } from "./events.js";
import type { CancelReason, NotificationReply } from "./types.js";

/** Decrypts a marked ciphertext string, or returns it unchanged when no key
 * matches / it isn't encrypted. Built by a handle from its send key + the
 * client keyring (see `buildDecryptor`). */
export type Decryptor = (marker: EncryptionMarker | undefined, value: string | undefined) => Promise<string | undefined>;

// --- Submitted input values (a task's committed inputs) ---
//
// The binary uploads (photo/voice/file) and reply files carry the
// `Downloadable` surface — `read()` / `save()` / `downloadUrl()` — bound to the
// client whose stream yielded them (see downloads.ts).

/** A decoded GPS location attached to a reply or submission. Inline data (not a
 * download handle): when the parent is encrypted, the raw event carries only an
 * `encrypted` ciphertext of `JSON.stringify({latitude, longitude, accuracy,
 * altitude, heading, speed, timestamp})`, decrypted under the same marker as the
 * text body; otherwise the structured fields are present directly. */
export type Location = {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number;
  heading?: number;
  speed?: number;
  timestamp?: number;
};

export type TextUpload = { kind: "text"; id?: string; value?: string };
export type ChoiceUpload = { kind: "choice"; id?: string; index?: number; value?: string };
// The recipient's multi-select answer: parallel `indices`/`values` lists of equal
// length (the single-choice `{index, value}` pluralized). Each `values` element is
// decrypted independently under the task marker, like a single choice value.
export type MultiChoiceUpload = { kind: "multiChoice"; id?: string; indices?: number[]; values?: (string | undefined)[] };
// The recipient's tapped action. `key` is the chosen action's stable key,
// decrypted under the task marker (the device encrypts it before posting), so
// the sender reads which button was pressed.
export type ActionUpload = { kind: "action"; id?: string; key?: string };
// A submitted slider value — the chosen number, decrypted via the marker.
export type SliderUpload = { kind: "slider"; id?: string; value?: number };
export type PhotoUpload = { kind: "photo"; id?: string; contentType?: string; checksumSha256?: string; size?: number; filename?: string } & Downloadable;
export type VoiceUpload = { kind: "voice"; id?: string; contentType?: string; checksumSha256?: string; size?: number; durationSeconds?: number; filename?: string } & Downloadable;
export type FileUpload = { kind: "file"; id?: string; contentType?: string; checksumSha256?: string; size?: number; filename?: string } & Downloadable;
// A submitted `location` task input. Inline data decoded via the marker (like
// text/choice), NOT a downloadable file — carries the decoded `Location`.
export type LocationUpload = { kind: "location"; id?: string; location?: Location };
export type Upload = TextUpload | ChoiceUpload | MultiChoiceUpload | ActionUpload | SliderUpload | PhotoUpload | VoiceUpload | FileUpload | LocationUpload;

// --- Reply bodies / files / replies ---

export type TextBody = { kind: "text"; text?: string };
export type ReplyBody = TextBody;

export type ReplyFile = { id?: string; contentType?: string; checksumSha256?: string; size?: number; filename?: string } & Downloadable;

// --- Submissions (a reply without an associated task) ---

export type SubmissionFile = { id?: string; contentType?: string; checksumSha256?: string; size?: number; filename?: string } & Downloadable;

export type ReplyAudio = { id?: string; contentType?: string; checksumSha256?: string; size?: number; durationSeconds?: number; filename?: string } & Downloadable;

export type SubmissionAudio = { id?: string; contentType?: string; checksumSha256?: string; size?: number; durationSeconds?: number; filename?: string } & Downloadable;

export type Submission = {
  kind: "submission";
  id?: string;
  /** Who submitted (from the wire event's `actor`); always present for submissions in practice. */
  actor?: Actor;
  body?: ReplyBody;
  photo?: SubmissionFile;
  file?: SubmissionFile;
  audio?: SubmissionAudio;
  location?: Location;
  createdAt?: string;
  raw: Event;
};

export type Reply = {
  kind: "reply";
  id?: string;
  /** Who replied (from the wire event's `actor`). */
  actor?: Actor;
  body?: ReplyBody;
  photo?: ReplyFile;
  file?: ReplyFile;
  audio?: ReplyAudio;
  location?: Location;
  subtaskId?: string;
  createdAt?: string;
  raw: Event;
};

// --- Stream items (what inputs()/replies() yield) ---

export type InputEvent = { kind: "input"; type: string; uploads: Upload[]; actor?: Actor; raw: Event };
export type TaskCompleted = { kind: "taskCompleted"; taskId?: string; uploads: Upload[]; actor?: Actor; raw: Event };
export type SubtaskCompleted = { kind: "subtaskCompleted"; subtaskId?: string; parentTaskId?: string; uploads: Upload[]; actor?: Actor; raw: Event };
export type TaskDeleted = { kind: "taskDeleted"; taskId?: string; createdAt?: string; actor?: Actor; raw: Event };
/** The sender withdrew the task. Entity-wide terminal: it ends the root's
 * streams AND every subtask stream of the chain (a canceled root closes the
 * whole chain — the backend emits no per-subtask events for it). `note` is
 * decrypted where the chain's key is held. */
export type TaskCanceled = { kind: "taskCanceled"; taskId?: string; reason?: CancelReason; note?: string; supersededBy?: string; createdAt?: string; actor?: Actor; raw: Event };
/** The sender withdrew ONE follow-up; the rest of the chain stays live.
 * `supersededBy` names the replacement subtask (same chain). */
export type SubtaskCanceled = { kind: "subtaskCanceled"; subtaskId?: string; parentTaskId?: string; reason?: CancelReason; note?: string; supersededBy?: string; createdAt?: string; actor?: Actor; raw: Event };
export type NotificationCompleted = { kind: "notificationCompleted"; notificationId?: string; reply?: NotificationReply; actor?: Actor; raw: Event };

/** Items yielded by `Task.inputs()`: intermediate input events, then a terminal
 * `taskCompleted` (full committed set), `taskDeleted`, or `taskCanceled`. */
export type TaskInputItem = InputEvent | TaskCompleted | TaskDeleted | TaskCanceled;
/** Items yielded by `Subtask.inputs()`: intermediate input events, then a
 * terminal `subtaskCompleted` (full committed set), `subtaskCanceled` (this
 * follow-up withdrawn), or `taskDeleted` / `taskCanceled` (chain-wide). */
export type SubtaskInputItem = InputEvent | SubtaskCompleted | SubtaskCanceled | TaskDeleted | TaskCanceled;
/** Items yielded by `Task.replies()` / `Subtask.replies()`: replies, ending with
 * `taskDeleted` / `taskCanceled` (or `subtaskCanceled` on a subtask stream). */
export type ReplyItem = Reply | TaskDeleted | TaskCanceled | SubtaskCanceled;
/** Items yielded by `Notification.inputs()`: a single `notificationCompleted`. */
export type NotificationItem = NotificationCompleted;

// --- Wrappers (raw event data -> typed view) ---

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

async function wrapUpload(
  u: Record<string, unknown>,
  marker: EncryptionMarker | undefined,
  dec: Decryptor,
  dl: DownloadContext | undefined,
): Promise<Upload | undefined> {
  const fileMeta = () => ({ id: str(u.id), contentType: str(u.contentType), checksumSha256: str(u.checksumSha256), filename: str(u.filename) });
  switch (u.type) {
    case "textUploaded":
      return { kind: "text", id: str(u.id), value: await dec(marker, str(u.value)) };
    case "choiceSelected":
      return { kind: "choice", id: str(u.id), index: num(u.selectedIndex), value: await dec(marker, str(u.selectedValue)) };
    case "multiChoiceSelected": {
      // Parallel lists: indices stay plaintext; each value is decrypted
      // independently under the same marker as a single choice value.
      const indices = Array.isArray(u.selectedIndices) ? u.selectedIndices.map(num).filter((n): n is number => n !== undefined) : [];
      const rawValues = Array.isArray(u.selectedValues) ? u.selectedValues : [];
      const values = await Promise.all(rawValues.map((v) => dec(marker, str(v))));
      return { kind: "multiChoice", id: str(u.id), indices, values };
    }
    case "actionSelected":
      return { kind: "action", id: str(u.id), key: await dec(marker, str(u.selectedKey)) };
    case "sliderUploaded": {
      // value rides as a decimal string (ciphertext when encrypted); parse the
      // decrypted text back to a number, dropping to undefined if unreadable.
      const raw = await dec(marker, str(u.value));
      const n = raw !== undefined ? Number(raw) : undefined;
      return { kind: "slider", id: str(u.id), value: n !== undefined && Number.isFinite(n) ? n : undefined };
    }
    case "photoUploaded":
      return { kind: "photo", ...fileMeta(), size: num(u.size), ...makeDownloadable(dl, "inputs", fileMeta(), marker) };
    case "voiceRecorded":
      return { kind: "voice", ...fileMeta(), size: num(u.size), durationSeconds: num(u.durationSeconds), ...makeDownloadable(dl, "inputs", fileMeta(), marker) };
    case "fileUploaded":
      return { kind: "file", ...fileMeta(), size: num(u.size), ...makeDownloadable(dl, "inputs", fileMeta(), marker) };
    case "locationUploaded":
      // Backend LocationUploadedEvent FLATTENS the coords (latitude…encrypted)
      // onto the upload itself — no nested key — so the whole upload is the
      // location payload (wrapLocation reads those fields directly off it).
      return { kind: "location", id: str(u.id), location: await wrapLocation(u, marker, dec) };
    default:
      return undefined; // unrecognised upload type — dropped
  }
}

async function wrapUploads(raw: unknown, marker: EncryptionMarker | undefined, dec: Decryptor, dl: DownloadContext | undefined): Promise<Upload[]> {
  const items = Array.isArray(raw) ? raw : [];
  const wrapped = await Promise.all(items.map((u) => wrapUpload(obj(u), marker, dec, dl)));
  return wrapped.filter((u): u is Upload => u !== undefined);
}

async function wrapReplyBody(body: Record<string, unknown>, marker: EncryptionMarker | undefined, dec: Decryptor): Promise<ReplyBody | undefined> {
  if (!body.type) return undefined;
  if (body.type === "text") return { kind: "text", text: await dec(marker, str(body.value)) };
  return undefined;
}

function wrapReplyFile(f: unknown, marker: EncryptionMarker | undefined, dl: DownloadContext | undefined): ReplyFile | undefined {
  const o = obj(f);
  if (!f || typeof f !== "object") return undefined;
  const meta = { id: str(o.id), contentType: str(o.contentType), checksumSha256: str(o.checksumSha256), filename: str(o.filename) };
  return { ...meta, size: num(o.size), ...makeDownloadable(dl, "replies", meta, marker) };
}

function wrapReplyAudio(a: unknown, marker: EncryptionMarker | undefined, dl: DownloadContext | undefined): ReplyAudio | undefined {
  const o = obj(a);
  if (!a || typeof a !== "object") return undefined;
  const meta = { id: str(o.id), contentType: str(o.contentType), checksumSha256: str(o.checksumSha256), filename: str(o.filename) };
  return { ...meta, size: num(o.size), durationSeconds: num(o.durationSeconds), ...makeDownloadable(dl, "replies", meta, marker) };
}

/** Decode an inline location off a reply/submission. Unlike photo/file/audio
 * (download handles), location is inline data and mirrors the text body: when the
 * raw object carries an `encrypted` ciphertext, decrypt it under the same
 * marker/`dec` as the body and `JSON.parse` the plaintext into the coords;
 * otherwise read the structured fields directly. Degrades to `undefined` on a
 * decrypt/parse failure, like an undecryptable body. */
async function wrapLocation(loc: unknown, marker: EncryptionMarker | undefined, dec: Decryptor): Promise<Location | undefined> {
  if (!loc || typeof loc !== "object") return undefined;
  const o = obj(loc);
  const encrypted = str(o.encrypted);
  if (encrypted !== undefined) {
    try {
      const decrypted = await dec(marker, encrypted);
      return decrypted !== undefined ? (JSON.parse(decrypted) as Location) : undefined;
    } catch {
      return undefined;
    }
  }
  return {
    latitude: num(o.latitude),
    longitude: num(o.longitude),
    accuracy: num(o.accuracy),
    altitude: num(o.altitude),
    heading: num(o.heading),
    speed: num(o.speed),
    timestamp: num(o.timestamp),
  };
}

/** Wrap a `replyAppended` event into a typed `Reply`. */
export async function wrapReply(ev: Event, dec: Decryptor, dl?: DownloadContext): Promise<Reply | SubtaskCanceled> {
  const data = obj(ev.data);
  // A subtask's reply stream also wants its own cancel (scoped terminal).
  if (data.type === "subtaskCanceled") return subtaskCanceledMarker(ev, dec);
  const reply = obj(data.reply);
  const marker = obj(reply.encryption) as EncryptionMarker | undefined;
  const m = reply.encryption ? marker : undefined;
  return {
    kind: "reply",
    id: str(reply.id),
    actor: ev.actor,
    body: await wrapReplyBody(obj(reply.body), m, dec),
    photo: wrapReplyFile(reply.photo, m, dl),
    file: wrapReplyFile(reply.file, m, dl),
    audio: wrapReplyAudio(reply.audio, m, dl),
    location: await wrapLocation(reply.location, m, dec),
    subtaskId: str(data.subtaskId),
    createdAt: str(reply.createdAt),
    raw: ev,
  };
}

function wrapSubmissionFile(f: unknown, marker: EncryptionMarker | undefined, dl: DownloadContext | undefined): SubmissionFile | undefined {
  const o = obj(f);
  if (!f || typeof f !== "object") return undefined;
  const meta = { id: str(o.id), contentType: str(o.contentType), checksumSha256: str(o.checksumSha256), filename: str(o.filename) };
  return { ...meta, size: num(o.size), ...makeDownloadable(dl, "files", meta, marker) };
}

function wrapSubmissionAudio(a: unknown, marker: EncryptionMarker | undefined, dl: DownloadContext | undefined): SubmissionAudio | undefined {
  const o = obj(a);
  if (!a || typeof a !== "object") return undefined;
  const meta = { id: str(o.id), contentType: str(o.contentType), checksumSha256: str(o.checksumSha256), filename: str(o.filename) };
  return { ...meta, size: num(o.size), durationSeconds: num(o.durationSeconds), ...makeDownloadable(dl, "files", meta, marker) };
}

/** Wrap a `submissionCreated` event into a typed `Submission`. Submissions are
 * unsolicited (no per-entity stream), so the download context is built per event
 * from the submission's own id; `base` carries the client transport + keyring
 * resolver (undefined when wrapping raw events yourself → files aren't
 * downloadable). */
export async function wrapSubmission(
  ev: Event,
  dec: Decryptor,
  base?: { transport: DownloadTransport; resolveKey: KeyResolver },
): Promise<Submission> {
  const data = obj(ev.data);
  const submission = obj(data.submission);
  const marker = obj(submission.encryption) as EncryptionMarker | undefined;
  const m = submission.encryption ? marker : undefined;
  const id = str(submission.id);
  const dl: DownloadContext | undefined =
    base && id !== undefined ? { ...base.transport, scope: "submissions", scopeId: id, resolveKey: base.resolveKey } : undefined;
  return {
    kind: "submission",
    id,
    actor: ev.actor,
    body: await wrapReplyBody(obj(submission.body), m, dec),
    photo: wrapSubmissionFile(submission.photo, m, dl),
    file: wrapSubmissionFile(submission.file, m, dl),
    audio: wrapSubmissionAudio(submission.audio, m, dl),
    location: await wrapLocation(submission.location, m, dec),
    createdAt: str(submission.createdAt),
    raw: ev,
  };
}

/** Wrap a task OR subtask input/completion event. The completion events become
 * the dedicated terminal markers; the rest become `InputEvent`. */
export async function wrapInput(ev: Event, dec: Decryptor, dl?: DownloadContext): Promise<InputEvent | TaskCompleted | SubtaskCompleted | SubtaskCanceled> {
  const data = obj(ev.data);
  const marker = ev.encryption;
  const dataType = str(data.type) ?? "";
  if (dataType === "taskCompleted") {
    return { kind: "taskCompleted", taskId: str(data.taskId), uploads: await wrapUploads(data.inputsUploaded, marker, dec, dl), actor: ev.actor, raw: ev };
  }
  if (dataType === "subtaskCompleted") {
    return { kind: "subtaskCompleted", subtaskId: str(data.subtaskId), parentTaskId: str(data.parentTaskId), uploads: await wrapUploads(data.inputsUploaded, marker, dec, dl), actor: ev.actor, raw: ev };
  }
  if (dataType === "subtaskCanceled") return subtaskCanceledMarker(ev, dec);
  const hasUpload =
    dataType === "taskInputUploaded" || dataType === "taskInputCompleted" ||
    dataType === "subtaskInputUploaded" || dataType === "subtaskInputCompleted";
  const rawUploads = hasUpload && data.inputUploaded ? [data.inputUploaded] : [];
  return { kind: "input", type: dataType, uploads: await wrapUploads(rawUploads, marker, dec, dl), actor: ev.actor, raw: ev };
}

/** The recipient's answer on a `notificationCompleted` event. */
export async function wrapNotificationReply(reply: unknown, marker: EncryptionMarker | undefined, dec: Decryptor): Promise<NotificationReply | undefined> {
  const r = obj(reply);
  if (!reply || typeof reply !== "object") return undefined;
  if (r.type === "text") return { type: "text", value: (await dec(marker, str(r.value))) ?? "" };
  if (r.type === "choice") {
    return { type: "choice", selectedIndex: num(r.selectedIndex) ?? 0, selectedValue: (await dec(marker, str(r.selectedValue))) ?? "" };
  }
  // The tapped action's key is ciphertext when the notification is encrypted
  // (the device re-encrypts it before posting, like a choice reply's value).
  if (r.type === "actions") return { type: "actions", selectedKey: (await dec(marker, str(r.selectedKey))) ?? "" };
  return undefined;
}

/** Wrap the sole notification event (`notificationCompleted`). */
export async function wrapNotification(ev: Event, dec: Decryptor): Promise<NotificationCompleted> {
  const data = obj(ev.data);
  return {
    kind: "notificationCompleted",
    actor: ev.actor,
    notificationId: str(data.notificationId),
    reply: await wrapNotificationReply(data.reply, ev.encryption, dec),
    raw: ev,
  };
}

/** Build a marker on the `taskDeleted` terminal. */
export function deletedMarker(ev: Event): TaskDeleted {
  const data = obj(ev.data);
  // routing id: a task chain root (notifications have no deletion event).
  const id = str(data.taskId) ?? str(data.parentTaskId);
  return { kind: "taskDeleted", taskId: id, createdAt: ev.createdAt, actor: ev.actor, raw: ev };
}

/** Build a marker on the `taskCanceled` entity-wide terminal. The event
 * envelope's `encryption` is the NOTE's own marker (not the task's — the note
 * is this event's only encrypted field and may use a different key than the
 * send), so the generic envelope decrypt below is exactly right;
 * reason/supersededBy stay plaintext. */
export async function canceledMarker(ev: Event, dec: Decryptor): Promise<TaskCanceled> {
  const data = obj(ev.data);
  return {
    kind: "taskCanceled",
    taskId: str(data.taskId),
    reason: str(data.reason) as CancelReason | undefined,
    note: await dec(ev.encryption, str(data.note)),
    supersededBy: str(data.supersededBy),
    createdAt: ev.createdAt,
    actor: ev.actor,
    raw: ev,
  };
}

/** Build a marker on the `subtaskCanceled` scoped terminal. */
export async function subtaskCanceledMarker(ev: Event, dec: Decryptor): Promise<SubtaskCanceled> {
  const data = obj(ev.data);
  return {
    kind: "subtaskCanceled",
    subtaskId: str(data.subtaskId),
    parentTaskId: str(data.parentTaskId),
    reason: str(data.reason) as CancelReason | undefined,
    note: await dec(ev.encryption, str(data.note)),
    supersededBy: str(data.supersededBy),
    createdAt: ev.createdAt,
    actor: ev.actor,
    raw: ev,
  };
}
