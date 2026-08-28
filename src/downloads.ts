// File downloads for the binary upload objects (photo/voice/file uploads and
// reply files), mirroring the Python SDK's `_DownloadableFile` mixin. The
// objects yielded by a handle's `inputs()` / `replies()` carry lazy `read()` /
// `save()` / `downloadUrl()` methods bound to the client that produced them:
//
//   - presigns via the backend's task-scoped download-url endpoints, using the
//     client's credential (API-Token / Api-Key) — unlimited, unlike the
//     anonymous Wait-Token curl path;
//   - verifies the upload's SHA-256 checksum (computed over the stored bytes,
//     i.e. the ciphertext on encrypted chains, matching the uploading app);
//   - transparently decrypts encrypted chains' files with the key the handle
//     already holds (send key or client keyring).
//
// Nothing is fetched until a method is called: presigned URLs live ~5 minutes,
// so they are minted per call, never ahead of time.

import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { decryptBytes, sha256Base64 } from "./crypto.js";
import { DownloadError } from "./errors.js";
import type { EncryptionMarker } from "./events.js";

export type PresignedDownload = { url: string; expiresAt?: string };

/** Resolves the symmetric key an encryption marker names, or undefined when the
 * client holds no matching key. Built per stream from the handle's send key +
 * the client keyring (see handles.ts). */
export type KeyResolver = (marker: EncryptionMarker) => Promise<Uint8Array | undefined>;

/** Client-level wire glue for downloads: where to presign and with which
 * credential. Built by the client when a handle is created. */
export type DownloadTransport = {
  baseUrl: URL;
  /** Credential header for the presign call: `API-Token` (personal client) or
   * `Api-Key` (org client). */
  authHeaders: Record<string, string>;
  fetchImpl: typeof fetch;
};

/** The download scope + endpoint kind for a file. `tasks`/<taskId> covers task
 * & subtask files (kind `inputs`/`replies`; subtask files resolve through the
 * parent server-side); `submissions`/<submissionId> covers submission files
 * (kind `files`). */
export type DownloadScope = "tasks" | "submissions";
export type DownloadKind = "inputs" | "replies" | "files";

/** Everything a bound file object needs to download itself: the transport, the
 * download scope + its id, and the stream's key resolver. */
export type DownloadContext = DownloadTransport & {
  scope: DownloadScope;
  scopeId: string;
  resolveKey: KeyResolver;
};

/** The download surface attached to file-ish event objects. */
export type Downloadable = {
  /** Presign and return the short-lived (~5 min) S3 URL — an escape hatch for
   * your own HTTP stack. On an encrypted chain it serves the raw AEAD
   * ciphertext; prefer `read()` / `save()`, which verify and decrypt. */
  downloadUrl(): Promise<PresignedDownload>;
  /** Download and return the file's bytes, checksum-verified and (on encrypted
   * chains) decrypted. The whole file is buffered (uploads cap at 100 MB). */
  read(): Promise<Uint8Array>;
  /** Download to disk and return the written path. `path` may be a file path,
   * an existing directory (the file's `filename` — or id + content-type
   * extension — is used inside it), or omitted for the current directory. */
  save(path?: string): Promise<string>;
};

/** The metadata fields read off the wire object the methods are attached to. */
export type FileMeta = {
  id?: string;
  contentType?: string;
  checksumSha256?: string;
  filename?: string;
};

// Default-filename extensions for the content types the app actually uploads;
// anything else falls back to no extension (Node has no `mimetypes`).
const EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "text/plain": ".txt",
};

async function presign(ctx: DownloadContext, kind: DownloadKind, fileId: string): Promise<PresignedDownload> {
  const path = `v1/${ctx.scope}/${encodeURIComponent(ctx.scopeId)}/${kind}/${encodeURIComponent(fileId)}/download-url`;
  const resp = await ctx.fetchImpl(new URL(path, ctx.baseUrl).toString(), {
    method: "POST",
    headers: ctx.authHeaders,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new DownloadError(`download-url request failed: HTTP ${resp.status}: ${body}`, resp.status);
  }
  const json = (await resp.json().catch(() => ({}))) as { presignedGetUrl?: string; expiresAt?: string };
  if (!json.presignedGetUrl) throw new DownloadError("backend returned no presigned URL");
  return { url: json.presignedGetUrl, ...(json.expiresAt !== undefined ? { expiresAt: json.expiresAt } : {}) };
}

async function fetchBytes(ctx: DownloadContext, url: string): Promise<Uint8Array> {
  const resp = await ctx.fetchImpl(url);
  if (!resp.ok) throw new DownloadError(`file fetch failed: HTTP ${resp.status}`, resp.status);
  return new Uint8Array(await resp.arrayBuffer());
}

async function readVerified(
  ctx: DownloadContext,
  kind: DownloadKind,
  meta: FileMeta,
  marker: EncryptionMarker | undefined,
): Promise<Uint8Array> {
  if (!meta.id) throw new DownloadError("file object carries no id");
  const { url } = await presign(ctx, kind, meta.id);
  const blob = await fetchBytes(ctx, url);
  if (meta.checksumSha256) {
    const digest = await sha256Base64(blob);
    if (digest !== meta.checksumSha256) {
      throw new DownloadError(`checksum mismatch: expected ${meta.checksumSha256}, got ${digest}`);
    }
  }
  if (marker === undefined) return blob;
  // Encrypted chain: the S3 object is the raw `nonce || ct || tag` blob the
  // uploading device produced; resolve the key by the event's marker.
  const key = await ctx.resolveKey(marker);
  if (!key) throw new DownloadError("file is encrypted but the client holds no matching key");
  try {
    return await decryptBytes(key, blob);
  } catch (err) {
    throw new DownloadError(`failed to decrypt file: ${String(err)}`);
  }
}

function defaultName(meta: FileMeta): string {
  return meta.filename ?? `${meta.id ?? "download"}${EXT[meta.contentType ?? ""] ?? ""}`;
}

async function resolveTarget(meta: FileMeta, path: string | undefined): Promise<string> {
  if (path === undefined) return defaultName(meta);
  const isDir = await stat(path).then((s) => s.isDirectory()).catch(() => false);
  return isDir ? join(path, defaultName(meta)) : path;
}

/** Build the download methods for one file object. `ctx` is undefined when the
 * view wasn't produced by a client stream (e.g. wrapping raw events yourself) —
 * the methods then throw `DownloadError`. */
export function makeDownloadable(
  ctx: DownloadContext | undefined,
  kind: DownloadKind,
  meta: FileMeta,
  marker: EncryptionMarker | undefined,
): Downloadable {
  if (ctx === undefined) {
    const unbound = () =>
      Promise.reject(
        new DownloadError(
          "this file is not bound to a client stream; downloads are only available on objects yielded by a handle's inputs()/replies()",
        ),
      );
    return { downloadUrl: unbound, read: unbound, save: unbound };
  }
  return {
    async downloadUrl(): Promise<PresignedDownload> {
      if (!meta.id) throw new DownloadError("file object carries no id");
      return presign(ctx, kind, meta.id);
    },
    async read(): Promise<Uint8Array> {
      return readVerified(ctx, kind, meta, marker);
    },
    async save(path?: string): Promise<string> {
      const data = await readVerified(ctx, kind, meta, marker);
      const target = await resolveTarget(meta, path);
      await writeFile(target, data);
      return target;
    },
  };
}

/** One downloaded file: the bytes (checksum-verified, decrypted when sealed
 * and the key is held) plus what the backend declared about it. */
export type FileDownload = {
  bytes: Uint8Array;
  contentType: string;
  /** Size of the STORED bytes (the ciphertext when sealed). */
  size: number;
  filename?: string;
  durationSeconds?: number;
  /** The marker the file was sealed under; absent for a plaintext file. */
  encryption?: EncryptionMarker;
};

type DownloadUrlResponse = {
  presignedGetUrl?: string;
  expiresAt: string;
  contentType: string;
  size: number;
  checksumSha256: string;
  filename?: string;
  durationSeconds?: number;
  encryption?: EncryptionMarker;
};

/** The download-url route for a file addressed by ids alone: the containing
 * entity (`tsk_`/`sub_`/`sbm_`) and the file (`inp_` input upload, `rfl_`
 * reply file, `sbf_` submission file). */
function downloadUrlPath(scopeId: string, fileId: string): string {
  const entity = scopeId.startsWith("tsk_") ? "tasks" : scopeId.startsWith("sub_") ? "subtasks" : scopeId.startsWith("sbm_") ? "submissions" : undefined;
  const kind = fileId.startsWith("inp_") ? "inputs" : fileId.startsWith("rfl_") ? "replies" : fileId.startsWith("sbf_") ? "files" : undefined;
  if (entity === undefined) throw new DownloadError(`expected a tsk_, sub_ or sbm_ id as the file's scope, got '${scopeId}'`);
  if (kind === undefined) throw new DownloadError(`expected an inp_, rfl_ or sbf_ file id, got '${fileId}'`);
  if ((kind === "files") !== (entity === "submissions")) {
    throw new DownloadError(kind === "files" ? `${fileId} is a submission file; its scope is an sbm_ id` : `${fileId} lives on a task chain; its scope is a tsk_ or sub_ id`);
  }
  return `v1/${entity}/${encodeURIComponent(scopeId)}/${kind}/${encodeURIComponent(fileId)}/download-url`;
}

/** A presigned download by ids alone, with the stored file's own description
 * (filename, content type, size, checksum of the STORED bytes, encryption
 * marker) as the download-url response declares it. The URL lives ~5 minutes
 * and serves the stored bytes: ciphertext when `encryption` is set. */
export type FileDownloadUrl = {
  url: string;
  expiresAt: string;
  contentType: string;
  size: number;
  checksumSha256: string;
  filename?: string;
  /** Audio only. */
  durationSeconds?: number;
  encryption?: EncryptionMarker;
};

export async function fileDownloadUrl(t: DownloadTransport, scopeId: string, fileId: string): Promise<FileDownloadUrl> {
  const path = downloadUrlPath(scopeId, fileId);
  const resp = await t.fetchImpl(new URL(path, t.baseUrl).toString(), { method: "POST", headers: t.authHeaders });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new DownloadError(`download-url request failed: HTTP ${resp.status}: ${body}`, resp.status);
  }
  const meta = (await resp.json().catch(() => ({}))) as DownloadUrlResponse;
  if (!meta.presignedGetUrl) throw new DownloadError("backend returned no presigned URL");
  const { presignedGetUrl, ...rest } = meta;
  return { url: presignedGetUrl, ...rest };
}

/** Downloads a file by ids alone, no handle or prior read: one presign plus
 * one fetch. Verifies the checksum, decrypts when a marker is present and
 * `resolveKey` yields its key. */
export async function downloadFile(t: DownloadTransport, scopeId: string, fileId: string, resolveKey: KeyResolver): Promise<FileDownload> {
  const meta = await fileDownloadUrl(t, scopeId, fileId);
  const stored = await fetchBytes({ ...t, scope: "tasks", scopeId, resolveKey }, meta.url);
  const digest = await sha256Base64(stored);
  if (digest !== meta.checksumSha256) throw new DownloadError(`checksum mismatch: expected ${meta.checksumSha256}, got ${digest}`);
  let bytes = stored;
  if (meta.encryption !== undefined) {
    const key = await resolveKey(meta.encryption);
    if (!key) throw new DownloadError("file is encrypted but the client holds no matching key");
    try {
      bytes = await decryptBytes(key, stored);
    } catch (err) {
      throw new DownloadError(`failed to decrypt file: ${String(err)}`);
    }
  }
  return {
    bytes,
    contentType: meta.contentType,
    size: meta.size,
    ...(meta.filename !== undefined ? { filename: meta.filename } : {}),
    ...(meta.durationSeconds !== undefined ? { durationSeconds: meta.durationSeconds } : {}),
    ...(meta.encryption !== undefined ? { encryption: meta.encryption } : {}),
  };
}
