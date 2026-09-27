// The read side of the API: the task index, one task's chain, a group roster,
// event history and submissions. Org clients hit the /v1/org twins, personal
// clients the /v1 ones; the response shapes are identical. Every list is one
// keyset page — `nextCursor` present means more, pass it back as `cursor`.
// Payloads come back exactly as stored (ciphertext where encrypted); see
// `tryDecryptTree` for best-effort decryption with a Keyring.

import { HttpError } from "./errors.js";
import type { Actor, EncryptionMarker, Event } from "./events.js";
import type { ContentFormat, Input, ReplyMode } from "./types.js";
import type { Submission as _Submission } from "./event-views.js";

export type TaskStatus = "pending" | "completed" | "canceled" | "declined" | "expired";

/** One row of the task index — a compact projection of a ROOT task, not the
 * stored payload. `subtasks` counts the task's subtask rows per status
 * (`{pending: 2, completed: 5}`; empty when there are none). `title` is
 * ciphertext when `encryption` is set. `recipients` carry org member handles
 * on an org task, personal handles on a personal one. */
export type TaskSummary = {
  taskId: string;
  title?: string;
  /** The sender's tag; sealed like the title on an encrypted task. */
  tag?: string;
  status: TaskStatus;
  /** The topic value the task was sent to; absent for member, broadcast and self sends. */
  topic?: string;
  topicId?: string;
  orgTopicId?: string;
  groupId?: string;
  recipients: { publicId: string; name?: string }[];
  subtasks: Record<string, number>;
  /** Input KINDS on the root task, in display order (e.g. "text", "photo") —
   * what sort of answer it expects, without its content. */
  inputs: string[];
  /** Attachment kinds on the root task, in order ("file", "link"). */
  attachments: string[];
  /** The root task's own reply directive; the chain's effective mode may come
   * from a later subtask. */
  reply?: ReplyMode;
  createdAt: string;
  expiresAt?: string;
  /** When the task left pending, for any terminal state; absent while pending. */
  closedAt?: string;
  encryption?: EncryptionMarker;
};

export type TasksPage = { tasks: TaskSummary[]; nextCursor?: string };

/** One answer stored on a task or subtask payload (`uploads`), discriminated
 * by `type` as the backend's Upload ADT is. A sealed field holds ciphertext
 * under the record's own marker when set, else the payload's. */
export type UploadWire =
  | { type: "text"; inputId: string; value: string; encryption?: EncryptionMarker }
  | { type: "slider"; inputId: string; value: string; encryption?: EncryptionMarker }
  | { type: "choice"; inputId: string; selectedIndex: number; selectedValue: string; encryption?: EncryptionMarker }
  | { type: "multiChoice"; inputId: string; selectedIndices: number[]; selectedValues: string[]; encryption?: EncryptionMarker }
  | { type: "actions"; inputId: string; selectedKey: string; encryption?: EncryptionMarker }
  | { type: "location"; inputId: string; location: LocationWire; encryption?: EncryptionMarker }
  | {
      type: "file";
      inputId: string;
      objectKey: string;
      contentType: string;
      checksumSha256: string;
      size: number;
      deleted: boolean;
      filename?: string;
      /** Voice recordings only. */
      durationSeconds?: number;
      encryption?: EncryptionMarker;
    };

/** One message on a task's or subtask's reply thread (`replies`), stored
 * verbatim. `authorPublicUserId` is the replier's `usr_` handle. */
export type ReplyWire = {
  id: string;
  authorPublicUserId: string;
  /** The author's name as known at reply time (member name on an org reply,
   * display name on a personal one); absent when they had none, and on
   * replies stored before names were recorded. */
  authorName?: string;
  body?: { type: "text"; value: string };
  photo?: SubmissionFileWire;
  file?: SubmissionFileWire;
  audio?: SubmissionFileWire & { durationSeconds: number };
  location?: LocationWire;
  encryption?: EncryptionMarker;
  createdAt: string;
};

/** A stored input definition: the send-side `Input` plus the `inp_` id the
 * backend assigned and, on upload inputs, the in-flight marker. */
export type InputWire = Input & { id: string; uploadingSince?: string };

export type AttachmentWire =
  | { type: "file"; id: string; filename: string; contentType: string; size: number; checksumSha256?: string; status: "uploading" | "uploaded" | "failed" }
  | { type: "link"; url: string };

/** Where the push for a payload went, as recorded at send time. */
export type PushDestinationWire =
  | { type: "broadcast" }
  | { type: "member" }
  | { type: "topic"; topicId: string }
  | { type: "orgTopic"; orgTopicId: string }
  | { type: "directToSelf"; userId: string }
  | { type: "subtaskOf"; parentTaskId: string; topicId?: string; selfEncryption?: boolean };

export type SenderRefWire = { publicId: string; name?: string };

export type CancelReasonWire = "canceled" | "answered" | "superseded";
export type DeclineReasonWire = "declined" | "failed";

/** The cancel record a canceled payload carries; `note` is sealed under the
 * record's own marker. `supersededBy` names the replacement task or subtask. */
export type CancellationWire = { reason: CancelReasonWire; note?: string; supersededBy?: string; encryption?: EncryptionMarker; canceledAt: string };

/** One recipient's decline; the payload flips to declined once every
 * recipient has one. */
export type DeclineWire = { by: string; name?: string; reason: DeclineReasonWire; note?: string; encryption?: EncryptionMarker; declinedAt: string };

/** A stored task or subtask payload: the backend's TaskPayload / SubtaskPayload,
 * field for field. Sealed fields (title, content, input values, replies …)
 * hold ciphertext under the payload's marker until decrypted. */
type PayloadWire = {
  title?: string;
  content?: string;
  contentFormat?: ContentFormat;
  attachments: AttachmentWire[];
  inputs: InputWire[];
  uploads: UploadWire[];
  autoCommit: boolean;
  /** Interruption level of the push, 1 (minimal) to 5 (critical). */
  priority: number;
  encryption?: EncryptionMarker;
  status: TaskStatus;
  /** When `status` left pending, for any terminal state; absent while pending. */
  closedAt?: string;
  version: number;
  reply?: ReplyMode;
  replies?: ReplyWire[];
  declines?: DeclineWire[];
};
export type TaskPayloadWire = PayloadWire & {
  taskId: string;
  pushDestination: PushDestinationWire;
  sender?: SenderRefWire;
  cancellation?: CancellationWire;
  expiresAt?: string;
};
export type SubtaskPayloadWire = PayloadWire & {
  subtaskId: string;
  parentTaskId: string;
  cancellation?: CancellationWire;
};

/** The stored payloads, verbatim: a root task and its subtasks, each with the
 * creation time derived from its row. */
export type TaskChain = {
  task: TaskPayloadWire;
  createdAt: string;
  subtasks: { subtask: SubtaskPayloadWire; createdAt: string }[];
  /** Who the root was delivered to: org member handles on an org read,
   * personal handles on a personal one, as on `TaskSummary`. */
  recipients: { publicId: string; name?: string }[];
  /** The independent-mode group (`grptsk_`) this instance was sent as part
   * of, when there is one — the handle for the group roster read. */
  groupId?: string;
};

export type TaskGroupRoster = { groupId: string; tasks: TaskSummary[] };

export type EventsPage = { events: Event[]; nextCursor?: string };

/** A stored file on a submission: the handle to download it by and what is
 * known about the bytes. */
export type SubmissionFileWire = { id: string; contentType?: string; checksumSha256?: string; size?: number; filename?: string };

/** A location as the backend stores it: the coordinates, or one `encrypted`
 * blob of them under the carrier's marker (left as is when no held key opens it). */
export type LocationWire =
  | { latitude: number; longitude: number; accuracy?: number; altitude?: number; heading?: number; speed?: number; timestamp?: number }
  | { encrypted: string };

/** An ad-hoc submission as the feed returns it: the stored record verbatim.
 * `body.value` and `location` are sealed under the entry's marker. */
export type SubmissionWire = {
  id: string;
  body?: { type: string; value?: string };
  photo?: SubmissionFileWire;
  file?: SubmissionFileWire;
  audio?: SubmissionFileWire & { durationSeconds?: number };
  location?: LocationWire;
  createdAt: string;
};

/** One ad-hoc submission with who sent it and the envelope's encryption
 * marker (the submission carries none of its own). */
export type SubmissionEntry = {
  submission: SubmissionWire;
  actor?: Actor;
  encryption?: EncryptionMarker;
};

export type SubmissionsPage = { submissions: SubmissionEntry[]; nextCursor?: string };

export type ListTasksOptions = {
  status?: TaskStatus[];
  /** ISO-8601 instants bounding creation time. */
  since?: string;
  until?: string;
  /** Org topic id (org client) or personal topic id (personal client). */
  topic?: string;
  /** Recipient: `usr_` id or name. */
  member?: string;
  /** Only the instances of this `grptsk_` group. */
  group?: string;
  limit?: number;
  cursor?: string;
};

export type ListEventsOptions = {
  /** Event type wire names, e.g. `TaskCompleted`. */
  type?: string[];
  since?: string;
  until?: string;
  /** Who wrote it: a `usr_` id, an org member's name, or (personal) the name
   * of someone in the caller's own activity. Sent as `member` on the org
   * surface and `person` on the personal one. */
  member?: string;
  limit?: number;
  cursor?: string;
};

/** `member` applies to the org surface only: a personal account's submissions
 * are all its own, so the personal endpoint has no person filter. */
export type ListSubmissionsOptions = Omit<ListEventsOptions, "type">;

/** What a search hit is: the unit of text that matched. */
export type SearchKind = "task" | "subtask" | "answer" | "reply" | "notification" | "notification_answer" | "submission";

/** Where a hit happened, present when the search had an area filter (`near`
 * or `within`): a point of the hit inside the area. `distanceMeters` is
 * measured from the `near` center; absent on a polygon (`within`) search. */
export type SearchHitLocation = {
  latitude: number;
  longitude: number;
  distanceMeters?: number;
};

/** One search hit. `ref` is the wire id the hit lives on: a `tsk_` / `sub_`
 * task for task, answer and reply hits, `grptsk_` for the shared text of an
 * independent-mode group send, `ntf_` for a notification and its answer,
 * `sbm_` for a submission. `snippet` brackets the matching words (absent on a
 * location-only hit). */
export type SearchHit = {
  kind: SearchKind;
  ref: string;
  title?: string;
  /** Who wrote the unit, when known: the `usr_` handle plus the name the
   * scope knows them by (member name on an org search, display name on a
   * personal one). */
  actor?: { publicId: string; name?: string };
  createdAt: string;
  score: number;
  snippet?: string;
  location?: SearchHitLocation;
};

export type SearchResponse = { hits: SearchHit[] };

export type SearchOptions = {
  /** Only hits carrying a point within `radiusMeters` of this WGS84 center.
   * With a query, text hits are kept when their task/submission carries an
   * in-radius point; without one, the points themselves are the hits,
   * nearest first. `radiusMeters` is required alongside `near` (1..1000000). */
  near?: { latitude: number; longitude: number };
  radiusMeters?: number;
  /** Only hits carrying a point inside this polygon (3..50 WGS84 corners).
   * Mutually exclusive with `near`/`radiusMeters`; polygon hits carry no
   * distance and order by recency. */
  within?: { latitude: number; longitude: number }[];
  /** Only these hit kinds. */
  kind?: SearchKind[];
  since?: string;
  until?: string;
  /** Author: a `usr_` id, an org member's name, or (personal) the name of
   * someone appearing in the caller's own activity. */
  member?: string;
  /** Best `limit` hits; default 20, at most 100. */
  limit?: number;
};

/** Wire glue for the read functions: where, with which credential, and how. */
export type ReadTransport = {
  baseUrl: URL;
  authHeaders: Record<string, string>;
  fetch: typeof fetch;
};

function withParams(url: URL, params: Record<string, string | number | string[] | undefined>): URL {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const s = Array.isArray(v) ? v.join(",") : String(v);
    if (s !== "") url.searchParams.set(k, s);
  }
  return url;
}

async function getJson<T>(t: ReadTransport, path: string, params: Record<string, string | number | string[] | undefined> = {}): Promise<T> {
  const url = withParams(new URL(path, t.baseUrl), params);
  const resp = await t.fetch(url.toString(), { method: "GET", headers: { ...t.authHeaders, Accept: "application/json" } });
  if (!resp.ok) throw new HttpError("GET", path, resp.status, await resp.text().catch(() => ""));
  return (await resp.json()) as T;
}

export async function listTasks(t: ReadTransport, org: boolean, opts: ListTasksOptions = {}): Promise<TasksPage> {
  return getJson<TasksPage>(t, org ? "v1/org/tasks" : "v1/tasks", {
    status: opts.status,
    since: opts.since,
    until: opts.until,
    topic: opts.topic,
    ...(opts.member !== undefined ? { [org ? "member" : "person"]: opts.member } : {}),
    group: opts.group,
    limit: opts.limit,
    cursor: opts.cursor,
  });
}

export async function getTaskChain(t: ReadTransport, taskId: string): Promise<TaskChain> {
  return getJson<TaskChain>(t, `v1/tasks/${encodeURIComponent(taskId)}/chain`);
}

/** One task by its own id, payload verbatim (status, inputs, answers, replies). */
export async function getTask(t: ReadTransport, taskId: string): Promise<TaskPayloadWire> {
  return getJson<TaskPayloadWire>(t, `v1/tasks/${encodeURIComponent(taskId)}`);
}

/** One notification by its own id, payload verbatim; `reply` holds the
 * recipient's answer once it exists. */
/** What the recipient entered on a notification's input, by input kind. */
export type NotificationReplyWire =
  | { type: "text"; value: string }
  | { type: "choice"; selectedIndex: number; selectedValue: string }
  | { type: "actions"; selectedKey: string };

export type NotificationPayloadWire = Record<string, unknown> & {
  status: string;
  encryption?: EncryptionMarker;
  input?: { type: string };
  reply?: NotificationReplyWire;
};
export async function getNotification(t: ReadTransport, notificationId: string): Promise<NotificationPayloadWire> {
  return getJson<NotificationPayloadWire>(t, `v1/notifications/${encodeURIComponent(notificationId)}`);
}

/** One subtask by its own id, payload verbatim. Authorisation is the root task's. */
export async function getSubtask(t: ReadTransport, subtaskId: string): Promise<SubtaskPayloadWire> {
  return getJson<SubtaskPayloadWire>(t, `v1/subtasks/${encodeURIComponent(subtaskId)}`);
}

export async function getTaskGroup(t: ReadTransport, groupId: string, opts: { status?: TaskStatus[] } = {}): Promise<TaskGroupRoster> {
  return getJson<TaskGroupRoster>(t, `v1/task-groups/${encodeURIComponent(groupId)}`, { status: opts.status });
}

export async function listEvents(t: ReadTransport, org: boolean, opts: ListEventsOptions = {}): Promise<EventsPage> {
  return getJson<EventsPage>(t, org ? "v1/org/events" : "v1/events", {
    type: opts.type,
    since: opts.since,
    until: opts.until,
    ...(opts.member !== undefined ? { [org ? "member" : "person"]: opts.member } : {}),
    limit: opts.limit,
    cursor: opts.cursor,
  });
}

export async function listSubmissions(t: ReadTransport, org: boolean, opts: ListSubmissionsOptions = {}): Promise<SubmissionsPage> {
  return getJson<SubmissionsPage>(t, org ? "v1/org/submissions" : "v1/submissions", {
    since: opts.since,
    until: opts.until,
    ...(opts.member !== undefined ? { [org ? "member" : "person"]: opts.member } : {}),
    limit: opts.limit,
    cursor: opts.cursor,
  });
}

/** Full-text and location search over what the organization (or the personal
 * sender) holds: tasks, answers, replies, notifications and their answers,
 * submissions. Plaintext records only. Words match literally, plus by stem
 * in each language the organization configured; `opts.near` filters by geographic radius instead of or on top of the query
 * (at least one of the two is required). */
export async function search(t: ReadTransport, org: boolean, query: string | undefined, opts: SearchOptions = {}): Promise<SearchResponse> {
  return getJson<SearchResponse>(t, org ? "v1/org/search" : "v1/search", {
    q: query,
    ...(opts.near !== undefined ? { near: `${opts.near.latitude},${opts.near.longitude}` } : {}),
    radius: opts.radiusMeters,
    ...(opts.within !== undefined ? { within: opts.within.map((p) => `${p.latitude},${p.longitude}`).join(";") } : {}),
    kind: opts.kind,
    since: opts.since,
    until: opts.until,
    ...(opts.member !== undefined ? { [org ? "member" : "person"]: opts.member } : {}),
    limit: opts.limit,
  });
}

/** Walks every page of a list call. `page` is called with the cursor from the
 * previous page (undefined first); iteration ends when a page has none. */
export async function* allPages<P extends { nextCursor?: string }>(page: (cursor: string | undefined) => Promise<P>): AsyncGenerator<P> {
  let cursor: string | undefined;
  do {
    const p = await page(cursor);
    yield p;
    cursor = p.nextCursor;
  } while (cursor !== undefined);
}

export type { _Submission as SubmissionView };
