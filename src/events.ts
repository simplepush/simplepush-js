// Event model returned by the WebSocket events endpoint.

export type EventCategory = "task" | "submission" | "notification";

// The on-the-wire encryption marker (mirrors the backend `Encryption` ADT):
// personal-mode content carries a key fingerprint; org-mode content the
// master_key version. Mutually exclusive; absent means plaintext.
export type EncryptionMarker =
  | { type: "personal"; keyFingerprint: string }
  | { type: "org"; v: number };

/** Who performed a receive-side action, assembled server-side. `publicId` is
 * the acting user's public actor id (`usr_…`; member-scoped in org mode);
 * `name` and `deviceName` are snapshots at emit time (stale after renames);
 * `devicePublicId` (`dev_…`) is the acting device's public handle. Absent as a
 * whole on send-side / collective events. */
export type Actor = {
  publicId: string;
  name?: string;
  devicePublicId?: string;
  deviceName?: string;
};

export type Event = {
  streamId?: string;
  /** Internal partition key — same identity as `actor.publicId`, as a bare
   * UUID. Prefer `actor` for attribution. */
  entityId?: string;
  version?: number;
  eventType: string;
  createdAt?: string;
  encryption?: EncryptionMarker;
  data: unknown;
  /** Attribution for receive-side actions; absent on send-side / collective events. */
  actor?: Actor;
};

export function eventCategory(event: Event): EventCategory | undefined {
  switch (event.eventType) {
    case "TaskCompleted":
    case "TaskInputCompleted":
    case "TaskInputUploaded":
    case "TaskDeletedByRecipient":
    case "TaskDeleted":
    case "TaskCanceled":
    case "SubtaskCanceled":
    case "TaskDeclinedByRecipient":
    case "TaskDeclined":
    case "SubtaskDeclinedByRecipient":
    case "SubtaskDeclined":
    case "TaskExpired":
      return "task";
    case "SubmissionCreated":
      return "submission";
    case "NotificationCompleted":
      return "notification";
    default:
      return undefined;
  }
}

// Fine-grained type tags for an event. Returns possibly several: the
// consolidated `SubmissionCreated` event carries an optional text body plus an
// optional photo and file, so a single
// submission can be e.g. both `submission.text` and `submission.photo`. A
// `--type submission.photo` filter should match any submission that contains a
// photo, which is why this returns the full set rather than one tag. Returns
// `["submission"]` for a submission whose payload couldn't be read, and `[]`
// for events with no fine-grained tags.
export function eventSubtypes(event: Event): string[] {
  switch (event.eventType) {
    case "SubmissionCreated": {
      const submission = (
        event.data as {
          submission?: { body?: { type?: string } | null; photo?: unknown; file?: unknown };
        } | null
      )?.submission;
      if (!submission) return ["submission"];
      const tags: string[] = [];
      if (submission.body?.type === "text") tags.push("submission.text");
      if (submission.photo) tags.push("submission.photo");
      if (submission.file) tags.push("submission.file");
      return tags.length > 0 ? tags : ["submission"];
    }
    case "TaskInputCompleted": {
      // `data.type` is the event discriminator ("taskInputCompleted"); the input
      // kind lives on the nested upload, tagged with the InputUploadedEvent
      // wire hints (textUploaded/choiceSelected/…).
      const t = (event.data as { inputUploaded?: { type?: string } | null } | null)?.inputUploaded?.type;
      switch (t) {
        case "textUploaded": return ["task.input.text"];
        case "choiceSelected": return ["task.input.choice"];
        case "multiChoiceSelected": return ["task.input.multi-choice"];
        case "actionSelected": return ["task.input.action"];
        case "sliderUploaded": return ["task.input.slider"];
        case "photoUploaded": return ["task.input.photo"];
        case "voiceRecorded": return ["task.input.voice"];
        case "locationUploaded": return ["task.input.location"];
        case "fileUploaded": return ["task.input.file"];
        default: return ["task.input"];
      }
    }
    case "TaskDeletedByRecipient": return ["task.deleted-by-recipient"];
    case "TaskDeleted": return ["task.deleted"];
    case "TaskCanceled": return ["task.canceled"];
    case "SubtaskCanceled": return ["task.subtask.canceled"];
    case "TaskDeclinedByRecipient": return ["task.declined-by-recipient"];
    case "TaskDeclined": return ["task.declined"];
    case "SubtaskDeclinedByRecipient": return ["task.subtask.declined-by-recipient"];
    case "SubtaskDeclined": return ["task.subtask.declined"];
    case "TaskExpired": return ["task.expired"];
    case "NotificationCompleted": {
      const t = (event.data as { reply?: { type?: string } | null } | null)?.reply?.type;
      return t === "text" ? ["notification.text"] : t === "choice" ? ["notification.choice"] : ["notification.completed"];
    }
    default:
      return [];
  }
}

export function isEncrypted(event: Event): boolean {
  return event.encryption != null;
}

/** The hub demux key for an event: the chain's root task id (folding a subtask
 * event's `parentTaskId` into it) for task/subtask events, or the notification id
 * for notification events. Mirrors the Python `Event.routing_id`. */
export function routingId(event: Event): string | undefined {
  const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
  const taskId = typeof data.taskId === "string" ? data.taskId
    : typeof data.parentTaskId === "string" ? data.parentTaskId
    : undefined;
  if (taskId !== undefined) return taskId;
  return typeof data.notificationId === "string" ? data.notificationId : undefined;
}
