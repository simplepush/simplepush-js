// Id-addressed cancels: no handle, the target is read first so a note can be
// sealed under its key when the client holds it.

import { describe, expect, test } from "bun:test";

import { OrgClient, decrypt } from "../src/index.js";

type RecordedCall = { url: string; body: unknown };

function recordingFetch(responses: unknown[], calls: RecordedCall[]): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(resp === null ? "" : JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const KEY = new Uint8Array(32).fill(3);
const TASK = "tsk_00000000-0000-7000-8000-000000000001";

describe("cancel by id", () => {
  test("seals the note under the task's org key when held", async () => {
    const calls: RecordedCall[] = [];
    const client = new OrgClient({
      apiKey: "k",
      orgMasterKeys: [{ version: 1, key: KEY }],
      fetch: recordingFetch([{ taskId: TASK, status: "pending", encryption: { type: "org", v: 1 } }, null], calls),
    });
    await client.cancelTask(TASK, { note: "sent by mistake" });
    const body = calls[1]!.body as { reason: string; note: string; encryption?: unknown };
    expect(calls[1]!.url.endsWith(`/v1/tasks/${TASK}/cancel`)).toBe(true);
    expect(body.reason).toBe("canceled");
    expect(body.note).not.toBe("sent by mistake");
    expect(await decrypt(KEY, body.note)).toBe("sent by mistake");
    expect(body.encryption).toEqual({ type: "org", v: 1 });
  });

  test("a plaintext task gets a plaintext note; no note means no read", async () => {
    const calls: RecordedCall[] = [];
    const client = new OrgClient({ apiKey: "k", fetch: recordingFetch([{ taskId: TASK, status: "pending" }, null, null], calls) });
    await client.cancelTask(TASK, { note: "plain" });
    expect((calls[1]!.body as { note: string; encryption?: unknown }).note).toBe("plain");
    expect((calls[1]!.body as { encryption?: unknown }).encryption).toBeUndefined();
    await client.cancelTask(TASK);
    expect(calls.length).toBe(3);
    expect(calls[2]!.url.endsWith("/cancel")).toBe(true);
  });
});
