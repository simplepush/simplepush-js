// Personal keys supplied directly, rather than derived from a password.
//
// The point of the feature is blast radius: a password is a *deriver* — hand it
// over and the holder mints keys for any topic they name, forever. A key grants
// exactly what it decrypts. That matters for anything running outside the app
// (an MCP server, a CLI on a build box) which needs to encrypt without being
// trusted with the password.
//
// The load-bearing property is that the wire cannot tell the difference: a key
// exported from the app must produce exactly the marker its password would, or
// the app could not decrypt what the integration sent.

import { describe, expect, test } from "bun:test";
import { Client, deriveKey, fingerprintFor, importKey } from "../src/index.js";

type RecordedCall = { url: string; body: any };

function queuedFetch(responses: unknown[], calls: RecordedCall[] = []): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? undefined;
    calls.push({ url: String(url), body });
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const sharedTask = {
  taskId: "tsk_00000000-0000-7000-8000-00000000000c",
  createdAt: "2026-07-03T10:00:00Z",
  waitToken: "wt_s",
  appendToken: "at_s",
  attachments: [],
};

describe("importKey", () => {
  test("accepts raw bytes and base64, and fingerprints them identically", async () => {
    const raw = new Uint8Array(32).fill(7);
    const b64 = Buffer.from(raw).toString("base64");
    const fromBytes = await importKey(raw);
    const fromB64 = await importKey(b64);
    expect(fromBytes.fingerprint).toBe(await fingerprintFor(raw));
    expect(fromB64.fingerprint).toBe(fromBytes.fingerprint);
  });

  test("rejects a key that is not 32 bytes", async () => {
    await expect(importKey(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});

describe("sending under a supplied key", () => {
  test("a topic key produces the same marker its password would", async () => {
    // The whole feature rests on this: the app derived the key from a password,
    // exported it, and the holder of the key must be indistinguishable on the
    // wire from the holder of the password.
    const derived = await deriveKey("hunter2", "alerts");

    const passwordCalls: RecordedCall[] = [];
    const byPassword = new Client({
      apiToken: "tok",
      passwords: [["hunter2", "alerts"]],
      fetch: queuedFetch([sharedTask], passwordCalls),
    });
    await byPassword.sendTask({ topic: "alerts", content: "hi", shared: true });

    const keyCalls: RecordedCall[] = [];
    const byKey = new Client({
      apiToken: "tok",
      keys: [[derived.symmetricKey, "alerts"]],
      fetch: queuedFetch([sharedTask], keyCalls),
    });
    await byKey.sendTask({ topic: "alerts", content: "hi", shared: true });

    const markerOf = (c: RecordedCall) => c.body?.encryption;
    expect(markerOf(keyCalls[0]!)).toEqual(markerOf(passwordCalls[0]!));
    expect(markerOf(keyCalls[0]!)).toEqual({ type: "personal", keyFingerprint: derived.fingerprint });
  });

  test("a bare key encrypts a topicless note-to-self without fetching the salt", async () => {
    // A password-derived default key needs `GET /v1/user` for the Argon2 salt.
    // A supplied key needs no salt at all, so the send must be the ONLY call.
    const key = new Uint8Array(32).fill(3);
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", keys: key, fetch: queuedFetch([sharedTask], calls) });
    await client.sendTask({ content: "note to self" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/tasks/json");
    expect(calls[0]?.body?.encryption).toEqual({
      type: "personal",
      keyFingerprint: await fingerprintFor(key),
    });
  });

  test("an explicit per-send password still overrides a configured key", async () => {
    const key = new Uint8Array(32).fill(9);
    const calls: RecordedCall[] = [];
    const client = new Client({
      apiToken: "tok",
      keys: [[key, "alerts"]],
      fetch: queuedFetch([sharedTask], calls),
    });
    await client.sendTask({ topic: "alerts", content: "hi", password: "explicit", shared: true });

    const expected = await deriveKey("explicit", "alerts");
    expect(calls[0]?.body?.encryption).toEqual({
      type: "personal",
      keyFingerprint: expected.fingerprint,
    });
  });

  test("no key and no password sends in the clear", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([sharedTask], calls) });
    await client.sendTask({ content: "plain" });
    expect(calls[0]?.body?.encryption).toBeUndefined();
  });

  test("only one bare key is allowed", async () => {
    const client = new Client({
      apiToken: "tok",
      keys: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
      fetch: queuedFetch([sharedTask]),
    });
    await expect(client.sendTask({ content: "hi" })).rejects.toThrow(/only one default key/);
  });
});
