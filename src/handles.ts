// Task / Notification handles, mirroring the Python SDK's handle classes. A send
// returns one of these; its `inputs()` / `replies()` are async iterators scoped
// to that entity, streaming off the shared multiplexed `EventHub`. The handle
// holds the demux id, the client's keyring (for decryption), and — when the send
// used a password — that derived key, so the recipient's encrypted replies/inputs
// decrypt under the shared password even if it isn't in the client config.

import { decrypt } from "./crypto.js";
import type { DownloadContext, DownloadTransport, KeyResolver } from "./downloads.js";
import type { EncryptionMarker, Event } from "./events.js";
import type { EventHub } from "./hub.js";
import type { Keyring } from "./keyring.js";
import type { NotificationGroupRecipient, SendSubtaskOptions, TaskGroupRecipient } from "./types.js";
import {
  deletedMarker,
  wrapInput,
  wrapNotification,
  wrapReply,
  type Decryptor,
  type NotificationItem,
  type ReplyItem,
  type SubtaskInputItem,
  type TaskInputItem,
} from "./event-views.js";

const TASK_INPUT_TYPES = new Set(["taskInputUploaded", "taskInputCompleted", "taskCompleted"]);
const TASK_INPUT_TERMINAL = new Set(["taskCompleted"]);
const SUBTASK_INPUT_TYPES = new Set(["subtaskInputUploaded", "subtaskInputCompleted", "subtaskCompleted"]);
const SUBTASK_INPUT_TERMINAL = new Set(["subtaskCompleted"]);
const REPLY_TYPES = new Set(["replyAppended"]);
// Combined "everything happening on the task": inputs (incl. the terminal
// `taskCompleted`) AND replies, over ONE subscription — so a deletion surfaces
// exactly once (not once per stream). Nothing is terminal here: replies can keep
// arriving under a sticky composer after the inputs complete, so the stream ends
// only on `taskDeleted` or the caller's idle/signal.
const ACTIVITY_TYPES = new Set([...TASK_INPUT_TYPES, ...REPLY_TYPES]);
const NOTIFICATION_TYPES = new Set(["notificationCompleted"]);

/** Personal send key + its fingerprint, used to decrypt the recipient's replies
 * to a password-encrypted send (the org path decrypts via the client keyring). */
export type SendKey = { key: Uint8Array; fingerprint: string };

/** Resolve a marker to its raw symmetric key: the send key first
 * (fingerprint-gated personal mode), then the client keyring (org markers and
 * configured passwords/topics). Shared by the string decryptor and the binary
 * file-download path. */
export function buildKeyResolver(keyring: Keyring | undefined, sendKey: SendKey | undefined): KeyResolver {
  return async (marker) => {
    if (sendKey && marker.type === "personal" && marker.passwordFingerprint === sendKey.fingerprint) {
      return sendKey.key;
    }
    return keyring?.keyForMarker(marker);
  };
}

/** A decryptor that tries the send key first (fingerprint-gated personal mode),
 * then the client keyring (covers org markers and configured passwords/topics),
 * and otherwise passes the value through unchanged. */
export function buildDecryptor(resolveKey: KeyResolver): Decryptor {
  return async (marker, value) => {
    if (value === undefined || marker === undefined) return value;
    const key = await resolveKey(marker);
    if (!key) return value;
    try {
      return await decrypt(key, value);
    } catch {
      return value; // leave ciphertext in place
    }
  };
}

type StreamConfig<T> = {
  hub: EventHub;
  rootId: string;
  /** Subtask scope, or undefined to scope to the root entity. */
  subtaskId: string | undefined;
  getKeyring: () => Promise<Keyring | undefined>;
  sendKey: SendKey | undefined;
  want: Set<string>;
  terminal: Set<string>;
  /** Data-type that ends the stream entity-wide (`taskDeleted`), or undefined
   * when the entity has no deletion event (notifications). */
  deletedType: string | undefined;
  /** Wire transport for file downloads (undefined for notifications, which
   * carry no files). Combined with the stream's key resolver into the
   * `DownloadContext` bound onto file-ish view objects. */
  downloads: DownloadTransport | undefined;
  // Returns a view that is one of T's members. Typed loosely because `wrapInput`
  // covers task + subtask completions; the scope/want filtering guarantees only
  // the right subtype reaches this stream, so the cast in `streamEntity` is safe.
  wrap: (ev: Event, dec: Decryptor, dl?: DownloadContext) => Promise<unknown>;
};

function dataType(ev: Event): string {
  const data = ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>) : {};
  return typeof data.type === "string" ? data.type : "";
}
function eventSubtaskId(ev: Event): string | undefined {
  const data = ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>) : {};
  return typeof data.subtaskId === "string" ? data.subtaskId : undefined;
}

/** Drive one entity's hub stream: filter by scope + wanted data-types, wrap each
 * matching event into its typed view, and stop after a terminal/deletion marker.
 * Mirrors the Python `_TaskStream`. */
async function* streamEntity<T>(
  cfg: StreamConfig<T>,
  opts: { replay?: boolean; signal?: AbortSignal; idleMs?: number },
): AsyncIterableIterator<T> {
  const keyring = await cfg.getKeyring();
  const resolveKey = buildKeyResolver(keyring, cfg.sendKey);
  const dec = buildDecryptor(resolveKey);
  // The download endpoints are task-scoped, and a stream's root id is the chain
  // root task (notifications pass no transport), so rootId is the right scope.
  const dl: DownloadContext | undefined = cfg.downloads ? { ...cfg.downloads, scope: "tasks", scopeId: cfg.rootId, resolveKey } : undefined;
  const attachOpts: { replay?: boolean; signal?: AbortSignal; idleMs?: number } = {};
  if (opts.replay !== undefined) attachOpts.replay = opts.replay;
  if (opts.signal !== undefined) attachOpts.signal = opts.signal;
  if (opts.idleMs !== undefined) attachOpts.idleMs = opts.idleMs;

  for await (const ev of cfg.hub.attach(cfg.rootId, attachOpts)) {
    const dt = dataType(ev);
    // Deletion is entity-wide terminal — it ignores subtask scope.
    if (cfg.deletedType !== undefined && dt === cfg.deletedType) {
      yield deletedMarker(ev) as unknown as T;
      return;
    }
    const sub = eventSubtaskId(ev);
    const inScope = cfg.subtaskId === undefined ? sub === undefined : sub === cfg.subtaskId;
    if (!inScope) continue;
    if (cfg.want.has(dt)) {
      yield (await cfg.wrap(ev, dec, dl)) as T;
      if (cfg.terminal.has(dt)) return;
    }
  }
}

export type StreamOptions = {
  /** Replay the buffered backlog since the send before going live. */
  replay?: boolean;
  /** Stop after this many milliseconds of silence. */
  idleMs?: number;
  /** Cancel the stream; the iterator then throws AbortError. */
  signal?: AbortSignal;
};

type HandleDeps = {
  hub: EventHub;
  getKeyring: () => Promise<Keyring | undefined>;
  sendKey?: SendKey;
  /** Wire transport for file downloads, built by the client with its
   * credential (API-Token / Api-Key). Undefined on notification handles. */
  downloads?: DownloadTransport;
};

/** Appends a subtask to a task's chain — injected by the client, which holds the
 * transport and the parent's encryption (a subtask's encryption must match). */
type AppendSubtaskFn = (opts: SendSubtaskOptions) => Promise<Subtask>;

/** READ-ONLY handle for observing a task by id: `inputs()` / `replies()` /
 * `activity()` stream off the shared multiplexed event hub. This is the whole
 * capability a collector needs — and the whole capability it gets: no wait or
 * append tokens ride on it. Produced by `Client.watchTaskGroup`; the rich
 * `Task` a send returns extends it with the append capability. */
export class WatchedTask {
  readonly taskId: string;
  readonly createdAt: string;
  /** Who this task was delivered to. Set on group-member instances (the
   * independent-mode default); undefined on shared-mode handles. */
  readonly recipient?: TaskGroupRecipient;
  protected readonly deps: HandleDeps;

  constructor(args: { taskId: string; createdAt: string; recipient?: TaskGroupRecipient } & HandleDeps) {
    this.taskId = args.taskId;
    this.createdAt = args.createdAt;
    if (args.recipient !== undefined) this.recipient = args.recipient;
    this.deps = { hub: args.hub, getKeyring: args.getKeyring, ...(args.sendKey ? { sendKey: args.sendKey } : {}), ...(args.downloads ? { downloads: args.downloads } : {}) };
  }

  /** Yields `InputEvent`s, then a terminal `taskCompleted` (full committed input
   * set) or `taskDeleted`. Stops without a marker after `idleMs` of silence. */
  inputs(opts: StreamOptions = {}): AsyncIterableIterator<TaskInputItem> {
    return streamEntity<TaskInputItem>(
      {
        hub: this.deps.hub,
        rootId: this.taskId,
        subtaskId: undefined,
        getKeyring: this.deps.getKeyring,
        sendKey: this.deps.sendKey,
        downloads: this.deps.downloads,
        want: TASK_INPUT_TYPES,
        terminal: TASK_INPUT_TERMINAL,
        deletedType: "taskDeleted",
        wrap: wrapInput,
      },
      opts,
    );
  }

  /** Yields `Reply`s anchored to this task, ending with `taskDeleted` if the task
   * is deleted, or after `idleMs` of silence. */
  replies(opts: StreamOptions = {}): AsyncIterableIterator<ReplyItem> {
    return streamEntity<ReplyItem>(
      {
        hub: this.deps.hub,
        rootId: this.taskId,
        subtaskId: undefined,
        getKeyring: this.deps.getKeyring,
        sendKey: this.deps.sendKey,
        downloads: this.deps.downloads,
        want: REPLY_TYPES,
        terminal: new Set(),
        deletedType: "taskDeleted",
        wrap: wrapReply,
      },
      opts,
    );
  }

  /** Yields EVERYTHING happening on this task — input events, the terminal
   * `taskCompleted`, and `Reply`s — interleaved over one subscription, ending
   * with `taskDeleted` if the task is deleted or after `idleMs` of silence.
   * `taskCompleted` is yielded but does NOT end the stream (replies can follow).
   */
  activity(opts: StreamOptions = {}): AsyncIterableIterator<ActivityItem> {
    return streamEntity<ActivityItem>(
      {
        hub: this.deps.hub,
        rootId: this.taskId,
        subtaskId: undefined,
        getKeyring: this.deps.getKeyring,
        sendKey: this.deps.sendKey,
        downloads: this.deps.downloads,
        want: ACTIVITY_TYPES,
        terminal: new Set(),
        deletedType: "taskDeleted",
        wrap: (ev, dec, dl) => (dataType(ev) === "replyAppended" ? wrapReply(ev, dec, dl) : wrapInput(ev, dec, dl)),
      },
      opts,
    );
  }
}

/** Handle for a task you sent: everything `WatchedTask` observes, plus the
 * capability tokens and `append()` (adding a subtask to the chain). */
export class Task extends WatchedTask {
  readonly waitToken: string;
  /** Signed capability to append subtasks to this chain. */
  readonly appendToken: string;
  private readonly appendSubtaskFn: AppendSubtaskFn;

  constructor(
    args: { taskId: string; createdAt: string; waitToken: string; appendToken: string; appendSubtask: AppendSubtaskFn; recipient?: TaskGroupRecipient } & HandleDeps,
  ) {
    super(args);
    this.waitToken = args.waitToken;
    this.appendToken = args.appendToken;
    this.appendSubtaskFn = args.appendSubtask;
  }

  /** Append a subtask to this task's chain and return a `Subtask` handle. The
   * subtask inherits the parent's recipients (no targeting) and, when the parent
   * was sent encrypted, its encryption. */
  append(opts: SendSubtaskOptions = {}): Promise<Subtask> {
    return this.appendSubtaskFn(opts);
  }
}

/** Appends one fresh subtask per targeted member via the GROUP-kind token —
 * injected by the client, which holds the transport and the send encryption. */
type AppendSubtaskGroupFn = (opts: SendSubtaskOptions, instances?: string[]) => Promise<Subtask[]>;

/** A reply collected over a whole task group (`replies()`): the `item` — a
 * `Reply`, or a `TaskDeleted` marker when that member's task was deleted —
 * plus the member `instance` it arrived on. `recipient` mirrors
 * `instance.recipient`: who replied. The instance is a `Task` on a group you
 * sent in-process, a `WatchedTask` on a rebuilt (watch-only) group. */
export type GroupReply<I extends WatchedTask = WatchedTask> = { instance: I; item: ReplyItem; recipient?: TaskGroupRecipient };

/** An input event collected over a whole task group (`inputs()`): the `item` —
 * an `InputEvent`, a terminal `taskCompleted` (that member's full committed
 * input set), or a `taskDeleted` marker — plus the member `instance` it
 * arrived on. `recipient` mirrors `instance.recipient`: whose input it is. */
export type GroupInput<I extends WatchedTask = WatchedTask> = { instance: I; item: TaskInputItem; recipient?: TaskGroupRecipient };

/** Item yielded by `Task.activity()` / `TaskGroup.activity()`: the union of an
 * input event, the terminal `taskCompleted`, a `Reply`, or a `taskDeleted`
 * marker (`ReplyItem | TaskInputItem`, whose shared `taskDeleted` collapses). */
export type ActivityItem = ReplyItem | TaskInputItem;

/** A combined activity item collected over a whole task group (`activity()`),
 * tagged with the member `instance` it arrived on. */
export type GroupActivity<I extends WatchedTask = WatchedTask> = { instance: I; item: ActivityItem; recipient?: TaskGroupRecipient };

/** Merge every member instance's per-entity stream (`replies()` / `inputs()`,
 * via `substream`) over the ONE shared `EventHub` (each member id is already a
 * demux key there — no extra WS), tagging each yielded item with its
 * originating instance. Works for `Task` and `Notification` members alike.
 * `idleMs` is GROUP-WIDE silence, enforced here rather than per member so one
 * quiet member never ends the whole group; `replay` and `signal` forward to
 * each member's stream. */
async function* mergeGroupStream<T, I extends { recipient?: TaskGroupRecipient }>(
  instances: readonly I[],
  opts: StreamOptions,
  substream: (inst: I, o: StreamOptions) => AsyncIterableIterator<T>,
): AsyncGenerator<{ instance: I; item: T; recipient?: TaskGroupRecipient }> {
  type Armed = { instance: I; it: AsyncIterableIterator<T>; p: Promise<{ armed: Armed; res: IteratorResult<T> }> };
  // The per-member streams run without their own idle timeout (group-wide idle
  // is enforced below), so they park on the live mailbox indefinitely. We drive
  // their teardown with an internal abort signal — aborting it unblocks that
  // park so each member's `finally` (hub detach) can run. The caller's `signal`
  // is forwarded into it, so a user abort tears the whole group down too.
  const ac = new AbortController();
  const onUserAbort = () => ac.abort((opts.signal as AbortSignal).reason);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onUserAbort, { once: true });
  }
  const subOpts: StreamOptions = { signal: ac.signal };
  if (opts.replay !== undefined) subOpts.replay = opts.replay;
  const arm = (instance: I, it: AsyncIterableIterator<T>): Armed => {
    const a = { instance, it } as Armed;
    a.p = Promise.resolve(it.next()).then((res) => ({ armed: a, res }));
    return a;
  };
  let active: Armed[] = instances.map((inst) => arm(inst, substream(inst, subOpts)));
  const IDLE = Symbol("idle");
  try {
    while (active.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const racers: Promise<{ armed: Armed; res: IteratorResult<T> } | typeof IDLE>[] = active.map((a) => a.p);
      if (opts.idleMs !== undefined) {
        const ms = opts.idleMs;
        racers.push(new Promise<typeof IDLE>((resolve) => { timer = setTimeout(() => resolve(IDLE), ms); }));
      }
      let winner: { armed: Armed; res: IteratorResult<T> } | typeof IDLE;
      try {
        winner = await Promise.race(racers);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (winner === IDLE) return; // group-wide silence
      const { armed, res } = winner;
      if (res.done) {
        active = active.filter((a) => a !== armed); // that member's stream ended (completion/deletion)
      } else {
        yield { instance: armed.instance, item: res.value, ...(armed.instance.recipient !== undefined ? { recipient: armed.instance.recipient } : {}) };
        active = active.map((a) => (a === armed ? arm(armed.instance, armed.it) : a)); // re-arm same iterator
      }
    }
  } finally {
    // Unblock every still-parked member stream so its hub-detach cleanup runs.
    ac.abort();
    if (opts.signal) opts.signal.removeEventListener("abort", onUserAbort);
    await Promise.allSettled(active.map((a) => a.p));
  }
}

/** READ-ONLY handle for observing a task group by ids: the merged member
 * streams (`inputs()` / `replies()` / `activity()`), and nothing else — no
 * tokens, no append. Produced by `Client.watchTaskGroup`; the rich `TaskGroup`
 * a send returns extends it. Generic over the instance flavor so the rich
 * subclass exposes `Task` instances while a watch exposes `WatchedTask`. */
export class WatchedTaskGroup<I extends WatchedTask = WatchedTask> {
  readonly groupId: string;
  readonly createdAt: string;
  /** One handle per recipient, creation-ordered. Empty when the send resolved
   * to zero recipients. */
  readonly instances: readonly I[];

  constructor(args: { groupId: string; createdAt: string; instances: I[] }) {
    this.groupId = args.groupId;
    this.createdAt = args.createdAt;
    this.instances = args.instances;
  }

  /** The one instance of a single-recipient group (the common case for a send
   * to your own topic). Throws when the group has zero or several instances. */
  get sole(): I {
    const first = this.instances[0];
    if (first === undefined || this.instances.length !== 1) {
      throw new Error(`group ${this.groupId} has ${this.instances.length} instances, expected exactly 1`);
    }
    return first;
  }

  /** Collect input events across EVERY member instance of this group, demuxed
   * off the one shared event hub (no extra WS — each member taskId is already a
   * routing key there). Yields a `GroupInput` per event: an `InputEvent`, a
   * terminal `taskCompleted` (that member's full committed input set), or a
   * `taskDeleted`, plus the member `instance` it arrived on, so you know whose
   * input it is.
   *
   * `idleMs` is GROUP-WIDE: iteration stops after that many ms with no event
   * from any member (a single quiet member never ends the group). `replay`
   * replays each member's backlog first; `signal` cancels the whole stream.
   * Otherwise ends when every member's stream has ended — each on its own
   * `taskCompleted` or `taskDeleted`. */
  inputs(opts: StreamOptions = {}): AsyncIterableIterator<GroupInput<I>> {
    return mergeGroupStream(this.instances, opts, (inst, o) => inst.inputs(o));
  }

  /** Collect replies across EVERY member instance of this group, demuxed off the
   * one shared event hub (no extra WS — each member taskId is already a routing
   * key there). Yields a `GroupReply` per reply: the `Reply` (or a `TaskDeleted`
   * marker) plus the member `instance` it arrived on, so you know which
   * recipient replied.
   *
   * `idleMs` is GROUP-WIDE: iteration stops after that many ms with no reply
   * from any member (a single quiet member never ends the group). `replay`
   * replays each member's backlog first; `signal` cancels the whole stream.
   * Otherwise ends when every member's stream has ended (each on its own
   * `taskDeleted`). */
  replies(opts: StreamOptions = {}): AsyncIterableIterator<GroupReply<I>> {
    return mergeGroupStream(this.instances, opts, (inst, o) => inst.replies(o));
  }

  /** Collect EVERYTHING across every member instance — input events, terminal
   * completions, and replies — over the one shared hub, tagged by recipient.
   * Yields a `GroupActivity` per item. `idleMs` is group-wide; `replay` /
   * `signal` forward to each member. Nothing self-terminates (a member ends only
   * on its own `taskDeleted`), so callers wanting "until everyone completed"
   * track the `taskCompleted` items themselves. */
  activity(opts: StreamOptions = {}): AsyncIterableIterator<GroupActivity<I>> {
    return mergeGroupStream(this.instances, opts, (inst, o) => inst.activity(o));
  }
}

/** Handle for an independent-mode send (the default): one first-class `Task`
 * per recipient under a `grptsk_` group. Everything `WatchedTaskGroup`
 * observes, plus the capability tokens and group-level `append()` fanning
 * across every member atomically. */
export class TaskGroup extends WatchedTaskGroup<Task> {
  /** GROUP-kind wait token; carried so callers can persist the group-scoped
   * observe capability. */
  readonly waitToken: string;
  /** GROUP-kind capability: appends one subtask per member instance. */
  readonly appendToken: string;
  private readonly appendFn: AppendSubtaskGroupFn;

  constructor(args: { groupId: string; createdAt: string; waitToken: string; appendToken: string; instances: Task[]; append: AppendSubtaskGroupFn }) {
    super(args);
    this.waitToken = args.waitToken;
    this.appendToken = args.appendToken;
    this.appendFn = args.append;
  }

  /** Append one fresh subtask per member instance, atomically (all-or-nothing).
   * Restrict to specific members with `instances` (their taskIds). File
   * attachments are uploaded ONCE for the whole batch — every sibling subtask
   * references the same attachment. */
  append(opts: SendSubtaskOptions & { instances?: string[] } = {}): Promise<Subtask[]> {
    const { instances, ...rest } = opts;
    return this.appendFn(rest, instances);
  }
}

/** Handle for a subtask appended to a task. `inputs()` / `replies()` are scoped
 * to this subtask within the parent's chain (one level deep — a subtask cannot
 * itself be appended to). Its events route under the parent task's id. */
export class Subtask {
  readonly subtaskId: string;
  readonly parentTaskId: string;
  readonly createdAt: string;
  private readonly deps: HandleDeps;

  constructor(args: { subtaskId: string; parentTaskId: string; createdAt: string } & HandleDeps) {
    this.subtaskId = args.subtaskId;
    this.parentTaskId = args.parentTaskId;
    this.createdAt = args.createdAt;
    this.deps = { hub: args.hub, getKeyring: args.getKeyring, ...(args.sendKey ? { sendKey: args.sendKey } : {}), ...(args.downloads ? { downloads: args.downloads } : {}) };
  }

  /** Yields `InputEvent`s for this subtask, then a terminal `subtaskCompleted`
   * (full committed set) or `taskDeleted` (the chain was deleted). */
  inputs(opts: StreamOptions = {}): AsyncIterableIterator<SubtaskInputItem> {
    return streamEntity<SubtaskInputItem>(
      {
        hub: this.deps.hub,
        rootId: this.parentTaskId,
        subtaskId: this.subtaskId,
        getKeyring: this.deps.getKeyring,
        sendKey: this.deps.sendKey,
        downloads: this.deps.downloads,
        want: SUBTASK_INPUT_TYPES,
        terminal: SUBTASK_INPUT_TERMINAL,
        deletedType: "taskDeleted",
        wrap: wrapInput,
      },
      opts,
    );
  }

  /** Yields `Reply`s anchored to this subtask, ending with `taskDeleted` if the
   * chain is deleted, or after `idleMs` of silence. */
  replies(opts: StreamOptions = {}): AsyncIterableIterator<ReplyItem> {
    return streamEntity<ReplyItem>(
      {
        hub: this.deps.hub,
        rootId: this.parentTaskId,
        subtaskId: this.subtaskId,
        getKeyring: this.deps.getKeyring,
        sendKey: this.deps.sendKey,
        downloads: this.deps.downloads,
        want: REPLY_TYPES,
        terminal: new Set(),
        deletedType: "taskDeleted",
        wrap: wrapReply,
      },
      opts,
    );
  }
}

/** READ-ONLY handle for observing a notification by id: `inputs()` yields the
 * single `notificationCompleted` (the recipient's answer) and ends. Produced
 * by `Client.watchNotificationGroup`; the rich `Notification` a send returns
 * extends it with the wait token. */
export class WatchedNotification {
  readonly notificationId: string;
  readonly createdAt: string;
  /** Who this notification was delivered to. Set on group-member instances (the
   * independent-mode default); undefined on shared-mode handles. */
  readonly recipient?: NotificationGroupRecipient;
  protected readonly deps: HandleDeps;

  constructor(args: { notificationId: string; createdAt: string; recipient?: NotificationGroupRecipient } & HandleDeps) {
    this.notificationId = args.notificationId;
    this.createdAt = args.createdAt;
    if (args.recipient !== undefined) this.recipient = args.recipient;
    this.deps = { hub: args.hub, getKeyring: args.getKeyring, ...(args.sendKey ? { sendKey: args.sendKey } : {}), ...(args.downloads ? { downloads: args.downloads } : {}) };
  }

  inputs(opts: StreamOptions = {}): AsyncIterableIterator<NotificationItem> {
    return streamEntity<NotificationItem>(
      {
        hub: this.deps.hub,
        rootId: this.notificationId,
        subtaskId: undefined,
        getKeyring: this.deps.getKeyring,
        sendKey: this.deps.sendKey,
        downloads: this.deps.downloads,
        want: NOTIFICATION_TYPES,
        terminal: NOTIFICATION_TYPES,
        deletedType: undefined,
        wrap: wrapNotification,
      },
      opts,
    );
  }
}

/** Handle for a notification you sent: everything `WatchedNotification`
 * observes, plus the wait token. */
export class Notification extends WatchedNotification {
  readonly waitToken: string;

  constructor(args: { notificationId: string; createdAt: string; waitToken: string; recipient?: NotificationGroupRecipient } & HandleDeps) {
    super(args);
    this.waitToken = args.waitToken;
  }
}

/** A notification answer collected over a whole group (`inputs()`): the
 * `notificationCompleted` item plus the member `instance` it arrived on.
 * `recipient` mirrors `instance.recipient`: who answered. The instance is a
 * `Notification` on a group you sent in-process, a `WatchedNotification` on a
 * rebuilt (watch-only) group. */
export type GroupNotification<I extends WatchedNotification = WatchedNotification> = { instance: I; item: NotificationItem; recipient?: NotificationGroupRecipient };

/** READ-ONLY handle for observing a notification group by ids: the merged
 * member answer stream, no tokens. Produced by
 * `Client.watchNotificationGroup`; the rich `NotificationGroup` a send returns
 * extends it. */
export class WatchedNotificationGroup<I extends WatchedNotification = WatchedNotification> {
  readonly groupId: string;
  readonly createdAt: string;
  /** One handle per recipient, creation-ordered. Empty when the send resolved
   * to zero recipients. */
  readonly instances: readonly I[];

  constructor(args: { groupId: string; createdAt: string; instances: I[] }) {
    this.groupId = args.groupId;
    this.createdAt = args.createdAt;
    this.instances = args.instances;
  }

  /** The one instance of a single-recipient group (the common case for a send to
   * your own topic). Throws when the group has zero or several instances. */
  get sole(): I {
    const first = this.instances[0];
    if (first === undefined || this.instances.length !== 1) {
      throw new Error(`group ${this.groupId} has ${this.instances.length} instances, expected exactly 1`);
    }
    return first;
  }

  /** Collect the answers across EVERY member instance of this group, demuxed off
   * the one shared event hub. Each member's stream ends on its single
   * `notificationCompleted`, so the group stream ends once every recipient has
   * answered. `idleMs` is GROUP-WIDE; `replay` / `signal` forward to each
   * member. */
  inputs(opts: StreamOptions = {}): AsyncIterableIterator<GroupNotification<I>> {
    return mergeGroupStream(this.instances, opts, (inst, o) => inst.inputs(o));
  }
}

/** Handle for an independent-mode notification send (the default): one
 * first-class `Notification` per recipient under a `grpntf_` group. Everything
 * `WatchedNotificationGroup` observes, plus the group wait token. Unlike
 * `TaskGroup`, a notification group has no `append()` — notifications carry no
 * subtasks. */
export class NotificationGroup extends WatchedNotificationGroup<Notification> {
  /** GROUP-kind wait token (from the response's `groupWaitToken`); carried so
   * callers can persist the group-scoped observe capability. */
  readonly waitToken: string;

  constructor(args: { groupId: string; createdAt: string; waitToken: string; instances: Notification[] }) {
    super(args);
    this.waitToken = args.waitToken;
  }
}
