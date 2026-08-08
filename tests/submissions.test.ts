// Unit tests for observing submissions (the `Submission` view, body decryption,
// and downloadable photo/file). No network: a fake `fetch` records the presign
// POST + S3 GET and serves canned bytes.

import { describe, expect, test } from "bun:test";

import { encrypt, sha256Base64 } from "../src/crypto.js";
import type { DownloadTransport, KeyResolver } from "../src/downloads.js";
import { DownloadError } from "../src/errors.js";
import { wrapReply, wrapSubmission, type Reply, type Submission, type SubmissionFile } from "../src/event-views.js";
import type { Event } from "../src/events.js";
import { buildDecryptor, buildKeyResolver } from "../src/handles.js";
import { Keyring } from "../src/keyring.js";

const PRESIGNED_URL = "https://s3.example/presigned-object";

type Call = { url: string; method: string };

function fakeFetch(blob: Uint8Array, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/download-url")) {
      return new Response(JSON.stringify({ presignedGetUrl: PRESIGNED_URL, expiresAt: "2026-06-13T00:00:00Z" }), { status: 200 });
    }
    if (url === PRESIGNED_URL) return new Response(new Uint8Array(blob), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function base(blob: Uint8Array, calls: Call[], resolveKey: KeyResolver = async () => undefined) {
  const transport: DownloadTransport = {
    baseUrl: new URL("https://api.example/"),
    authHeaders: { "API-Token": "tok" },
    fetchImpl: fakeFetch(blob, calls),
  };
  return { transport, resolveKey };
}

function event(submission: Record<string, unknown>, encryption?: Record<string, unknown>): Event {
  return {
    eventType: "SubmissionCreated",
    ...(encryption ? { encryption } : {}),
    data: { type: "submissionCreated", submission },
  } as unknown as Event;
}

const passthrough = async (_m: unknown, v: string | undefined) => v;

describe("wrapSubmission", () => {
  test("wraps a text body and metadata", async () => {
    const sub = (await wrapSubmission(event({ id: "sbm-1", body: { type: "text", value: "hello" }, createdAt: "t" }), passthrough)) as Submission;
    expect(sub.kind).toBe("submission");
    expect(sub.id).toBe("sbm-1");
    expect(sub.body).toEqual({ kind: "text", text: "hello" });
    expect(sub.photo).toBeUndefined();
  });

  test("photo/file download against the submission path", async () => {
    const blob = new TextEncoder().encode("submission bytes");
    const calls: Call[] = [];
    const checksum = await sha256Base64(blob);
    const sub = await wrapSubmission(
      event({
        id: "sbm-3",
        photo: { id: "sbf-1", contentType: "image/jpeg", checksumSha256: checksum, size: blob.length },
        file: { id: "sbf-2", contentType: "application/pdf", checksumSha256: checksum, size: blob.length, filename: "doc.pdf" },
      }),
      passthrough,
      base(blob, calls),
    );
    expect(await sub.photo!.read()).toEqual(blob);
    expect(await sub.file!.read()).toEqual(blob);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "https://api.example/v1/submissions/sbm-3/files/sbf-1/download-url",
      "https://api.example/v1/submissions/sbm-3/files/sbf-2/download-url",
    ]);
  });

  test("audio download with durationSeconds against the submission path", async () => {
    const blob = new TextEncoder().encode("audio bytes");
    const calls: Call[] = [];
    const checksum = await sha256Base64(blob);
    const sub = await wrapSubmission(
      event({
        id: "sbm-7",
        audio: { id: "sba-1", contentType: "audio/ogg", checksumSha256: checksum, size: blob.length, durationSeconds: 15.5, filename: "voice.ogg" },
      }),
      passthrough,
      base(blob, calls),
    );
    expect(sub.audio).toBeDefined();
    expect(sub.audio!.durationSeconds).toBe(15.5);
    expect(sub.audio!.filename).toBe("voice.ogg");
    expect(await sub.audio!.read()).toEqual(blob);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "https://api.example/v1/submissions/sbm-7/files/sba-1/download-url",
    ]);
  });

  test("encrypted location decrypts via the resolver", async () => {
    const key = new Uint8Array(32).fill(9);
    const marker = { type: "org" as const, v: 1 };
    const coords = { latitude: 37.7749, longitude: -122.4194, accuracy: 10 };
    const plaintextLocation = JSON.stringify(coords);
    const ciphertextLocation = await encrypt(key, plaintextLocation);
    const dec = async (m: unknown, v: string | undefined) =>
      v !== undefined && (m as { type?: string })?.type === "org" ? plaintextLocation : v;
    const sub = await wrapSubmission(
      event(
        {
          id: "sbm-8",
          location: { encrypted: ciphertextLocation },
        },
        marker as unknown as Record<string, unknown>,
      ),
      dec,
    );
    expect(sub.location).toEqual(coords);
  });

  // Stronger than the stub above: wire a REAL Keyring holding a 32-byte org
  // master key at a specific version, real-`encrypt` the coords under it, and
  // decode through the REAL decryptor (buildDecryptor∘buildKeyResolver). This
  // proves the org marker `{type:"org",v:V}` is honored end-to-end — the
  // decryptor resolves the key by *version* off the keyring and AEAD-decrypts —
  // rather than a stub that merely returns plaintext when it sees `type:"org"`.
  test("encrypted submission location decrypts via a real org keyring (by version)", async () => {
    const orgKey = new Uint8Array(32).fill(0x5a);
    const version = 7;
    const coords = { latitude: 35.6762, longitude: 139.6503, accuracy: 8, timestamp: 1700000000 };
    const ciphertextLocation = await encrypt(orgKey, JSON.stringify(coords));
    const keyring = await Keyring.build({ passwords: [], topics: [], orgMasterKeys: [{ version, key: orgKey }] });
    const dec = buildDecryptor(buildKeyResolver(keyring, undefined));
    const sub = await wrapSubmission(
      event(
        {
          id: "sbm-org-loc",
          location: { encrypted: ciphertextLocation },
        },
        { type: "org", v: version },
      ),
      dec,
    );
    expect(sub.location).toEqual(coords);
  });

  test("real org keyring with the WRONG version leaves submission location ciphertext undecrypted", async () => {
    const orgKey = new Uint8Array(32).fill(0x5a);
    const coords = { latitude: 35.6762, longitude: 139.6503 };
    const ciphertextLocation = await encrypt(orgKey, JSON.stringify(coords));
    // Keyring holds v7 but the event marker says v8 → no key resolves, the
    // decryptor passes the ciphertext through, and JSON.parse of base64 fails →
    // location degrades to undefined (no silent wrong-coords).
    const keyring = await Keyring.build({ passwords: [], topics: [], orgMasterKeys: [{ version: 7, key: orgKey }] });
    const dec = buildDecryptor(buildKeyResolver(keyring, undefined));
    const sub = await wrapSubmission(
      event({ id: "sbm-org-bad", location: { encrypted: ciphertextLocation } }, { type: "org", v: 8 }),
      dec,
    );
    expect(sub.location).toBeUndefined();
  });

  test("encrypted reply location decrypts via a real org keyring (by version)", async () => {
    const orgKey = new Uint8Array(32).fill(0x33);
    const version = 4;
    const coords = { latitude: -33.8688, longitude: 151.2093, accuracy: 3, altitude: 58 };
    const ciphertextLocation = await encrypt(orgKey, JSON.stringify(coords));
    const keyring = await Keyring.build({ passwords: [], topics: [], orgMasterKeys: [{ version, key: orgKey }] });
    const dec = buildDecryptor(buildKeyResolver(keyring, undefined));
    const replyEvent = {
      eventType: "ReplyAppended",
      encryption: { type: "org", v: version },
      data: {
        type: "replyAppended",
        taskId: "task-org-1",
        reply: { id: "r-org-loc", location: { encrypted: ciphertextLocation } },
      },
    } as unknown as Event;
    const reply = (await wrapReply(replyEvent, dec)) as Reply;
    expect(reply.location).toEqual(coords);
  });

  test("plaintext location uses structured fields", async () => {
    const sub = await wrapSubmission(
      event({
        id: "sbm-9",
        location: { latitude: 51.5074, longitude: -0.1278, accuracy: 5 },
      }),
      passthrough,
    );
    expect(sub.location).toEqual({ latitude: 51.5074, longitude: -0.1278, accuracy: 5 });
  });

  test("without a download base, files are present but not downloadable", async () => {
    const sub = await wrapSubmission(event({ id: "sbm-4", photo: { id: "sbf-9", contentType: "image/png", size: 1 } }), passthrough);
    const photo = sub.photo as SubmissionFile;
    expect(photo.id).toBe("sbf-9");
    expect(photo.read()).rejects.toThrow(DownloadError);
  });

  test("encrypted body decrypts via the resolver; encrypted file decrypts on read", async () => {
    const key = new Uint8Array(32).fill(9);
    const marker = { type: "org" as const, v: 1 };
    const plaintextBody = "secret note";
    const ciphertextBody = await encrypt(key, plaintextBody);
    const filePlain = new TextEncoder().encode("secret file");
    const fileBlob = Uint8Array.from(atob(await encrypt(key, "secret file")), (c) => c.charCodeAt(0));
    void filePlain;
    const calls: Call[] = [];
    const dec = async (m: unknown, v: string | undefined) =>
      v !== undefined && (m as { type?: string })?.type === "org" ? plaintextBody : v;
    const resolveKey: KeyResolver = async (m) => (m.type === "org" && m.v === 1 ? key : undefined);
    const sub = await wrapSubmission(
      event(
        {
          id: "sbm-5",
          body: { type: "text", value: ciphertextBody },
          file: { id: "sbf-5", contentType: "application/octet-stream", checksumSha256: await sha256Base64(fileBlob), size: fileBlob.length },
        },
        marker,
      ),
      dec,
      base(fileBlob, calls, resolveKey),
    );
    expect(sub.body).toEqual({ kind: "text", text: plaintextBody });
    expect(new TextDecoder().decode(await sub.file!.read())).toBe("secret file");
  });

  test("kind discriminator narrows for switch/match", async () => {
    const sub = await wrapSubmission(event({ id: "sbm-6", body: { type: "text", value: "x" } }), passthrough);
    switch (sub.kind) {
      case "submission":
        expect(sub.id).toBe("sbm-6");
        break;
      default:
        throw new Error("unexpected kind");
    }
  });
});
