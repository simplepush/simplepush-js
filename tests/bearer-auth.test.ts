// Credential selection: a client may authenticate with its own token type
// (`API-Token` for personal, `Api-Key` for org) or with an `Authorization:
// Bearer` credential. Personal calls that `accessToken` (it is always an OAuth
// token); org calls it `bearerToken` (it may also be a CLI admin session).
// The backend resolves either to the same principal, so both must reach the
// same surfaces.
//
// No network: a fake `fetch` records the headers each call went out with.

import { describe, expect, test } from "bun:test";
import { Client, OrgClient } from "../src/index.js";

type RecordedCall = { url: string; headers: Record<string, string> };

function recordingFetch(responses: unknown[], calls: RecordedCall[] = []): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
    calls.push({ url: String(url), headers });
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

const notification = { notificationId: "ntf_00000000-0000-7000-8000-00000000000d", createdAt: "2026-07-03T10:00:00Z" };

describe("personal client credentials", () => {
  test("an API-Token client sends with the API-Token header", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: recordingFetch([sharedTask], calls) });
    await client.sendTask({ content: "hi" });
    expect(calls[0]?.headers["API-Token"]).toBe("tok");
    expect(calls[0]?.headers["Authorization"]).toBeUndefined();
  });

  test("a bearer client sends with Authorization instead", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ accessToken: "spa_abc", fetch: recordingFetch([sharedTask], calls) });
    await client.sendTask({ content: "hi" });
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer spa_abc");
    expect(calls[0]?.headers["API-Token"]).toBeUndefined();
  });

  test("a bearer client can send notifications too", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ accessToken: "spa_abc", fetch: recordingFetch([notification], calls) });
    await client.sendNotification({ content: "hi" });
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer spa_abc");
  });

  test("exactly one credential is required", () => {
    expect(() => new Client({} as never)).toThrow(/missing credential/);
    expect(() => new Client({ apiToken: "tok", accessToken: "spa_abc" })).toThrow(/not both/);
  });

  test("requireApiToken still throws on a bearer client", () => {
    const client = new Client({ accessToken: "spa_abc" });
    expect(() => client.requireApiToken()).toThrow(/missing credential/);
  });
});

describe("org client credentials", () => {
  test("an Api-Key client sends with the Api-Key header", async () => {
    const calls: RecordedCall[] = [];
    const client = new OrgClient({ apiKey: "key", fetch: recordingFetch([sharedTask], calls) });
    await client.sendTask({ broadcast: true, content: "hi", shared: true });
    expect(calls[0]?.headers["Api-Key"]).toBe("key");
  });

  test("a session-authenticated org client can now send", async () => {
    // The regression this whole change is about: `sp` is logged in, so it holds
    // a session bearer and no Api-Key. Sending used to throw outright.
    const calls: RecordedCall[] = [];
    const client = new OrgClient({ bearerToken: "sess_abc", fetch: recordingFetch([sharedTask], calls) });
    await client.sendTask({ broadcast: true, content: "hi", shared: true });
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer sess_abc");
    expect(calls[0]?.headers["Api-Key"]).toBeUndefined();
  });

});
