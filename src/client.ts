// High-level entry points, mirroring the Python SDK: a personal `Client`
// (user API-Token) and an organization `OrgClient` (org Api-Key). They share
// transport — the event stream, task create/wait, and keyring — via the
// internal `BaseClient`, and differ in auth, stream endpoint, and key material.

import { deriveKey, encrypt, type DerivedKey } from "./crypto.js";
import { MissingApiTokenError } from "./errors.js";
import type { EncryptionMarker, Event } from "./events.js";
import { Keyring, type OrgMasterKey } from "./keyring.js";
import { streamEvents } from "./streams/events-stream.js";
import { EventHub } from "./hub.js";
import type { DownloadTransport } from "./downloads.js";
import { Task, TaskGroup, Subtask, Notification, NotificationGroup, WatchedTask, WatchedTaskGroup, WatchedNotification, WatchedNotificationGroup, buildDecryptor, buildKeyResolver, type SendKey } from "./handles.js";
import { wrapSubmission, type Submission } from "./event-views.js";
import { createTask } from "./tasks.js";
import { createNotification } from "./notifications.js";
import { createSubtask } from "./subtasks.js";
import { prepareFileAttachments, prepareNotificationMedia, uploadFileAttachments, type PreparedFile } from "./attachments.js";
import type {
  CreateTaskRequest,
  CreateTaskJsonResponse,
  CreateTaskGroupJsonResponse,
  CreateTaskResponse,
  CreateNotificationRequest,
  CreateNotificationJsonResponse,
  CreateNotificationGroupJsonResponse,
  CreateNotificationResponse,
  CreatedAttachment,
  NotificationMedia,
  FileAttachmentUploadData,
  SubtaskData,
  CreateSubtaskRequest,
  CreateSubtaskJsonResponse,
  CreateSubtaskResponse,
  SendSubtaskOptions,
  Input,
  SendOptions,
  SendNotificationOptions,
  NotificationAction,
} from "./types.js";
import { isTaskGroupResponse, isSubtaskGroupResponse, isNotificationGroupResponse } from "./types.js";
import { parseBaseUrl } from "./url.js";
import { fetchUserInfo } from "./user.js";
import type { WebSocketFactory } from "./ws.js";

/** Encrypt the user-visible fields of a task input (description, text default,
 * choice options, action key + label, slider scale) under `key`. Used by the
 * high-level send helpers. For an action, both `key` and `label` are encrypted
 * (a plaintext key would leak what the encrypted label hides); only `style` — a
 * fixed render enum — stays plaintext. For a slider, the whole scale config is
 * sealed into one `encrypted` blob and the plain fields dropped. */
async function encryptInput(input: Input, key: Uint8Array): Promise<Input> {
  const out: Input = { ...input };
  if (out.description !== undefined) out.description = await encrypt(key, out.description);
  if (out.type === "text" && out.defaultValue !== undefined) out.defaultValue = await encrypt(key, out.defaultValue);
  if (out.type === "choice") out.options = await Promise.all(out.options.map((o) => encrypt(key, o)));
  if (out.type === "actions") out.actions = await Promise.all(out.actions.map(async (a) => ({ ...a, key: await encrypt(key, a.key), label: await encrypt(key, a.label) })));
  if (out.type === "slider") {
    const meta = JSON.stringify({ min: out.min, max: out.max, step: out.step, unit: out.unit, defaultValue: out.defaultValue });
    out.encrypted = await encrypt(key, meta);
    delete out.min;
    delete out.max;
    delete out.step;
    delete out.unit;
    delete out.defaultValue;
  }
  return out;
}

/** Client-side validation for `actions` and `slider` inputs. Once their content
 * is encrypted the backend can't check it (E2EE), so the sender enforces the
 * invariants: actions need a non-empty key + label per action and unique keys;
 * a slider needs min < max, a positive step within range, and a default in
 * range. Runs before encryption, on both encrypted and plaintext sends. */
function validateInputs(inputs: Input[] | undefined): void {
  for (const input of inputs ?? []) {
    if (input.type === "actions") {
      if (input.actions.length === 0) throw new Error("an actions input needs at least one action");
      const seen = new Set<string>();
      for (const a of input.actions) {
        if (!a.key) throw new Error("each action needs a non-empty key");
        if (!a.label) throw new Error("each action needs a non-empty label");
        if (seen.has(a.key)) throw new Error(`duplicate action key: ${a.key}`);
        seen.add(a.key);
      }
    } else if (input.type === "slider") {
      if (input.min === undefined || input.max === undefined) throw new Error("a slider input needs min and max");
      if (input.min >= input.max) throw new Error("slider min must be less than max");
      if (input.step !== undefined && input.step <= 0) throw new Error("slider step must be positive");
      if (input.defaultValue !== undefined && (input.defaultValue < input.min || input.defaultValue > input.max)) {
        throw new Error("slider defaultValue must be within [min, max]");
      }
    }
  }
}

/** Build a `CreateTaskRequest` from a plaintext `SendOptions`, encrypting every
 * field under `enc.key` and attaching `enc.marker` when a key is present;
 * otherwise the body is sent in the clear. The single place content encryption
 * happens — callers (and the CLI) pass plaintext. */
async function buildBody(
  target: { topic?: string; member?: string; broadcast?: boolean },
  opts: SendOptions,
  enc: { key: Uint8Array; marker: EncryptionMarker } | undefined,
  files: FileAttachmentUploadData[],
): Promise<CreateTaskRequest> {
  validateInputs(opts.inputs);
  const e = enc ? (s: string) => encrypt(enc.key, s) : (s: string) => Promise.resolve(s);
  return {
    ...(target.topic !== undefined ? { topic: target.topic } : {}),
    ...(target.member !== undefined ? { member: target.member } : {}),
    ...(target.broadcast ? { broadcast: true } : {}),
    ...(opts.tag !== undefined ? { tag: await e(opts.tag) } : {}),
    ...(opts.title !== undefined ? { title: await e(opts.title) } : {}),
    ...(opts.content !== undefined ? { content: await e(opts.content) } : {}),
    inputs: opts.inputs ? await Promise.all(opts.inputs.map((i) => (enc ? encryptInput(i, enc.key) : i))) : [],
    links: opts.links ? await Promise.all(opts.links.map((u) => e(u))) : [],
    files,
    autoCommit: opts.autoCommit ?? true,
    ...(opts.reply !== undefined ? { reply: opts.reply } : {}),
    // Plaintext marker — never encrypted, so the recipient can pick the renderer.
    ...(opts.contentFormat !== undefined ? { contentFormat: opts.contentFormat } : {}),
    // Recipient-state model: sent explicitly only when opting into the
    // shared task; absent = the backend's independent-instances default.
    ...(opts.shared ? { shared: true } : {}),
    ...(enc ? { encryption: enc.marker } : {}),
  };
}

/** Build a `CreateTaskRequest` for an org send whose body the caller POSTs itself
 * — e.g. the CLI's bearer endpoint (`/v1/org/tasks/json`), which `OrgClient`'s
 * Api-Key transport can't reach. Encrypts every user-visible field (tag, title,
 * content, links, and each input's description/default/options) under the org
 * master key and stamps the `{type:"org",v}` marker — the exact field set
 * `OrgClient.sendTask` produces, so callers don't reimplement it. For file
 * attachments, pass the metadata from `prepareFileAttachments` (encrypt with
 * `masterKey.key` to match the body fields), then drive the minted attachments
 * through `uploadFileAttachments` against the org bearer lifecycle endpoints
 * (`basePath: "v1/org/attachments"`). Pass `masterKey` undefined to send in the
 * clear. */
export async function buildOrgTaskRequest(
  target: OrgSendTarget,
  opts: SendOptions,
  masterKey: { key: Uint8Array; version: number } | undefined,
  /** Body metadata of files to attach (from `prepareFileAttachments`). */
  attachments: FileAttachmentUploadData[] = [],
): Promise<CreateTaskRequest> {
  const enc = masterKey
    ? { key: masterKey.key, marker: { type: "org" as const, v: masterKey.version } }
    : undefined;
  return buildBody(target, opts, enc, attachments);
}

/** Notification sibling of `buildOrgTaskRequest`: build a `CreateNotificationRequest`
 * for an org send the caller POSTs itself (the CLI's `/v1/org/notifications/json`
 * bearer endpoint). Encrypts tag, title, content, any choice-option labels, and a
 * link media URL under the org master key and stamps the marker — the same field set
 * `OrgClient.sendNotification` produces. File media isn't supported on this path. */
export async function buildOrgNotificationRequest(
  target: OrgSendTarget,
  opts: SendNotificationOptions,
  media: NotificationMedia | undefined,
  masterKey: { key: Uint8Array; version: number } | undefined,
): Promise<CreateNotificationRequest> {
  const enc = masterKey
    ? { key: masterKey.key, marker: { type: "org" as const, v: masterKey.version } }
    : undefined;
  // buildNotificationBody encrypts the body fields but takes media pre-built, so
  // encrypt a link URL here to match (file media carries no URL).
  const builtMedia: NotificationMedia | undefined =
    enc && media && media.type === "link"
      ? { ...media, url: await encrypt(enc.key, media.url) }
      : media;
  return buildNotificationBody(target, opts, enc, builtMedia);
}

/** Subtask sibling of `buildOrgTaskRequest`: build a `CreateSubtaskRequest` for an
 * org append the caller POSTs itself (the CLI's `/v1/org/subtasks/json` bearer
 * endpoint). Encrypts the subtask body under the org master key and stamps the
 * `{type:"org",v}` marker — the parent must be a task in the same org. Pass
 * `masterKey` undefined to send in the clear. For file attachments, pass the
 * metadata from `prepareFileAttachments` and drive the minted attachments through
 * `uploadFileAttachments` (`basePath: "v1/org/attachments"`), as with
 * `buildOrgTaskRequest`. */
export async function buildOrgSubtaskRequest(
  appendToken: string,
  opts: SendSubtaskOptions,
  masterKey: { key: Uint8Array; version: number } | undefined,
  /** GROUP-kind tokens only: restrict the append to these member instances. */
  instances?: string[],
  /** Body metadata of files to attach (from `prepareFileAttachments`). */
  attachments: FileAttachmentUploadData[] = [],
): Promise<CreateSubtaskRequest> {
  const enc = masterKey
    ? { key: masterKey.key, marker: { type: "org" as const, v: masterKey.version } }
    : undefined;
  const data = await buildSubtaskData(opts, enc, attachments);
  return { appendToken, data, ...(instances !== undefined ? { instances } : {}) };
}

/** Client-side validation for a notification `actions` input: at least one
 * action, each with a non-empty key + label, and unique keys. Mirrors the task
 * `validateInputs` action checks — once the labels are encrypted the backend
 * can't see them (E2EE), so the sender enforces the invariants. */
function validateNotificationActions(actions: NotificationAction[]): void {
  if (actions.length === 0) throw new Error("an actions input needs at least one action");
  const seen = new Set<string>();
  for (const a of actions) {
    if (!a.key) throw new Error("each action needs a non-empty key");
    if (!a.label) throw new Error("each action needs a non-empty label");
    if (seen.has(a.key)) throw new Error(`duplicate action key: ${a.key}`);
    seen.add(a.key);
  }
}

/** Build a `CreateNotificationRequest` from a plaintext `SendNotificationOptions`.
 * Like `buildBody`, but for the lighter notification aggregate: a single
 * `textInput`/`choiceInput`/`actionInput` (no description/required), no
 * autoCommit, no reply. */
async function buildNotificationBody(
  target: { topic?: string; member?: string; broadcast?: boolean },
  opts: SendNotificationOptions,
  enc: { key: Uint8Array; marker: EncryptionMarker } | undefined,
  media: NotificationMedia | undefined,
): Promise<CreateNotificationRequest> {
  const e = enc ? (s: string) => encrypt(enc.key, s) : (s: string) => Promise.resolve(s);
  const body: CreateNotificationRequest = {
    ...(target.topic !== undefined ? { topic: target.topic } : {}),
    ...(target.member !== undefined ? { member: target.member } : {}),
    ...(target.broadcast ? { broadcast: true } : {}),
    ...(opts.tag !== undefined ? { tag: await e(opts.tag) } : {}),
    ...(opts.title !== undefined ? { title: await e(opts.title) } : {}),
    ...(opts.content !== undefined ? { content: await e(opts.content) } : {}),
    ...(media ? { media } : {}),
    ...(opts.critical ? { critical: true } : {}),
    ...(opts.contentFormat !== undefined ? { contentFormat: opts.contentFormat } : {}),
    // Recipient-state model: sent explicitly only when opting into the
    // shared notification; absent = the backend's independent-instances default.
    ...(opts.shared ? { shared: true } : {}),
    ...(enc ? { encryption: enc.marker } : {}),
  };
  if (opts.input?.type === "text") {
    body.textInput = {};
  } else if (opts.input?.type === "choice") {
    body.choiceInput = { options: await Promise.all(opts.input.options.map((o) => e(o))) };
  } else if (opts.input?.type === "actions") {
    validateNotificationActions(opts.input.actions);
    // Each `label` is encrypted like a choice option; `key` stays plaintext and
    // `style` is a plain render hint.
    body.actionInput = { actions: await Promise.all(opts.input.actions.map(async (a) => ({ ...a, label: await e(a.label) }))) };
  }
  return body;
}

/** Build the `data` of an append-subtask request from plaintext options,
 * encrypting every field under the parent's key (a subtask's encryption must
 * match the parent's) and attaching its marker. Like `buildBody`, but no target
 * (the subtask inherits the parent's recipients). */
async function buildSubtaskData(
  opts: SendSubtaskOptions,
  enc: { key: Uint8Array; marker: EncryptionMarker } | undefined,
  files: FileAttachmentUploadData[],
): Promise<SubtaskData> {
  validateInputs(opts.inputs);
  const e = enc ? (s: string) => encrypt(enc.key, s) : (s: string) => Promise.resolve(s);
  return {
    ...(opts.title !== undefined ? { title: await e(opts.title) } : {}),
    ...(opts.content !== undefined ? { content: await e(opts.content) } : {}),
    inputs: opts.inputs ? await Promise.all(opts.inputs.map((i) => (enc ? encryptInput(i, enc.key) : i))) : [],
    links: opts.links ? await Promise.all(opts.links.map((u) => e(u))) : [],
    files,
    autoCommit: opts.autoCommit ?? true,
    ...(opts.critical ? { critical: true } : {}),
    ...(opts.reply !== undefined ? { reply: opts.reply } : {}),
    ...(opts.contentFormat !== undefined ? { contentFormat: opts.contentFormat } : {}),
    ...(enc ? { encryption: enc.marker } : {}),
  };
}

/** Split a send-options object into its send target (`topic`/`member`/
 * `broadcast`) and the remaining body options. Lets targeting ride the single
 * options object (idiomatic TS), mirroring the Python keyword-only target. */
function splitTarget<T extends { topic?: string; member?: string; broadcast?: boolean }>(
  opts: T,
): { target: { topic?: string; member?: string; broadcast?: boolean }; rest: Omit<T, "topic" | "member" | "broadcast"> } {
  const { topic, member, broadcast, ...rest } = opts;
  const target = {
    ...(topic !== undefined ? { topic } : {}),
    ...(member !== undefined ? { member } : {}),
    ...(broadcast ? { broadcast: true } : {}),
  };
  return { target, rest };
}

type CommonConfig = {
  baseUrl?: string;
  webSocketFactory?: WebSocketFactory;
  fetch?: typeof fetch;
  /** Called before each event-hub reconnect after a transient drop, with the
   * error that caused it — lets callers surface connectivity trouble that the
   * reconnect loop would otherwise retry silently. */
  onReconnect?: (attempt: number, backoffMs: number, lastError: Error | undefined) => void;
};

/** The personal-client `passwords` config: a single default-password string, or
 * a list whose entries are `[password, topic]` pairs (a topic key) and/or at most
 * one bare default-password string (the account default key — decrypts your
 * submissions; decryption-only, never a send password). */
export type PasswordsConfig = string | Array<[string, string] | string>;

function parsePasswords(passwords: PasswordsConfig | undefined): {
  topicPasswords: Array<[string, string]>;
  defaultPassword: string | undefined;
} {
  if (passwords === undefined) return { topicPasswords: [], defaultPassword: undefined };
  if (typeof passwords === "string") return { topicPasswords: [], defaultPassword: passwords };
  const topicPasswords: Array<[string, string]> = [];
  let defaultPassword: string | undefined;
  for (const item of passwords) {
    if (typeof item === "string") {
      if (defaultPassword !== undefined) throw new Error("only one default password (a bare string) is allowed in `passwords`");
      defaultPassword = item;
    } else if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string")
      topicPasswords.push([item[0], item[1]]);
    else throw new Error(`each \`passwords\` entry must be a [password, topic] pair or a default-password string, got ${JSON.stringify(item)}`);
  }
  return { topicPasswords, defaultPassword };
}

abstract class BaseClient {
  readonly baseUrl: URL;
  readonly webSocketFactory: WebSocketFactory | undefined;
  readonly fetchImpl: typeof fetch;
  private readonly onReconnect: CommonConfig["onReconnect"];
  /** Org master keys, populated by OrgClient; empty for a personal Client. */
  protected orgMasterKeys: OrgMasterKey[] = [];
  /** Personal-mode decrypt/send material (empty for OrgClient). `topicPasswords`
   * are [password, topic] pairs → one topic key each, and the send default for
   * that topic. `defaultPassword` is the user's single account password → the
   * account default key (salt = server password_salt), which decrypts
   * submissions; it never encrypts a send. */
  protected topicPasswords: Array<[string, string]> = [];
  protected defaultPassword: string | undefined = undefined;
  /** Keys derived at send time, folded into the keyring so the raw `events()`
   * feed can decrypt replies to those sends (handle streams use them directly). */
  private readonly extraKeys: DerivedKey[] = [];

  private keyringPromise: Promise<Keyring> | null = null;
  private accountSaltPromise: Promise<string | undefined> | null = null;
  private hubInstance: EventHub | null = null;

  /** The account's server-issued `password_salt` (for deriving account default
   * keys), fetched once. Undefined for an org client / when unavailable. */
  protected accountSalt(): Promise<string | undefined> {
    if (!this.accountSaltPromise) this.accountSaltPromise = this.resolvePasswordSalt();
    return this.accountSaltPromise;
  }

  protected constructor(config: CommonConfig) {
    this.baseUrl = parseBaseUrl(config.baseUrl ?? "https://api.simplepu.sh");
    this.webSocketFactory = config.webSocketFactory;
    this.fetchImpl = config.fetch ?? fetch;
    this.onReconnect = config.onReconnect;
  }

  /** WS endpoint path for this client's event stream. */
  protected abstract wsPath(): string;
  /** Auth headers for the WS handshake. */
  protected abstract wsAuthHeaders(): Record<string, string>;
  /** Auth headers for HTTP notification creation. Every send carries its
   * sender credential (the API-Token for a personal client, the Api-Key for an
   * org client) — the backend rejects a personal notification create without
   * an API-Token. Same credential the task create + download paths use. */
  protected httpAuthHeaders(): Record<string, string> {
    return this.downloadAuthHeaders();
  }
  /** Credential header for file downloads (`API-Token` / `Api-Key`). Downloads
   * always authenticate — every client carries a credential — so they are
   * never subject to the anonymous Wait-Token limits. */
  protected abstract downloadAuthHeaders(): Record<string, string>;

  /** Wire transport for a handle's file downloads. */
  private downloadTransport(): DownloadTransport {
    return {
      baseUrl: this.baseUrl,
      authHeaders: this.downloadAuthHeaders(),
      fetchImpl: this.fetchImpl,
    };
  }
  /** The personal-mode default-key salt, if this client has one. */
  protected resolvePasswordSalt(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  /** Lazily build (and cache) the keyring. Argon2 is expensive, so only call
   * this when decryption is needed. With `includePasswordSalt: true`, a
   * personal client also fetches its `password_salt` (`GET /v1/user`) so the
   * keyring covers submission events under the personal-mode default key.
   */
  keyring(opts: { includePasswordSalt?: boolean } = {}): Promise<Keyring> {
    if (!this.keyringPromise) {
      this.keyringPromise = (async () => {
        // One topic key per [password, topic] pair, plus org master keys.
        const ring = await Keyring.build({ passwords: [], topics: [], orgMasterKeys: this.orgMasterKeys });
        for (const [pw, topic] of this.topicPasswords) ring.add(await deriveKey(pw, topic));
        // The account default key(s) — derived against the server salt — only
        // when asked (submissions need them; the events feed doesn't pay the fetch).
        if (opts.includePasswordSalt && this.defaultPassword !== undefined) {
          const passwordSalt = await this.accountSalt();
          if (passwordSalt !== undefined) ring.add(await deriveKey(this.defaultPassword, passwordSalt));
        }
        // Fold in any keys already derived by sends before the keyring was built.
        for (const dk of this.extraKeys) ring.add(dk);
        return ring;
      })();
    }
    return this.keyringPromise;
  }

  /** Remember a key derived for a send, so the keyring can decrypt that send's
   * replies on the raw feed. Folds into the keyring immediately if it's built. */
  protected rememberKey(dk: DerivedKey): void {
    this.extraKeys.push(dk);
    this.keyringPromise?.then((ring) => ring.add(dk)).catch(() => {});
  }

  events(
    opts: {
      since?: string;
      signal?: AbortSignal;
      /** Called before each reconnect after a transient drop. */
      onReconnect?: (attempt: number, backoffMs: number, lastError: Error | undefined) => void;
    } = {},
  ): AsyncIterableIterator<Event> {
    const onReconnect = opts.onReconnect ?? this.onReconnect;
    return streamEvents({
      baseUrl: this.baseUrl,
      path: this.wsPath(),
      authHeaders: this.wsAuthHeaders(),
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(this.webSocketFactory ? { webSocketFactory: this.webSocketFactory } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(onReconnect ? { onReconnect } : {}),
    });
  }

  /** Observe `Submission`s arriving on this client's stream — self-authored user
   * content (text body + optional photo/file) with no
   * associated task; a task reply without the task. Available on both `Client`
   * and `OrgClient`. Body text decrypts via this client's keyring; `photo`/`file`
   * are downloadable. `since` (ISO 8601) resumes from that point, backfilling
   * submissions that arrived earlier; `idleMs` ends the stream after that many
   * ms of silence; `signal` cancels it. */
  submissions(opts: { signal?: AbortSignal; idleMs?: number; since?: string } = {}): AsyncIterableIterator<Submission> {
    return this.buildSubmissions(opts, this.defaultPassword);
  }

  protected async *buildSubmissions(
    opts: { signal?: AbortSignal; idleMs?: number; since?: string },
    defaultPassword: string | undefined,
  ): AsyncIterableIterator<Submission> {
    const IDLE = Symbol("idle");
    const keyring = await this.keyring(); // topic + org keys
    // Submissions are encrypted under the account default key (account password +
    // the server-issued password_salt), not a topic key — fold it in for this call.
    if (defaultPassword !== undefined) {
      const salt = await this.accountSalt();
      if (salt !== undefined) keyring.add(await deriveKey(defaultPassword, salt));
    }
    const resolveKey = buildKeyResolver(keyring, undefined);
    const dec = buildDecryptor(resolveKey);
    const base = { transport: this.downloadTransport(), resolveKey };
    const it = this.events({
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.since !== undefined ? { since: opts.since } : {}),
    })[Symbol.asyncIterator]();
    try {
      while (true) {
        let res: IteratorResult<Event>;
        if (opts.idleMs !== undefined) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<symbol>((resolve) => {
            timer = setTimeout(() => resolve(IDLE), opts.idleMs);
          });
          const winner = await Promise.race([it.next(), idle]);
          if (timer !== undefined) clearTimeout(timer);
          if (winner === IDLE) return;
          res = winner as IteratorResult<Event>;
        } else {
          res = await it.next();
        }
        if (res.done) return;
        const ev = res.value;
        if (ev.eventType !== "SubmissionCreated") continue;
        yield await wrapSubmission(ev, dec, base);
      }
    } finally {
      await it.return?.();
    }
  }

  /** POST an already-built `CreateTaskRequest` (caller did any encryption). */
  createTask(body: CreateTaskRequest): Promise<CreateTaskResponse> {
    return createTask({
      baseUrl: this.baseUrl,
      body,
      authHeaders: this.createAuthHeaders(),
      fetch: this.fetchImpl,
    });
  }

  /** Encrypt a plaintext body (when `enc` is given), create the task, then
   * upload any file attachments (bytes encrypted under the same key). */
  protected async sendEncrypted(
    target: { topic?: string; member?: string; broadcast?: boolean },
    opts: SendOptions,
    enc: { key: Uint8Array; marker: EncryptionMarker } | undefined,
  ): Promise<CreateTaskResponse> {
    const prepared = await prepareFileAttachments(opts.files, enc?.key);
    const body = await buildBody(target, opts, enc, prepared.map((p) => p.meta));
    const resp = await createTask({
      baseUrl: this.baseUrl,
      body,
      authHeaders: this.createAuthHeaders(),
      fetch: this.fetchImpl,
    });
    await this.uploadAttachments(prepared, resp.attachments);
    return resp;
  }

  /** The credential headers a task/subtask create must carry. The backend
   * requires a sender identity on every task/subtask create — to attribute the
   * task and to own + quota any file attachments: the API-Token for a personal
   * client, the Api-Key for an org client (the same credential the download
   * endpoints use). */
  protected createAuthHeaders(): Record<string, string> {
    return this.downloadAuthHeaders();
  }

  /** Drive the presign->PUT->complete lifecycle for prepared file attachments,
   * authenticated by this client's credential. No-op when there are none. */
  protected async uploadAttachments(prepared: PreparedFile[], created: CreatedAttachment[]): Promise<void> {
    if (prepared.length === 0) return;
    await uploadFileAttachments(
      { baseUrl: this.baseUrl, authHeaders: this.downloadAuthHeaders(), fetch: this.fetchImpl },
      prepared,
      created,
    );
  }

  /** POST an already-built `CreateNotificationRequest` (caller did any encryption). */
  createNotification(body: CreateNotificationRequest): Promise<CreateNotificationResponse> {
    return createNotification({
      baseUrl: this.baseUrl,
      body,
      authHeaders: this.httpAuthHeaders(),
      fetch: this.fetchImpl,
    });
  }

  /** Encrypt a plaintext body (when `enc` is given), create the notification,
   * and upload its media file (if any) — a file media is owned + quota'd by the
   * sender's credential. In group mode the single `mediaAttachment` is minted
   * (and uploaded) ONCE for the whole group — every instance's payload
   * references the same id. */
  protected async sendNotificationEncrypted(
    target: { topic?: string; member?: string; broadcast?: boolean },
    opts: SendNotificationOptions,
    enc: { key: Uint8Array; marker: EncryptionMarker } | undefined,
  ): Promise<CreateNotificationResponse> {
    const { media, prepared } = await prepareNotificationMedia(opts.image, opts.audio, enc?.key);
    const body = await buildNotificationBody(target, opts, enc, media);
    const authHeaders = prepared ? this.createAuthHeaders() : this.httpAuthHeaders();
    const resp = await createNotification({ baseUrl: this.baseUrl, body, authHeaders, fetch: this.fetchImpl });
    // `mediaAttachment` rides on both response shapes; one upload serves the
    // shared notification or every group instance.
    if (prepared && resp.mediaAttachment) {
      await uploadFileAttachments(
        { baseUrl: this.baseUrl, authHeaders: this.downloadAuthHeaders(), fetch: this.fetchImpl },
        [prepared],
        [resp.mediaAttachment],
      );
    }
    return resp;
  }

  /** The shared multiplexed event hub for this client (lazily opened). Every
   * Task/Notification handle streams off this one connection, demuxed by id —
   * the SDK never opens the per-resource `/ws/v1/{tasks,notifications}/{id}`
   * endpoints. */
  protected hub(): EventHub {
    if (!this.hubInstance) {
      this.hubInstance = new EventHub({
        baseUrl: this.baseUrl,
        path: this.wsPath(),
        authHeaders: this.wsAuthHeaders(),
        ...(this.webSocketFactory ? { webSocketFactory: this.webSocketFactory } : {}),
        ...(this.onReconnect ? { onReconnect: this.onReconnect } : {}),
      });
    }
    return this.hubInstance;
  }

  /** Close the shared event hub, ending every active handle stream. */
  close(): void {
    this.hubInstance?.close();
  }

  /** Register a freshly-created task with the hub and wrap it in a `Task` handle.
   * `enc` (if personal) becomes the handle's decrypt key for the shared password,
   * and is reused to encrypt any subtasks appended to this chain. */
  protected taskHandle(resp: CreateTaskJsonResponse, enc: { key: Uint8Array; marker: EncryptionMarker } | undefined): Task {
    const hub = this.hub();
    hub.registerEntity(resp.taskId, resp.createdAt);
    const sendKey = personalSendKey(enc);
    const downloads = this.downloadTransport();
    return new Task({
      taskId: resp.taskId,
      createdAt: resp.createdAt,
      waitToken: resp.waitToken,
      appendToken: resp.appendToken,
      appendSubtask: (opts) => this.appendSubtaskFromHandle(resp.appendToken, resp.taskId, opts, enc, downloads),
      hub,
      getKeyring: () => this.keyring(),
      ...(sendKey ? { sendKey } : {}),
      downloads,
    });
  }

  /** Register every member instance of a freshly-created group with the hub and
   * wrap the response in a `TaskGroup` handle: one ordinary `Task` per
   * recipient (each with its own taskId/tokens and its `recipient` identity,
   * all sharing the send key) plus the group-level append capability. */
  protected taskGroupHandle(resp: CreateTaskGroupJsonResponse, enc: { key: Uint8Array; marker: EncryptionMarker } | undefined): TaskGroup {
    const hub = this.hub();
    const sendKey = personalSendKey(enc);
    const downloads = this.downloadTransport();
    const instances = resp.instances.map((inst) => {
      hub.registerEntity(inst.taskId, resp.createdAt);
      return new Task({
        taskId: inst.taskId,
        createdAt: resp.createdAt,
        waitToken: inst.waitToken,
        appendToken: inst.appendToken,
        // The wire omits `name` for a nameless recipient; the handle promises
        // a plain `string | null`.
        recipient: { publicId: inst.recipient.publicId, name: inst.recipient.name ?? null },
        appendSubtask: (opts) => this.appendSubtaskFromHandle(inst.appendToken, inst.taskId, opts, enc, downloads),
        hub,
        getKeyring: () => this.keyring(),
        ...(sendKey ? { sendKey } : {}),
        downloads,
      });
    });
    return new TaskGroup({
      groupId: resp.groupId,
      createdAt: resp.createdAt,
      waitToken: resp.groupWaitToken,
      appendToken: resp.groupAppendToken,
      instances,
      append: (opts, subset) => this.appendSubtaskGroupFromHandle(resp.groupAppendToken, opts, enc, downloads, subset),
    });
  }

  /** Build a WATCH handle for a task group from ids captured earlier —
   * typically a prior send's members (groupId + the per-recipient taskIds, and
   * their recipient identities if known) — so `.replies()` / `.inputs()` can
   * collect over the group from a FRESH process, off the one shared event
   * stream. Passing `createdAt` lowers the hub's resume cursor to the send
   * time, so the collection backfills everything since the send (nothing
   * missed in the send→collect gap) rather than only live-from-now.
   *
   * The result is the observe-only surface: `WatchedTaskGroup` carries no
   * capability tokens and no `append()` — that lives only on the rich
   * `TaskGroup` a send returns. Decryption still works via this client's
   * keyring / configured passwords. */
  watchTaskGroup(args: {
    groupId: string;
    createdAt?: string;
    members: ReadonlyArray<{ taskId: string; recipient?: { publicId: string; name?: string | null } }>;
  }): WatchedTaskGroup {
    const hub = this.hub();
    const downloads = this.downloadTransport();
    const instances = args.members.map((m) => {
      hub.registerEntity(m.taskId, args.createdAt);
      return new WatchedTask({
        taskId: m.taskId,
        createdAt: args.createdAt ?? "",
        ...(m.recipient ? { recipient: { publicId: m.recipient.publicId, name: m.recipient.name ?? null } } : {}),
        hub,
        getKeyring: () => this.keyring(),
        downloads,
      });
    });
    return new WatchedTaskGroup({
      groupId: args.groupId,
      createdAt: args.createdAt ?? "",
      instances,
    });
  }

  /** Build a WATCH handle for a notification group from ids captured earlier —
   * a prior send's members (groupId + per-recipient notificationIds, and
   * their recipient identities if known) — so `.inputs()` can collect the
   * answers from a FRESH process, off the one shared event stream. Passing
   * `createdAt` lowers the hub's resume cursor to the send time, so the
   * collection backfills answers that arrived in the send→collect gap.
   *
   * The result is the observe-only surface: `WatchedNotificationGroup` carries
   * no wait tokens. Decryption still works via this client's keyring /
   * configured passwords. */
  watchNotificationGroup(args: {
    groupId: string;
    createdAt?: string;
    members: ReadonlyArray<{ notificationId: string; recipient?: { publicId: string; name?: string | null } }>;
  }): WatchedNotificationGroup {
    const hub = this.hub();
    const instances = args.members.map((m) => {
      hub.registerEntity(m.notificationId, args.createdAt);
      return new WatchedNotification({
        notificationId: m.notificationId,
        createdAt: args.createdAt ?? "",
        ...(m.recipient ? { recipient: { publicId: m.recipient.publicId, name: m.recipient.name ?? null } } : {}),
        hub,
        getKeyring: () => this.keyring(),
      });
    });
    return new WatchedNotificationGroup({
      groupId: args.groupId,
      createdAt: args.createdAt ?? "",
      instances,
    });
  }

  /** Append one fresh subtask per targeted member via a GROUP-kind token and
   * return the per-member `Subtask` handles. File attachments are minted ONCE
   * for the whole batch — one upload serves every sibling subtask. */
  private async appendSubtaskGroupFromHandle(
    groupAppendToken: string,
    opts: SendSubtaskOptions,
    enc: { key: Uint8Array; marker: EncryptionMarker } | undefined,
    downloads: DownloadTransport,
    instances?: string[],
  ): Promise<Subtask[]> {
    if (!opts.content && !(opts.inputs && opts.inputs.length > 0)) {
      throw new Error("Either content or inputs must be provided");
    }
    const prepared = await prepareFileAttachments(opts.files, enc?.key);
    const data = await buildSubtaskData(opts, enc, prepared.map((p) => p.meta));
    const resp = await createSubtask({
      baseUrl: this.baseUrl,
      body: { appendToken: groupAppendToken, data, ...(instances !== undefined ? { instances } : {}) },
      authHeaders: this.createAuthHeaders(),
      fetch: this.fetchImpl,
    });
    if (!isSubtaskGroupResponse(resp)) {
      throw new Error("expected a group append response; the token was not group-kind");
    }
    // One upload per batch attachment (shared by all siblings). An empty
    // group appends nothing and mints nothing — resp.attachments is empty.
    await this.uploadAttachments(prepared, resp.attachments);
    const hub = this.hub();
    const sendKey = personalSendKey(enc);
    return resp.subtasks.map((s) => {
      hub.registerEntity(s.taskId, resp.createdAt);
      return new Subtask({
        subtaskId: s.subtaskId,
        parentTaskId: s.taskId,
        createdAt: resp.createdAt,
        hub,
        getKeyring: () => this.keyring(),
        ...(sendKey ? { sendKey } : {}),
        downloads,
      });
    });
  }

  /** Append a subtask to a task's chain (POST /subtasks/json) and return a
   * `Subtask` handle. The subtask body is encrypted under the parent's key. */
  private async appendSubtaskFromHandle(
    appendToken: string,
    parentTaskId: string,
    opts: SendSubtaskOptions,
    enc: { key: Uint8Array; marker: EncryptionMarker } | undefined,
    // The parent's download transport: subtask files download through the
    // parent task's endpoint scope.
    downloads: DownloadTransport,
  ): Promise<Subtask> {
    if (!opts.content && !(opts.inputs && opts.inputs.length > 0)) {
      throw new Error("Either content or inputs must be provided");
    }
    const prepared = await prepareFileAttachments(opts.files, enc?.key);
    const data = await buildSubtaskData(opts, enc, prepared.map((p) => p.meta));
    const resp = await createSubtask({
      baseUrl: this.baseUrl,
      body: { appendToken, data },
      authHeaders: this.createAuthHeaders(),
      fetch: this.fetchImpl,
    });
    if (isSubtaskGroupResponse(resp)) {
      throw new Error("unexpected group append response — this handle carries a task-kind token");
    }
    await this.uploadAttachments(prepared, resp.attachments);
    const hub = this.hub();
    hub.registerEntity(parentTaskId, resp.createdAt);
    const sendKey = personalSendKey(enc);
    return new Subtask({
      subtaskId: resp.subtaskId,
      parentTaskId,
      createdAt: resp.createdAt,
      hub,
      getKeyring: () => this.keyring(),
      ...(sendKey ? { sendKey } : {}),
      downloads,
    });
  }

  protected notificationHandle(resp: CreateNotificationJsonResponse, enc: { key: Uint8Array; marker: EncryptionMarker } | undefined): Notification {
    const hub = this.hub();
    hub.registerEntity(resp.notificationId, resp.createdAt);
    const sendKey = personalSendKey(enc);
    return new Notification({
      notificationId: resp.notificationId,
      createdAt: resp.createdAt,
      waitToken: resp.waitToken,
      hub,
      getKeyring: () => this.keyring(),
      ...(sendKey ? { sendKey } : {}),
    });
  }

  /** Register every member instance of a freshly-created notification group with
   * the hub and wrap the response in a `NotificationGroup` handle: one ordinary
   * `Notification` per recipient (each with its own notificationId/wait token and
   * its `recipient` identity, all sharing the send key), plus the group-level
   * wait token. Mirrors `taskGroupHandle`; notifications have no append. */
  protected notificationGroupHandle(resp: CreateNotificationGroupJsonResponse, enc: { key: Uint8Array; marker: EncryptionMarker } | undefined): NotificationGroup {
    const hub = this.hub();
    const sendKey = personalSendKey(enc);
    const instances = resp.instances.map((inst) => {
      hub.registerEntity(inst.notificationId, resp.createdAt);
      return new Notification({
        notificationId: inst.notificationId,
        createdAt: resp.createdAt,
        waitToken: inst.waitToken,
        // The wire omits `name` for a nameless recipient; the handle promises a
        // plain `string | null`.
        recipient: { publicId: inst.recipient.publicId, name: inst.recipient.name ?? null },
        hub,
        getKeyring: () => this.keyring(),
        ...(sendKey ? { sendKey } : {}),
      });
    });
    return new NotificationGroup({
      groupId: resp.groupId,
      createdAt: resp.createdAt,
      waitToken: resp.groupWaitToken,
      instances,
    });
  }
}

/** The send key the handle uses to decrypt the recipient's replies/inputs, for a
 * password-encrypted (personal) send. Org sends decrypt via the client keyring. */
function personalSendKey(enc: { key: Uint8Array; marker: EncryptionMarker } | undefined): SendKey | undefined {
  if (enc && enc.marker.type === "personal") return { key: enc.key, fingerprint: enc.marker.passwordFingerprint };
  return undefined;
}

export type ClientConfig = CommonConfig & {
  /** User API-Token. Required — a client always carries a credential; it
   * authenticates the event feed, sends, and file downloads. */
  apiToken: string;
  /** Your personal-mode passwords. Either a single default-password string, or a
   * list whose entries are:
   *   - `[password, topic]` pairs — the password for that topic; derives its
   *     topic key (decrypts that topic's content, and is the send default for
   *     it), and
   *   - at most one bare default-password string — your account password;
   *     derives the account default key, which decrypts your submissions. It is
   *     decryption-only — it never encrypts a send.
   * E.g. `"account-pw"` or `[["alerts-pw", "alerts"], "account-pw"]`. A per-send
   * `password` always overrides for that send. */
  passwords?: PasswordsConfig;
};

/** Personal client, authenticated by a user API-Token. Streams the personal
 * event feed at `/ws/v1/events` and derives topic / default keys from
 * `passwords` / `password`. For organization access use `OrgClient`. */
export class Client extends BaseClient {
  readonly apiToken: string;

  constructor(config: ClientConfig) {
    super(config);
    // Required at the type level; the runtime check covers plain-JS callers.
    if (!config.apiToken) throw new MissingApiTokenError();
    this.apiToken = config.apiToken;
    const { topicPasswords, defaultPassword } = parsePasswords(config.passwords);
    this.topicPasswords = topicPasswords;
    this.defaultPassword = defaultPassword;
  }

  requireApiToken(): string {
    if (!this.apiToken) throw new MissingApiTokenError();
    return this.apiToken;
  }

  /** Observe `Submission`s on this user's stream. `password` overrides the
   * account default password used to decrypt them for this call (otherwise the
   * configured default password is used); supply it when you didn't set one at
   * construction. */
  override submissions(
    opts: { signal?: AbortSignal; idleMs?: number; since?: string; password?: string } = {},
  ): AsyncIterableIterator<Submission> {
    return this.buildSubmissions(opts, opts.password ?? this.defaultPassword);
  }

  protected wsPath(): string {
    return "/ws/v1/events";
  }
  protected wsAuthHeaders(): Record<string, string> {
    return { "API-Token": this.requireApiToken() };
  }
  protected downloadAuthHeaders(): Record<string, string> {
    return { "API-Token": this.requireApiToken() };
  }
  protected override async resolvePasswordSalt(): Promise<string | undefined> {
    if (!this.apiToken) return undefined;
    const info = await fetchUserInfo({ baseUrl: this.baseUrl, apiToken: this.apiToken, fetch: this.fetchImpl });
    return info.passwordSalt;
  }

  /** The password to encrypt a send to `topic` with when none is passed per-send:
   * the password paired with `topic`, or undefined. The account default password
   * is decryption-only — it never encrypts a send. */
  private sendPassword(topic: string): string | undefined {
    const pair = this.topicPasswords.find(([, t]) => t === topic);
    return pair ? pair[0] : undefined;
  }

  /** Personal-mode encryption material derived from a topic + password. Falls
   * back to the configured send password for the topic; returns undefined
   * (plaintext send) when neither is set. The topic value is the key-derivation
   * salt. The derived key is remembered so the keyring can decrypt this send's
   * replies. */
  private async personalEnc(
    topic: string,
    password: string | undefined,
  ): Promise<{ key: Uint8Array; marker: EncryptionMarker } | undefined> {
    const pw = password ?? this.sendPassword(topic);
    if (pw === undefined) return undefined;
    const dk = await deriveKey(pw, topic);
    this.rememberKey(dk);
    return { key: dk.symmetricKey, marker: { type: "personal", passwordFingerprint: dk.fingerprint } };
  }

  /** Encryption material for a topicless "note to self": derived from the account
   * default password + the server `password_salt` — the SAME key that decrypts
   * your submissions, so a note-to-self round-trips to your own clients. Returns
   * undefined (plaintext send) when no default password is configured. */
  private async selfSendEnc(): Promise<{ key: Uint8Array; marker: EncryptionMarker } | undefined> {
    if (this.defaultPassword === undefined) return undefined;
    const salt = await this.accountSalt();
    if (salt === undefined) return undefined;
    const dk = await deriveKey(this.defaultPassword, salt);
    this.rememberKey(dk);
    return { key: dk.symmetricKey, marker: { type: "personal", passwordFingerprint: dk.fingerprint } };
  }

  /** Send a task to a topic. DEFAULT (independent mode): every recipient gets
   * their own task instance and a `TaskGroup` handle is returned — use
   * `.instances` (or `.sole` for a single-recipient topic) to reach the
   * per-recipient `Task` handles. `shared: true` opts into the single
   * shared task and returns a plain `Task`. With `password`, the body fields
   * are encrypted under the topic key (salt = topic value) before sending. */
  // Note-to-self (personal Client only): OMIT `topic` to send to your OWN
  // devices. Always a single `Task` (there is one recipient — you), never a
  // group. Encrypted under the account key when a default password is
  // configured, else plaintext. `shared` is moot (one recipient) and `password`
  // isn't accepted (a note-to-self uses the account key).
  async sendTask(opts: SendOptions & { topic?: undefined; password?: undefined; shared?: boolean }): Promise<Task>;
  async sendTask(opts: { topic: string } & SendOptions & { password?: string } & { shared: true }): Promise<Task>;
  async sendTask(opts: { topic: string } & SendOptions & { password?: string } & { shared?: false }): Promise<TaskGroup>;
  // A computed (non-literal) `shared` can go either way — discriminate with
  // `instanceof TaskGroup` (the runtime branches on the actual response shape).
  async sendTask(opts: { topic: string } & SendOptions & { password?: string }): Promise<Task | TaskGroup>;
  async sendTask(opts: { topic?: string } & SendOptions & { password?: string }): Promise<Task | TaskGroup> {
    const { topic, password, ...rest } = opts;
    if (topic === undefined && password !== undefined)
      throw new Error("password requires a topic; a note-to-self is encrypted with the client's default password");
    const enc = topic === undefined ? await this.selfSendEnc() : await this.personalEnc(topic, password);
    const resp = await this.sendEncrypted(topic === undefined ? {} : { topic }, rest, enc);
    if (isTaskGroupResponse(resp)) return this.taskGroupHandle(resp, enc);
    return this.taskHandle(resp, enc);
  }

  /** Send a notification to a topic. DEFAULT (independent mode): every recipient
   * gets their own notification instance and a `NotificationGroup` handle is
   * returned — use `.instances` (or `.sole` for a single-recipient topic) to
   * reach the per-recipient `Notification` handles. `shared: true` opts into the
   * single shared notification and returns a plain `Notification`. A
   * notification is a lighter sibling of a task: a single text/choice/actions
   * input, no reply composer, no subtasks. Encryption works exactly like
   * `sendTask`. */
  // Note-to-self (personal Client only): OMIT `topic` to notify your OWN
  // devices. Always a single `Notification`. Encryption mirrors `sendTask`.
  async sendNotification(opts: SendNotificationOptions & { topic?: undefined; password?: undefined; shared?: boolean }): Promise<Notification>;
  async sendNotification(opts: { topic: string } & SendNotificationOptions & { password?: string } & { shared: true }): Promise<Notification>;
  async sendNotification(opts: { topic: string } & SendNotificationOptions & { password?: string } & { shared?: false }): Promise<NotificationGroup>;
  // A computed (non-literal) `shared` can go either way — discriminate with
  // `instanceof NotificationGroup` (the runtime branches on the response shape).
  async sendNotification(opts: { topic: string } & SendNotificationOptions & { password?: string }): Promise<Notification | NotificationGroup>;
  async sendNotification(
    opts: { topic?: string } & SendNotificationOptions & { password?: string },
  ): Promise<Notification | NotificationGroup> {
    const { topic, password, ...rest } = opts;
    if (topic === undefined && password !== undefined)
      throw new Error("password requires a topic; a note-to-self is encrypted with the client's default password");
    const enc = topic === undefined ? await this.selfSendEnc() : await this.personalEnc(topic, password);
    const resp = await this.sendNotificationEncrypted(topic === undefined ? {} : { topic }, rest, enc);
    if (isNotificationGroupResponse(resp)) return this.notificationGroupHandle(resp, enc);
    return this.notificationHandle(resp, enc);
  }

  /** Append a subtask to an existing task's chain, identified by its
   * `appendToken` (returned at task creation — there is no fetch-by-id). Stateless:
   * no `Task` handle required. With `topic`/`password` the body is encrypted under
   * the topic key (must match the parent's encryption); otherwise sent in the
   * clear. Returns the created subtask's id + minted attachments. */
  async appendSubtask(
    opts: { appendToken: string; topic?: string; password?: string; instances?: string[] } & SendSubtaskOptions,
  ): Promise<CreateSubtaskResponse> {
    const { appendToken, topic, password, instances, ...rest } = opts;
    if (!rest.content && !(rest.inputs && rest.inputs.length > 0)) {
      throw new Error("Either content or inputs must be provided");
    }
    const enc = topic !== undefined ? await this.personalEnc(topic, password) : undefined;
    const prepared = await prepareFileAttachments(rest.files, enc?.key);
    const data = await buildSubtaskData(rest, enc, prepared.map((p) => p.meta));
    const resp = await createSubtask({
      baseUrl: this.baseUrl,
      body: { appendToken, data, ...(instances !== undefined ? { instances } : {}) },
      authHeaders: this.createAuthHeaders(),
      fetch: this.fetchImpl,
    });
    // Both shapes mint attachments now: the single subtask's own, or ONE
    // shared set for a group batch (uploaded once, referenced by every
    // sibling). An empty group mints none — attachments comes back empty.
    await this.uploadAttachments(prepared, resp.attachments);
    return resp;
  }
}

export type OrgClientConfig = CommonConfig & {
  /** Org Api-Key. Exactly one of `apiKey` / `bearerToken` must be given. */
  apiKey?: string;
  /** CLI admin-session bearer token — the interactive alternative to the
   * Api-Key. Grants the same org-wide event stream (receive side); sends and
   * file downloads still require the Api-Key and throw without one. */
  bearerToken?: string;
  /** Org master keys (version -> 32-byte key) for decrypting org content.
   * Obtained out-of-band from the org's encryption vault; the SDK can't derive
   * them. Without them, org ciphertext is left as-is. */
  orgMasterKeys?: OrgMasterKey[];
  /** Convenience for a single current master key, instead of `orgMasterKeys`.
   * Mutually exclusive with it; requires `orgMasterKeyVersion`. */
  orgMasterKey?: Uint8Array;
  orgMasterKeyVersion?: number;
};

/** Organization client, authenticated by the org Api-Key or a CLI admin
 * session (`bearerToken`). Streams org-wide events at
 * `/ws/v1/events/organization` (the org is derived from the credential) and
 * decrypts org content with the supplied `master_key`(s). A session-based
 * client is receive-only: sends and file downloads still need the Api-Key. */
export class OrgClient extends BaseClient {
  readonly apiKey: string | undefined;
  readonly bearerToken: string | undefined;

  constructor(config: OrgClientConfig) {
    super(config);
    if (!config.apiKey && !config.bearerToken) throw new Error("OrgClient requires an apiKey or a bearerToken");
    if (config.apiKey && config.bearerToken) throw new Error("OrgClient takes either apiKey or bearerToken, not both");
    this.apiKey = config.apiKey;
    this.bearerToken = config.bearerToken;
    this.orgMasterKeys = normalizeOrgMasterKeys(config);
  }

  requireApiKey(): string {
    if (!this.apiKey) throw new Error("this OrgClient is session-authenticated (bearerToken); sending and file downloads require an apiKey");
    return this.apiKey;
  }

  /** The credential header for surfaces that accept either auth mode: the
   * events WS and the file-download endpoints (a CLI-session bearer resolves
   * to the same org identity as an Api-Key server-side). */
  private credentialHeaders(): Record<string, string> {
    return this.apiKey !== undefined ? { "Api-Key": this.apiKey } : { Authorization: `Bearer ${this.bearerToken}` };
  }

  protected wsPath(): string {
    return "/ws/v1/events/organization";
  }
  protected wsAuthHeaders(): Record<string, string> {
    return this.credentialHeaders();
  }
  protected override httpAuthHeaders(): Record<string, string> {
    return { "Api-Key": this.requireApiKey() };
  }
  protected downloadAuthHeaders(): Record<string, string> {
    return this.credentialHeaders();
  }

  /** The current (highest-version) master key + its org marker, or undefined
   * when no keys were supplied (sends then go out in the clear). */
  private currentOrgKey(): { key: Uint8Array; marker: EncryptionMarker } | undefined {
    if (this.orgMasterKeys.length === 0) return undefined;
    const cur = this.orgMasterKeys.reduce((a, b) => (b.version > a.version ? b : a));
    return { key: cur.key, marker: { type: "org", v: cur.version } };
  }

  /** Send a task, encrypting under the current master key. Pass exactly one
   * target: `{ topic }`, `{ member }`, or `{ broadcast: true }`. DEFAULT
   * (independent mode) returns a `TaskGroup` — one instance per targeted
   * member, each instance's `recipient` carrying the member handle/name;
   * `shared: true` returns the single shared `Task`. */
  async sendTask(opts: OrgSendTarget & SendOptions & { shared: true }): Promise<Task>;
  async sendTask(opts: OrgSendTarget & SendOptions & { shared?: false }): Promise<TaskGroup>;
  // A computed (non-literal) `shared` can go either way — discriminate with
  // `instanceof TaskGroup` (the runtime branches on the actual response shape).
  async sendTask(opts: OrgSendTarget & SendOptions): Promise<Task | TaskGroup>;
  async sendTask(opts: OrgSendTarget & SendOptions): Promise<Task | TaskGroup> {
    const { target, rest } = splitTarget(opts);
    const enc = this.currentOrgKey();
    const resp = await this.sendEncrypted(target, rest, enc);
    if (isTaskGroupResponse(resp)) return this.taskGroupHandle(resp, enc);
    return this.taskHandle(resp, enc);
  }

  /** Send a notification, encrypting under the current master key. Pass exactly
   * one target: `{ topic }`, `{ member }`, or `{ broadcast: true }`. DEFAULT
   * (independent mode) returns a `NotificationGroup` — one instance per targeted
   * member, each instance's `recipient` carrying the member handle/name;
   * `shared: true` returns the single shared `Notification`. */
  async sendNotification(opts: OrgSendTarget & SendNotificationOptions & { shared: true }): Promise<Notification>;
  async sendNotification(opts: OrgSendTarget & SendNotificationOptions & { shared?: false }): Promise<NotificationGroup>;
  // A computed (non-literal) `shared` can go either way — discriminate with
  // `instanceof NotificationGroup` (the runtime branches on the response shape).
  async sendNotification(opts: OrgSendTarget & SendNotificationOptions): Promise<Notification | NotificationGroup>;
  async sendNotification(opts: OrgSendTarget & SendNotificationOptions): Promise<Notification | NotificationGroup> {
    const { target, rest } = splitTarget(opts);
    const enc = this.currentOrgKey();
    const resp = await this.sendNotificationEncrypted(target, rest, enc);
    if (isNotificationGroupResponse(resp)) return this.notificationGroupHandle(resp, enc);
    return this.notificationHandle(resp, enc);
  }
}

/** The three mutually-exclusive ways an `OrgClient` addresses a send. */
export type OrgSendTarget = { topic: string } | { member: string } | { broadcast: true };

function normalizeOrgMasterKeys(config: OrgClientConfig): OrgMasterKey[] {
  if (config.orgMasterKey !== undefined) {
    if (config.orgMasterKeys !== undefined) {
      throw new Error("pass either orgMasterKeys or orgMasterKey, not both");
    }
    if (config.orgMasterKeyVersion === undefined) {
      throw new Error("orgMasterKey requires orgMasterKeyVersion");
    }
    return [{ version: config.orgMasterKeyVersion, key: config.orgMasterKey }];
  }
  return config.orgMasterKeys ?? [];
}
