// The read side of the API: the task index, one task's chain, a group roster,
// event history and submissions. Org clients hit the /v1/org twins, personal
// clients the /v1 ones; the response shapes are identical. Every list is one
// keyset page — `nextCursor` present means more, pass it back as `cursor`.
// Payloads come back exactly as stored (ciphertext where encrypted); see
// `tryDecryptTree` for best-effort decryption with a Keyring.

import { HttpError } from "./errors.js";
import type { Actor, EncryptionMarker, Event } from "./events.js";
import type { ReplyMode } from "./types.js";
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
  status: TaskStatus;
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
  encryption?: EncryptionMarker;
};

export type TasksPage = { tasks: TaskSummary[]; nextCursor?: string };

/** The stored payloads, verbatim: a root task and its subtasks, each with the
 * creation time derived from its row. Field shapes mirror the backend's
 * TaskPayload / SubtaskPayload; typed loosely here because the CLI and agents
 * consume them as JSON. */
export type TaskChain = {
  task: Record<string, unknown> & { taskId: string; status: TaskStatus; encryption?: EncryptionMarker };
  createdAt: string;
  subtasks: { subtask: Record<string, unknown> & { subtaskId: string; status: TaskStatus; encryption?: EncryptionMarker }; createdAt: string }[];
};

export type TaskGroupRoster = { groupId: string; tasks: TaskSummary[] };

export type EventsPage = { events: Event[]; nextCursor?: string };

/** One ad-hoc submission with who sent it and the envelope's encryption
 * marker (the submission carries none of its own). */
export type SubmissionEntry = {
  submission: Record<string, unknown> & { id: string; createdAt: string };
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
  /** Actor: `usr_` id (or member name on an org client). */
  member?: string;
  limit?: number;
  cursor?: string;
};

export type ListSubmissionsOptions = Omit<ListEventsOptions, "type">;

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
    member: opts.member,
    group: opts.group,
    limit: opts.limit,
    cursor: opts.cursor,
  });
}

export async function getTaskChain(t: ReadTransport, taskId: string): Promise<TaskChain> {
  return getJson<TaskChain>(t, `v1/tasks/${encodeURIComponent(taskId)}/chain`);
}

/** One subtask by its own id, payload verbatim. Authorisation is the root task's. */
export type SubtaskPayloadWire = TaskChain["subtasks"][number]["subtask"];
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
    member: opts.member,
    limit: opts.limit,
    cursor: opts.cursor,
  });
}

export async function listSubmissions(t: ReadTransport, org: boolean, opts: ListSubmissionsOptions = {}): Promise<SubmissionsPage> {
  return getJson<SubmissionsPage>(t, org ? "v1/org/submissions" : "v1/submissions", {
    since: opts.since,
    until: opts.until,
    member: opts.member,
    limit: opts.limit,
    cursor: opts.cursor,
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
