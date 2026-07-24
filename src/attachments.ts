// File-attachment upload lifecycle. A file attachment is created `uploading`
// by the task/subtask create (which mints the `file` row + payload entry from
// the metadata carried in the body) before any bytes leave the client. The
// client then drives, per attachment: presign a PUT URL -> PUT the blob to S3
// -> mark complete (or, on failure, failed). The endpoints are attachmentId-
// scoped, so one flow serves both tasks and subtasks. Mirrors the python
// library's `_upload_file_attachments`.

import { HttpError } from "./errors.js";
import { encrypt, encryptBytes, sha256Base64 } from "./crypto.js";
import type { CreatedAttachment, FileAttachment, FileAttachmentUploadData, NotificationMedia } from "./types.js";

type AttachmentUploadUrlResponse = { presignedPutUrl: string; objectKey: string; expiresAt: string };

/** A file ready to upload: its create/append-body metadata plus the bytes to
 * PUT (the ciphertext blob when the send is encrypted). */
export type PreparedFile = { meta: FileAttachmentUploadData; blob: Uint8Array };

/** Read + (optionally) encrypt each input file up front, producing the body
 * metadata and the blob to upload. When `key` is given the bytes are
 * AEAD-encrypted (raw nonce||ct||tag), and `size`/`checksumSha256` describe the
 * resulting ciphertext — matching what the receiver verifies then decrypts. */
export async function prepareFileAttachments(
  files: FileAttachment[] | undefined,
  key: Uint8Array | undefined,
): Promise<PreparedFile[]> {
  if (!files || files.length === 0) return [];
  return Promise.all(
    files.map(async (f) => {
      const blob = key ? await encryptBytes(key, f.data) : f.data;
      const checksumSha256 = await sha256Base64(blob);
      return {
        meta: {
          filename: f.filename,
          contentType: f.contentType ?? "application/octet-stream",
          size: blob.length,
          checksumSha256,
        },
        blob,
      };
    }),
  );
}

// Supported notification media content types — mirror the backend allow-list
// (the iOS UNNotificationAttachment UTIs). image/* renders on iOS + Android;
// audio/* plays inline on iOS only.
const NOTIFICATION_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);
const NOTIFICATION_AUDIO_TYPES = new Set([
  "audio/aiff", "audio/x-aiff", "audio/wav", "audio/x-wav", "audio/vnd.wave",
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac", "audio/x-m4a",
]);
// Extension -> MIME, used when the caller didn't supply a content type.
const NOTIFICATION_EXT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  aiff: "audio/aiff", aif: "audio/aiff", wav: "audio/wav",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
};

function notificationMediaContentType(nameOrUrl: string, supplied: string | undefined, kind: "image" | "audio"): string {
  const supported = kind === "image" ? NOTIFICATION_IMAGE_TYPES : NOTIFICATION_AUDIO_TYPES;
  let ct = supplied;
  if (!ct) {
    const clean = nameOrUrl.split("?")[0] ?? nameOrUrl;
    const ext = clean.slice(clean.lastIndexOf(".") + 1).toLowerCase();
    ct = NOTIFICATION_EXT_TYPES[ext];
  }
  if (!ct || !supported.has(ct)) {
    throw new Error(`notification ${kind} media must be a supported ${kind} type; could not derive one from "${nameOrUrl}" (got ${ct ?? "none"})`);
  }
  return ct;
}

/** Build the single notification media (image XOR audio) as a `link` (URL
 * string) or a `file` (a FileAttachment, uploaded after create). Returns the
 * wire media + the prepared blob for the file case. `key` (when the notification
 * is encrypted) encrypts the link URL string / the file bytes. */
export async function prepareNotificationMedia(
  image: FileAttachment | string | undefined,
  audio: FileAttachment | string | undefined,
  key: Uint8Array | undefined,
): Promise<{ media?: NotificationMedia; prepared?: PreparedFile }> {
  if (image !== undefined && audio !== undefined) {
    throw new Error("a notification can carry at most one media attachment (image or audio, not both)");
  }
  const value = image ?? audio;
  if (value === undefined) return {};
  const kind: "image" | "audio" = image !== undefined ? "image" : "audio";

  if (typeof value === "string") {
    const contentType = notificationMediaContentType(value, undefined, kind);
    const url = key ? await encrypt(key, value) : value;
    return { media: { type: "link", url, contentType } };
  }
  const contentType = notificationMediaContentType(value.filename, value.contentType, kind);
  const blob = key ? await encryptBytes(key, value.data) : value.data;
  const checksumSha256 = await sha256Base64(blob);
  const meta: FileAttachmentUploadData = { filename: value.filename, contentType, size: blob.length, checksumSha256 };
  return { media: { type: "file", ...meta }, prepared: { meta, blob } };
}

export type AttachmentLifecycleContext = {
  baseUrl: URL;
  /** The owning credential (`API-Token` for personal, `Api-Key` for org); the
   * backend authorizes the lifecycle calls against the attachment's owner. */
  authHeaders: Record<string, string>;
  fetch?: typeof fetch;
  /** Endpoint base for the lifecycle calls, default `v1/attachments`. The CLI's
   * org bearer session uses `v1/org/attachments` (same resolvers, CLI-bearer
   * auth) with `authHeaders: { Authorization: "Bearer ..." }`. */
  basePath?: string;
};

/** Upload each prepared blob: presign -> PUT -> complete. `created` is the
 * server's minted attachments in request order, aligned with `prepared`. A file
 * whose upload fails is marked failed (best-effort) and skipped — the task /
 * subtask and its other attachments still stand. */
export async function uploadFileAttachments(
  ctx: AttachmentLifecycleContext,
  prepared: PreparedFile[],
  created: CreatedAttachment[],
): Promise<void> {
  const n = Math.min(prepared.length, created.length);
  for (let i = 0; i < n; i++) {
    const id = created[i]!.id;
    const blob = prepared[i]!.blob;
    try {
      const presign = await presignUpload(ctx, id);
      await putBytes(presign.presignedPutUrl, blob, ctx.fetch);
      await postLifecycle(ctx, id, "complete");
    } catch {
      // Best-effort: the stale-pending reaper reclaims a row left `uploading`.
      try {
        await postLifecycle(ctx, id, "failed");
      } catch {
        /* swallow — nothing more we can do for this attachment */
      }
    }
  }
}

async function presignUpload(ctx: AttachmentLifecycleContext, attachmentId: string): Promise<AttachmentUploadUrlResponse> {
  const f = ctx.fetch ?? fetch;
  const path = `${ctx.basePath ?? "v1/attachments"}/${attachmentId}/upload-url`;
  const resp = await f(new URL(path, ctx.baseUrl).toString(), { method: "POST", headers: { ...ctx.authHeaders } });
  if (!resp.ok) throw new HttpError("POST", path, resp.status, await resp.text().catch(() => ""));
  return (await resp.json()) as AttachmentUploadUrlResponse;
}

async function postLifecycle(ctx: AttachmentLifecycleContext, attachmentId: string, action: "complete" | "failed"): Promise<void> {
  const f = ctx.fetch ?? fetch;
  const path = `${ctx.basePath ?? "v1/attachments"}/${attachmentId}/${action}`;
  const resp = await f(new URL(path, ctx.baseUrl).toString(), { method: "POST", headers: { ...ctx.authHeaders } });
  if (!resp.ok) throw new HttpError("POST", path, resp.status, await resp.text().catch(() => ""));
}

// Content-Type isn't part of the presigned signature, so we set octet-stream
// explicitly (the real type travels in the attachment metadata). Matches the
// python `_put_bytes`.
async function putBytes(url: string, blob: Uint8Array, fetchImpl?: typeof fetch): Promise<void> {
  const f = fetchImpl ?? fetch;
  const resp = await f(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob as unknown as BodyInit,
  });
  if (!resp.ok) throw new HttpError("PUT", "<presigned-s3-url>", resp.status, await resp.text().catch(() => ""));
}
