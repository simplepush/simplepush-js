// Unit tests for file downloads (the `Downloadable` surface bound onto
// photo/voice/file uploads and reply files). No network: a fake `fetch`
// records the presign POST + S3 GET and serves canned bytes.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decryptBytes, encrypt, sha256Base64 } from "../src/crypto.js";
import { makeDownloadable, type DownloadContext } from "../src/downloads.js";
import { DownloadError } from "../src/errors.js";
import { wrapInput, wrapReply, type LocationUpload, type PhotoUpload, type TaskCompleted, type Reply } from "../src/event-views.js";
import type { Event } from "../src/events.js";
import { buildDecryptor, buildKeyResolver } from "../src/handles.js";
import { Keyring } from "../src/keyring.js";

const PRESIGNED_URL = "https://s3.example/presigned-object";

type Call = { url: string; method: string; headers: Record<string, string> };

function fakeFetch(blob: Uint8Array, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith("/download-url")) {
      return new Response(JSON.stringify({ presignedGetUrl: PRESIGNED_URL, expiresAt: "2026-06-12T00:00:00Z" }), { status: 200 });
    }
    if (url === PRESIGNED_URL) {
      return new Response(new Uint8Array(blob), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function ctx(blob: Uint8Array, calls: Call[], overrides: Partial<DownloadContext> = {}): DownloadContext {
  return {
    baseUrl: new URL("https://api.example/"),
    authHeaders: { "API-Token": "tok" },
    fetchImpl: fakeFetch(blob, calls),
    scope: "tasks",
    scopeId: "task-1",
    resolveKey: async () => undefined,
    ...overrides,
  };
}

describe("makeDownloadable", () => {
  test("read() presigns, fetches, and verifies the checksum", async () => {
    const blob = new TextEncoder().encode("hello plaintext file");
    const calls: Call[] = [];
    const d = makeDownloadable(ctx(blob, calls), "inputs", { id: "in-1", checksumSha256: await sha256Base64(blob) }, undefined);
    expect(await d.read()).toEqual(blob);
    expect(calls[0]!.url).toBe("https://api.example/v1/tasks/task-1/inputs/in-1/download-url");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["API-Token"]).toBe("tok");
    expect(calls[1]!.url).toBe(PRESIGNED_URL);
  });

  test("read() rejects on checksum mismatch", async () => {
    const calls: Call[] = [];
    const d = makeDownloadable(
      ctx(new TextEncoder().encode("tampered"), calls),
      "inputs",
      { id: "in-1", checksumSha256: await sha256Base64(new TextEncoder().encode("original")) },
      undefined,
    );
    expect(d.read()).rejects.toThrow(DownloadError);
  });

  test("downloadUrl() presigns lazily without fetching the object", async () => {
    const calls: Call[] = [];
    const d = makeDownloadable(ctx(new Uint8Array(), calls), "replies", { id: "rf-1" }, undefined);
    const { url, expiresAt } = await d.downloadUrl();
    expect(url).toBe(PRESIGNED_URL);
    expect(expiresAt).toBe("2026-06-12T00:00:00Z");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example/v1/tasks/task-1/replies/rf-1/download-url");
  });

  test("save() writes to a directory using filename, falling back to id + extension", async () => {
    const blob = new TextEncoder().encode("file body");
    const dir = await mkdtemp(join(tmpdir(), "spush-dl-"));
    const named = makeDownloadable(ctx(blob, []), "replies", { id: "rf-1", filename: "report.pdf" }, undefined);
    const p1 = await named.save(dir);
    expect(p1).toBe(join(dir, "report.pdf"));
    expect(new Uint8Array(await readFile(p1))).toEqual(blob);

    const unnamed = makeDownloadable(ctx(blob, []), "inputs", { id: "in-9", contentType: "image/png" }, undefined);
    const p2 = await unnamed.save(dir);
    expect(p2).toBe(join(dir, "in-9.png"));
  });

  test("encrypted: decrypts the raw blob with the marker-resolved key, after ciphertext checksum", async () => {
    const key = new Uint8Array(32).fill(7);
    const plaintext = "secret file body";
    // crypto.encrypt returns base64(nonce||ct||tag); the S3 object is those raw bytes.
    const blob = Uint8Array.from(atob(await encrypt(key, plaintext)), (c) => c.charCodeAt(0));
    const marker = { type: "org" as const, v: 3 };
    const calls: Call[] = [];
    const d = makeDownloadable(
      ctx(blob, calls, { resolveKey: async (m) => (m.type === "org" && m.v === 3 ? key : undefined) }),
      "inputs",
      { id: "in-3", checksumSha256: await sha256Base64(blob) },
      marker,
    );
    expect(new TextDecoder().decode(await d.read())).toBe(plaintext);
  });

  test("encrypted without a matching key rejects", async () => {
    const key = new Uint8Array(32).fill(7);
    const blob = Uint8Array.from(atob(await encrypt(key, "secret")), (c) => c.charCodeAt(0));
    const d = makeDownloadable(ctx(blob, []), "inputs", { id: "in-3" }, { type: "personal", passwordFingerprint: "nope" });
    expect(d.read()).rejects.toThrow(DownloadError);
  });

  test("unbound objects reject", async () => {
    const d = makeDownloadable(undefined, "inputs", { id: "in-1" }, undefined);
    expect(d.read()).rejects.toThrow(DownloadError);
    expect(d.downloadUrl()).rejects.toThrow(DownloadError);
  });
});

describe("decryptBytes", () => {
  test("round-trips with encrypt's raw blob", async () => {
    const key = new Uint8Array(32).fill(1);
    const blob = Uint8Array.from(atob(await encrypt(key, "round trip")), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(await decryptBytes(key, blob))).toBe("round trip");
  });
});

describe("event wrapping binds download contexts", () => {
  const passthrough = async (_m: unknown, v: string | undefined) => v;

  test("wrapInput binds input uploads to the task scope", async () => {
    const blob = new TextEncoder().encode("x");
    const calls: Call[] = [];
    const ev = {
      eventType: "TaskCompleted",
      data: {
        type: "taskCompleted",
        taskId: "task-1",
        inputsUploaded: [
          { type: "fileUploaded", id: "in-5", contentType: "application/pdf", checksumSha256: await sha256Base64(blob), size: 1, filename: "doc.pdf" },
          { type: "textUploaded", id: "in-6", value: "hi" },
        ],
      },
    } as unknown as Event;
    const item = (await wrapInput(ev, passthrough, ctx(blob, calls))) as TaskCompleted;
    const file = item.uploads.find((u) => u.kind === "file");
    expect(file?.filename).toBe("doc.pdf");
    expect(await file!.read()).toEqual(blob);
    expect(calls[0]!.url).toBe("https://api.example/v1/tasks/task-1/inputs/in-5/download-url");
  });

  test("wrapReply binds photo and file to the replies endpoint", async () => {
    const blob = new TextEncoder().encode("y");
    const calls: Call[] = [];
    const checksum = await sha256Base64(blob);
    const ev = {
      eventType: "ReplyAppended",
      data: {
        type: "replyAppended",
        taskId: "task-1",
        reply: {
          id: "r-1",
          photo: { id: "rf-1", contentType: "image/jpeg", checksumSha256: checksum, size: 1 },
          file: { id: "rf-2", contentType: "application/zip", checksumSha256: checksum, size: 1, filename: "a.zip" },
        },
      },
    } as unknown as Event;
    const reply = (await wrapReply(ev, passthrough, ctx(blob, calls))) as Reply;
    expect(await reply.photo!.read()).toEqual(blob);
    expect(await reply.file!.read()).toEqual(blob);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "https://api.example/v1/tasks/task-1/replies/rf-1/download-url",
      "https://api.example/v1/tasks/task-1/replies/rf-2/download-url",
    ]);
  });

  test("wrapReply binds audio to the replies endpoint with durationSeconds", async () => {
    const blob = new TextEncoder().encode("audio data");
    const calls: Call[] = [];
    const checksum = await sha256Base64(blob);
    const ev = {
      eventType: "ReplyAppended",
      data: {
        type: "replyAppended",
        taskId: "task-1",
        reply: {
          id: "r-2",
          audio: { id: "ra-1", contentType: "audio/ogg", checksumSha256: checksum, size: blob.length, durationSeconds: 8.25, filename: "reply.ogg" },
        },
      },
    } as unknown as Event;
    const reply = (await wrapReply(ev, passthrough, ctx(blob, calls))) as Reply;
    expect(reply.audio).toBeDefined();
    expect(reply.audio!.durationSeconds).toBe(8.25);
    expect(await reply.audio!.read()).toEqual(blob);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "https://api.example/v1/tasks/task-1/replies/ra-1/download-url",
    ]);
  });

  test("wrapping without a context yields objects whose downloads reject", async () => {
    const ev = {
      eventType: "TaskCompleted",
      data: {
        type: "taskCompleted",
        taskId: "task-1",
        inputsUploaded: [{ type: "photoUploaded", id: "in-7", contentType: "image/jpeg", size: 1 }],
      },
    } as unknown as Event;
    const item = (await wrapInput(ev, passthrough)) as TaskCompleted;
    const photo = item.uploads[0] as PhotoUpload;
    expect(photo.read()).rejects.toThrow(DownloadError);
  });
});

// A submitted `location` task input is NOT a file: the backend's
// LocationUploadedEvent (@jsonHint "locationUploaded") FLATTENS the coordinate
// fields (latitude…encrypted) directly onto the upload — there is no nested
// `location` key (unlike the reply/submission `location` field).
describe("location input answers (flattened wire shape)", () => {
  const passthrough = async (_m: unknown, v: string | undefined) => v;

  test("plaintext locationUploaded decodes the flattened coords", async () => {
    const ev = {
      eventType: "TaskCompleted",
      data: {
        type: "taskCompleted",
        taskId: "task-1",
        inputsUploaded: [{ type: "locationUploaded", id: "in-loc-1", latitude: 48.8566, longitude: 2.3522, accuracy: 7 }],
      },
    } as unknown as Event;
    const item = (await wrapInput(ev, passthrough)) as TaskCompleted;
    const loc = item.uploads.find((u) => u.kind === "location") as LocationUpload;
    expect(loc).toBeDefined();
    expect(loc.id).toBe("in-loc-1");
    expect(loc.location).toEqual({ latitude: 48.8566, longitude: 2.3522, accuracy: 7 });
  });

  test("encrypted locationUploaded decrypts the flattened blob via the event marker", async () => {
    const key = new Uint8Array(32).fill(7);
    const marker = { type: "org" as const, v: 1 };
    const coords = { latitude: 40.7128, longitude: -74.006, accuracy: 12 };
    const plaintextLocation = JSON.stringify(coords);
    const ciphertextLocation = await encrypt(key, plaintextLocation);
    const dec = async (m: unknown, v: string | undefined) =>
      v !== undefined && (m as { type?: string })?.type === "org" ? plaintextLocation : v;
    const ev = {
      eventType: "TaskCompleted",
      encryption: marker,
      data: {
        type: "taskCompleted",
        taskId: "task-1",
        inputsUploaded: [{ type: "locationUploaded", id: "in-loc-2", encrypted: ciphertextLocation }],
      },
    } as unknown as Event;
    const item = (await wrapInput(ev, dec)) as TaskCompleted;
    const loc = item.uploads.find((u) => u.kind === "location") as LocationUpload;
    expect(loc.location).toEqual(coords);
  });

  // Stronger than the stub above: the flattened task-input answer path decoded
  // through a REAL Keyring + decryptor. The org master key is registered at a
  // specific version and the coords are real-`encrypt`ed under it; the top-level
  // event `encryption` marker `{type:"org",v:V}` is what wrapInput threads into
  // wrapUpload→wrapLocation, so this proves the flattened `locationUploaded`
  // answer is decrypted by resolving the org key *by version* off the keyring.
  test("encrypted locationUploaded decrypts via a real org keyring (by version, flattened answer)", async () => {
    const orgKey = new Uint8Array(32).fill(0x21);
    const version = 5;
    const coords = { latitude: 40.7128, longitude: -74.006, accuracy: 12, speed: 1.5, heading: 90 };
    const ciphertextLocation = await encrypt(orgKey, JSON.stringify(coords));
    const keyring = await Keyring.build({ passwords: [], topics: [], orgMasterKeys: [{ version, key: orgKey }] });
    const dec = buildDecryptor(buildKeyResolver(keyring, undefined));
    const ev = {
      eventType: "TaskCompleted",
      encryption: { type: "org", v: version },
      data: {
        type: "taskCompleted",
        taskId: "task-org-1",
        inputsUploaded: [{ type: "locationUploaded", id: "in-loc-org", encrypted: ciphertextLocation }],
      },
    } as unknown as Event;
    const item = (await wrapInput(ev, dec)) as TaskCompleted;
    const loc = item.uploads.find((u) => u.kind === "location") as LocationUpload;
    expect(loc).toBeDefined();
    expect(loc.id).toBe("in-loc-org");
    expect(loc.location).toEqual(coords);
  });

  test("real org keyring with the WRONG version leaves the flattened locationUploaded undecrypted", async () => {
    const orgKey = new Uint8Array(32).fill(0x21);
    const coords = { latitude: 40.7128, longitude: -74.006 };
    const ciphertextLocation = await encrypt(orgKey, JSON.stringify(coords));
    // Keyring holds v5; event marker says v6 → no key resolves → ciphertext is
    // passed through → JSON.parse fails → location degrades to undefined.
    const keyring = await Keyring.build({ passwords: [], topics: [], orgMasterKeys: [{ version: 5, key: orgKey }] });
    const dec = buildDecryptor(buildKeyResolver(keyring, undefined));
    const ev = {
      eventType: "TaskCompleted",
      encryption: { type: "org", v: 6 },
      data: {
        type: "taskCompleted",
        taskId: "task-org-2",
        inputsUploaded: [{ type: "locationUploaded", id: "in-loc-bad", encrypted: ciphertextLocation }],
      },
    } as unknown as Event;
    const item = (await wrapInput(ev, dec)) as TaskCompleted;
    const loc = item.uploads.find((u) => u.kind === "location") as LocationUpload;
    expect(loc.location).toBeUndefined();
  });
});
