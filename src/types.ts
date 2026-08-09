// Wire types for the Simplepush HTTP/WS API.

/** Metadata for a file attachment, sent in the create/append body so the
 * backend mints a `file` row + payload entry before any bytes are uploaded.
 * `checksumSha256` is base64 SHA-256 of the *uploaded* blob (ciphertext when the
 * send is encrypted), `size` its byte length. Mirrors the python
 * `FileAttachmentUploadData`. */
export type FileAttachmentUploadData = {
  filename: string;
  contentType: string;
  size: number;
  checksumSha256: string;
};

/** A file attachment the backend minted for an upload, returned (in request
 * order) from a create/append so the client can drive the presign→PUT→complete
 * lifecycle keyed by `id`. */
export type CreatedAttachment = {
  id: string;
  filename: string;
};

/** A file attachment to send, as the caller provides it: the raw `data` plus a
 * `filename` and optional `contentType` (defaults to `application/octet-stream`).
 * The sender's end of the backend `FileAttachment` — the SDK uploads the bytes
 * (encrypting them when the send is encrypted) and the backend assigns the
 * id/size/checksum/status. The library is environment-agnostic, so the caller
 * supplies the bytes (read from disk / a Blob / wherever). */
export type FileAttachment = {
  filename: string;
  data: Uint8Array;
  contentType?: string;
};

/** Shared-mode create response (`shared: true`): ONE task row all
 * recipients share. */
export type CreateTaskJsonResponse = {
  taskId: string;
  createdAt: string;
  waitToken: string;
  /** Signed capability to append subtasks to this task's chain. */
  appendToken: string;
  /** File attachments minted for this send (request order), `status =
   * uploading`. The client uploads each via the attachment lifecycle endpoints. */
  attachments: CreatedAttachment[];
};

/** Who an independent-mode instance was delivered to: the recipient's public
 * `usr_` handle (org sends carry the member handle/name; personal sends the
 * personal handle + self-chosen name). `name` is null when the recipient has
 * none — the handle layer normalizes the wire's absent-key encoding. */
export type TaskGroupRecipient = { publicId: string; name: string | null };

/** One member instance of an independent-mode send: a fully ordinary task of
 * its own, with instance-scoped wait/append capabilities. */
export type TaskGroupInstanceResponse = {
  taskId: string;
  waitToken: string;
  appendToken: string;
  // Raw wire shape: the backend OMITS `name` when the recipient has none
  // (zio-json drops None fields) — it never sends `name: null`.
  recipient: { publicId: string; name?: string | null };
};

/** Independent-mode create response (the DEFAULT): every recipient got their
 * own first-class task instance, tied together by a `grptsk_` group. The
 * group-level tokens address all instances at once; `instances` is empty when
 * the target resolved to zero recipients. `attachments` behaves as in the
 * shared shape — ONE upload serves every instance. */
export type CreateTaskGroupJsonResponse = {
  groupId: string;
  createdAt: string;
  groupWaitToken: string;
  groupAppendToken: string;
  instances: TaskGroupInstanceResponse[];
  attachments: CreatedAttachment[];
};

/** The two create-response shapes, discriminated by their required fields —
 * `shared: true` requests get the shared shape, the default gets the group. */
export type CreateTaskResponse = CreateTaskJsonResponse | CreateTaskGroupJsonResponse;

export function isTaskGroupResponse(resp: CreateTaskResponse): resp is CreateTaskGroupJsonResponse {
  return "groupId" in resp;
}

export type InputType = "text" | "choice" | "actions" | "slider" | "photo" | "voiceRecording" | "file" | "location";

export type TextInput = {
  type: "text";
  description?: string;
  defaultValue?: string;
  required: boolean;
};

export type ChoiceInput = {
  type: "choice";
  description?: string;
  options: string[];
  required: boolean;
  // Multi-select mode: the recipient may pick more than one option. Defaults to
  // false (single-choice); omit when false. `minSelections`/`maxSelections` are
  // only meaningful (and only valid) when `multi` is true — each >= 1 and
  // <= options.length, with minSelections <= maxSelections.
  multi?: boolean;
  minSelections?: number;
  maxSelections?: number;
};

/** Plaintext render hint for an action button; omit = "default". Mirrors the
 * backend `ActionStyle`. */
export type ActionStyle = "default" | "primary" | "destructive";

/** A single button in an `ActionsInput`. `key` is a stable, sender-defined
 * identifier (e.g. "approve"/"deny"), unique within the set, reported back as
 * the recipient's answer — it stays plaintext. `label` is the button text
 * (encrypted by the client when the send is encrypted, exactly like a choice
 * option). `style` is a plaintext render hint. */
export type Action = {
  key: string;
  label: string;
  style?: ActionStyle;
};

export type ActionsInput = {
  type: "actions";
  description?: string;
  actions: Action[];
  required: boolean;
};

/** A numeric slider on a [min, max] scale (e.g. a pool's pH on 0..14). On an
 * encrypted send the SDK moves the whole scale config {min,max,step,unit,
 * defaultValue} into the `encrypted` blob (and omits the plain fields), so the
 * server learns nothing about the scale; the recipient's chosen value is E2E-
 * encrypted on the answer too. Construct with the plain numbers; `step` omitted =
 * continuous; `unit` is a short display label like "pH"; `defaultValue` sets the
 * initial thumb position. */
export type SliderInput = {
  type: "slider";
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  defaultValue?: number;
  /** AEAD blob of {min,max,step,unit,defaultValue}, set by the SDK when
   * encrypting (the plain scale fields are then omitted). */
  encrypted?: string;
  required: boolean;
};

export type SimpleInput = {
  type: Exclude<InputType, "text" | "choice" | "actions" | "slider">;
  description?: string;
  required: boolean;
};

export type Input = TextInput | ChoiceInput | ActionsInput | SliderInput | SimpleInput;

// Reply composer mode the sender attaches to a task / subtask to opt
// recipients into the in-thread composer. Wire strings match the
// backend's ReplyMode JSON encoding.
export type ReplyMode = "one-shot" | "sticky" | "one-time-per-user";

/** Opt-in body renderer marker. "markdown" tells recipients to render `content`
 * as Markdown; "plain" (the default when omitted) renders it as-is. Sent
 * plaintext alongside the (possibly encrypted) body — see the backend
 * `ContentFormat`. */
export type ContentFormat = "plain" | "markdown";

export type CreateTaskRequest = {
  // Exactly one target: `topic` (personal/org topic), `member` (org member by
  // name), or `broadcast` (whole org). member/broadcast require an OrgClient.
  topic?: string;
  member?: string;
  broadcast?: boolean;
  tag?: string;
  title?: string;
  content?: string;
  inputs: Input[];
  links: string[];
  files: FileAttachmentUploadData[];
  autoCommit: boolean;
  encryption?: { type: "personal"; keyFingerprint: string } | { type: "org"; v: number };
  reply?: ReplyMode;
  contentFormat?: ContentFormat;
  /** Recipient-state model. Absent/false (the default) = INDEPENDENT: every
   * recipient gets their own task instance under a group; `true` = the single
   * single shared task all recipients see together. */
  shared?: boolean;
  /** Optional deadline (ISO-8601, must lie in the future). Plaintext metadata
   * like `contentFormat`. Once it passes with the task still pending, the
   * backend flips the task to `expired` and emits the terminal `TaskExpired`
   * event. */
  expiresAt?: string;
  /** Replay guard: resending the same create with the same key returns the
   * original response instead of creating again. Minted automatically by
   * `createTask` when absent; retries resend it unchanged. */
  idempotencyKey?: string;
};

/** Plaintext body for the high-level task send helpers (`Client.sendTask`,
 * `OrgClient.sendTask`). The client encrypts each field and attaches the marker
 * internally when it holds a key. The send target (`topic` / `member` /
 * `broadcast`) is passed alongside these on the method's options object. */
export type SendOptions = {
  title?: string;
  content?: string;
  tag?: string;
  inputs?: Input[];
  links?: string[];
  /** Local files to upload as file attachments (uploaded after the task is
   * created; encrypted under the send key when the send is encrypted). */
  files?: FileAttachment[];
  autoCommit?: boolean;
  reply?: ReplyMode;
  /** Opt the body into Markdown rendering on the recipient. Plaintext marker
   * (never encrypted); omit / "plain" renders `content` as-is. */
  contentFormat?: ContentFormat;
  /** Recipient-state model: `true` = one single shared task (all
   * recipients share one state; `sendTask` returns a `Task`); absent/false
   * (the default) = independent per-recipient instances (`sendTask` returns a
   * `TaskGroup`). */
  shared?: boolean;
  /** Optional deadline. Must lie in the future; a `Date` is serialized to
   * ISO-8601. Past it, an unanswered task expires (terminal `taskExpired`
   * on its streams; further answers 409 with `task_expired`). */
  expiresAt?: Date | string;
};

// --- Subtask types ---
//
// A subtask is appended to an existing task's chain via `Task.append(...)`. It
// inherits the parent's recipients (no targeting) and, when the parent was sent
// encrypted, the parent's encryption — so there is no `password` here.

export type CreateSubtaskJsonResponse = {
  subtaskId: string;
  createdAt: string;
  /** File attachments minted for this append (request order), `status =
   * uploading`. Empty when the append carried none. */
  attachments: CreatedAttachment[];
};

/** One member's minted subtask in a GROUP append: `taskId` is the member
 * instance it was appended under, `subtaskId` that member's fresh subtask. */
export type GroupSubtaskRef = { taskId: string; subtaskId: string };

/** Response to an append made with a GROUP-kind token: one fresh subtask per
 * targeted member instance, appended atomically. */
export type CreateSubtaskGroupJsonResponse = {
  groupId: string;
  createdAt: string;
  subtasks: GroupSubtaskRef[];
  /** File attachments minted ONCE for the whole batch (`status = uploading`):
   * upload each a single time via the attachment lifecycle endpoints — every
   * sibling subtask's payload references the same ids. */
  attachments: CreatedAttachment[];
};

/** The two append-response shapes; which one arrives is decided by the KIND of
 * the append token used (task-kind → Single, group-kind → Group). */
export type CreateSubtaskResponse = CreateSubtaskJsonResponse | CreateSubtaskGroupJsonResponse;

export function isSubtaskGroupResponse(resp: CreateSubtaskResponse): resp is CreateSubtaskGroupJsonResponse {
  return "groupId" in resp;
}

// --- Sender-side cancellation ---

/** Why the sender canceled: plain withdrawal, another recipient's answer made
 * this instance moot (`answered`), or a replacement exists (`superseded`). */
export type CancelReason = "canceled" | "answered" | "superseded";

/** Options for `Task.cancel()` / `Subtask.cancel()`. `supersededBy` names the
 * replacement (a task id, or a subtask id of the SAME chain for a subtask
 * cancel) and requires `reason: "superseded"`. `note` is free text for the
 * recipients — encrypted under the chain's key when the send was encrypted. */
export type CancelOptions = {
  reason?: CancelReason;
  note?: string;
  supersededBy?: string;
};

/** Wire body of the three cancel POSTs (flat, not `{data: …}`). `encryption`
 * is the NOTE's own marker (a cancel is authored after the send, so an org
 * note may use a newer master_key version than the task's marker names);
 * absent = the note is plaintext. */
export type CancelRequestBody = {
  reason: CancelReason;
  note?: string;
  supersededBy?: string;
  encryption?: { type: "personal"; keyFingerprint: string } | { type: "org"; v: number };
};

/** How a group cancel landed: `canceled` instances were still pending and got
 * the cancel; `skipped` were already terminal (completed or canceled) and were
 * left untouched. canceled + skipped = instance count. */
export type CancelGroupResult = { canceled: number; skipped: number };

// --- Recipient-side decline ---

/** Why a recipient declined: a plain refusal (`declined`), or "tried and
 * couldn't" (`failed`) — operationally identical for the sender (no answer is
 * coming from that recipient), so failure is a decline reason, not a status. */
export type DeclineReason = "declined" | "failed";

/** The `data` payload of an append-subtask request (the parent is identified by
 * the signed `appendToken`, not here). */
export type SubtaskData = {
  title?: string;
  content?: string;
  inputs: Input[];
  links: string[];
  files: FileAttachmentUploadData[];
  autoCommit: boolean;
  encryption?: { type: "personal"; keyFingerprint: string } | { type: "org"; v: number };
  critical?: boolean;
  reply?: ReplyMode;
  contentFormat?: ContentFormat;
  /** Replay guard — see CreateTaskRequest.idempotencyKey. */
  idempotencyKey?: string;
};

export type CreateSubtaskRequest = {
  appendToken: string;
  data: SubtaskData;
  /** GROUP-kind tokens only: restrict the append to these member instances
   * (their taskIds, from the create response). Absent = every member. */
  instances?: string[];
};

/** Plaintext options for `Task.append(...)`. Encryption is inherited from the
 * parent task, so there is no target and no password. */
export type SendSubtaskOptions = {
  title?: string;
  content?: string;
  inputs?: Input[];
  links?: string[];
  /** Local files to upload as file attachments on the subtask (encrypted under
   * the parent's key when the chain is encrypted). */
  files?: FileAttachment[];
  autoCommit?: boolean;
  critical?: boolean;
  reply?: ReplyMode;
  /** Opt the body into Markdown rendering (plaintext marker; omit = plain). */
  contentFormat?: ContentFormat;
};

// --- Notification types ---
//
// A notification is a lighter sibling of a task: it carries at most one input
// (text or choice only — never photo/voice/file, which need an in-app flow) and
// has no reply composer and no subtasks. The send-side input types below are
// deliberately distinct from the task `TextInput`/`ChoiceInput`: a notification
// input has no description (choice options are the button labels; the text field
// has no placeholder) and, with only one possible, nothing to mark required.
// Mirrors the backend domain `NotificationInput`.

export type NotificationTextInput = { type: "text" };
export type NotificationChoiceInput = { type: "choice"; options: string[] };
/** A single action button on a notification's `actions` input. Reuses the task
 * `Action` shape: `key` is a stable, sender-defined identifier (e.g.
 * "approve"/"deny"), reported back on tap; `label` is the button text; `style` a
 * plaintext render hint. Encryption matches a task `Action` exactly: on an
 * encrypted notification BOTH the `key` and the `label` are sealed (the key
 * usually carries the same meaning as the label, so encrypting only the label
 * would leak the intent), and the recipient's reply re-encrypts the tapped key
 * (`NotificationActionReply.selectedKey`), keeping the backend blind. */
export type NotificationAction = { key: string; label: string; style?: ActionStyle };
/** A notification `actions` input (Accept/Deny-style buttons). Mutually exclusive
 * with `text`/`choice` — a notification carries at most one input. */
export type NotificationActionInput = { type: "actions"; actions: NotificationAction[] };
export type NotificationInput = NotificationTextInput | NotificationChoiceInput | NotificationActionInput;

/** The recipient's answer on a `NotificationCompleted` event. Mirrors the
 * backend domain `NotificationReply` (text XOR choice XOR actions). `value` /
 * `selectedValue` / `selectedKey` are decrypted when a matching key was
 * available; otherwise the raw value. */
export type NotificationTextReply = { type: "text"; value: string };
export type NotificationChoiceReply = { type: "choice"; selectedIndex: number; selectedValue: string };
/** The recipient tapped an action button. `selectedKey` is the chosen action's
 * stable key, decrypted under the notification marker (the device encrypts it
 * before posting, exactly like a choice reply's `selectedValue`). */
export type NotificationActionReply = { type: "actions"; selectedKey: string };
export type NotificationReply = NotificationTextReply | NotificationChoiceReply | NotificationActionReply;

/** Shared-mode create response (`shared: true`): ONE notification row all
 * recipients share. */
export type CreateNotificationJsonResponse = {
  notificationId: string;
  createdAt: string;
  waitToken: string;
  // The minted media file attachment, present only when the notification carried
  // a `file` media (a notification has at most one media slot). The client
  // uploads it via the attachment lifecycle keyed by `id`. Absent for link/no media.
  mediaAttachment?: CreatedAttachment;
};

/** Who an independent-mode notification instance was delivered to — the
 * notification analogue of `TaskGroupRecipient`. Org sends carry the member
 * handle/name; personal sends the personal handle + self-chosen name. `name` is
 * null when the recipient has none — the handle layer normalizes the wire's
 * absent-key encoding (the backend never sends `name: null`). */
export type NotificationGroupRecipient = { publicId: string; name: string | null };

/** One member instance of an independent-mode notification send: a fully
 * ordinary notification of its own, with an instance-scoped wait capability.
 * Notifications have no subtasks, so — unlike `TaskGroupInstanceResponse` —
 * there is NO appendToken. */
export type NotificationGroupInstanceResponse = {
  notificationId: string;
  waitToken: string;
  // Raw wire shape: the backend OMITS `name` when the recipient has none
  // (zio-json drops None fields) — it never sends `name: null`.
  recipient: { publicId: string; name?: string | null };
};

/** Independent-mode notification create response (the DEFAULT): every recipient
 * got their own first-class notification instance, tied together by a `grpntf_`
 * group. The group-level wait token addresses all instances at once;
 * `instances` is empty when the target resolved to zero recipients (the group is
 * still valid). `mediaAttachment` behaves as in the shared shape — ONE upload
 * serves every instance. Mirrors `CreateTaskGroupJsonResponse`. */
export type CreateNotificationGroupJsonResponse = {
  groupId: string;
  createdAt: string;
  groupWaitToken: string;
  instances: NotificationGroupInstanceResponse[];
  mediaAttachment?: CreatedAttachment;
};

/** The two notification create-response shapes, discriminated by their required
 * fields — `shared: true` requests get the shared shape, the default gets the
 * group. Mirrors `CreateTaskResponse`. */
export type CreateNotificationResponse = CreateNotificationJsonResponse | CreateNotificationGroupJsonResponse;

export function isNotificationGroupResponse(resp: CreateNotificationResponse): resp is CreateNotificationGroupJsonResponse {
  return "groupId" in resp;
}

/** The single media attachment on a notification (image/audio), mirroring the
 * backend `NotificationMedia`: a `link` (external URL we relay) or a `file`
 * (uploaded via the attachment lifecycle). `contentType` is image/* or audio/*. */
export type NotificationMedia =
  | { type: "link"; url: string; contentType: string }
  | { type: "file"; filename: string; contentType: string; size: number; checksumSha256: string };

export type CreateNotificationRequest = {
  // Exactly one target, like a task: `topic`, `member`, or `broadcast`.
  topic?: string;
  member?: string;
  broadcast?: boolean;
  tag?: string;
  title?: string;
  content?: string;
  // At most one input, sent as `textInput: {}` XOR `choiceInput: { options }` XOR
  // `actionInput: { actions }`. On an encrypted notification each action's `key`
  // AND `label` are sealed (like choice options, and like a task's actions
  // input); only `style` stays plaintext.
  textInput?: Record<string, never>;
  choiceInput?: { options: string[] };
  actionInput?: { actions: NotificationAction[] };
  // At most one media attachment (image/audio), as a link or an uploaded file.
  media?: NotificationMedia;
  encryption?: { type: "personal"; keyFingerprint: string } | { type: "org"; v: number };
  // iOS Critical Alert (bypasses silent mode / Do Not Disturb). Android ignores it.
  critical?: boolean;
  contentFormat?: ContentFormat;
  /** Recipient-state model. Absent/false (the default) = INDEPENDENT: every
   * recipient gets their own notification instance under a group; `true` = the
   * single shared notification the first reply completes for everyone. */
  shared?: boolean;
  /** Replay guard — see CreateTaskRequest.idempotencyKey. */
  idempotencyKey?: string;
};

/** Plaintext body for the high-level notification send helpers
 * (`Client.sendNotification`, `OrgClient.sendNotification`). Note: no
 * `autoCommit` and no `reply` composer — those are task-only. The send target is
 * passed alongside these on the method's options object. */
export type SendNotificationOptions = {
  title?: string;
  content?: string;
  tag?: string;
  input?: NotificationInput;
  // At most one media attachment to render in the push, as a `FileAttachment`
  // (uploaded; encrypted when the notification is) or a URL string (a link).
  // `image` renders on iOS + Android; `audio` plays inline on iOS only. Mutually
  // exclusive — a notification shows at most one media item.
  image?: FileAttachment | string;
  audio?: FileAttachment | string;
  critical?: boolean;
  /** Opt the body into Markdown rendering (plaintext marker; omit = plain). */
  contentFormat?: ContentFormat;
  /** Recipient-state model: `true` = one single shared notification (all
   * recipients share one state; `sendNotification` returns a `Notification`);
   * absent/false (the default) = independent per-recipient instances
   * (`sendNotification` returns a `NotificationGroup`). */
  shared?: boolean;
};
