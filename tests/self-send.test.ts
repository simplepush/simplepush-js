// Topicless "note to self": a personal Client may omit `topic` to send to its
// OWN devices, returning a single Task / Notification. Plaintext by default;
// encrypted under the account key (default password + password_salt from
// GET /v1/user) when a default password is configured. No network: a fake fetch
// serves queued JSON and records request payloads.

import { describe, expect, test } from "bun:test";
import { Client, Notification, Task } from "../src/index.js";

type RecordedCall = { url: string; body: unknown; headers: Record<string, string> };

function queuedFetch(responses: unknown[], calls: RecordedCall[] = []): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? undefined;
    calls.push({ url: String(url), body, headers: (init?.headers as Record<string, string>) ?? {} });
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const taskResponse = {
  taskId: "tsk_00000000-0000-7000-8000-00000000000c",
  createdAt: "2026-07-07T10:00:00Z",
  waitToken: "wt_s",
  appendToken: "at_s",
  attachments: [],
};

const notificationResponse = {
  notificationId: "ntf_00000000-0000-7000-8000-00000000000c",
  createdAt: "2026-07-07T10:00:00Z",
  waitToken: "wt_s",
};

const userInfo = { passwordSalt: "account-salt-value" };

describe("note-to-self (topicless send)", () => {
  test("task with no topic goes to your own devices, plaintext, single Task", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([taskResponse], calls) });
    const task = await client.sendTask({ content: "hi" });
    expect(task).toBeInstanceOf(Task);
    expect(task.taskId).toBe(taskResponse.taskId);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.topic).toBeUndefined();
    expect(body.member).toBeUndefined();
    expect(body.broadcast).toBeUndefined();
    // No default password → plaintext (no marker, content in the clear).
    expect(body.encryption).toBeUndefined();
    expect(body.content).toBe("hi");
  });

  test("task with no topic encrypts under the account key when a default password is set", async () => {
    const calls: RecordedCall[] = [];
    // First fetch is GET /v1/user (account salt), then the task POST.
    const client = new Client({
      apiToken: "tok",
      passwords: "my-account-pw",
      fetch: queuedFetch([userInfo, taskResponse], calls),
    });
    await client.sendTask({ title: "secret", content: "hi" });
    const post = calls.find((c) => c.url.includes("/tasks/json"))!;
    const body = post.body as Record<string, unknown>;
    expect(body.topic).toBeUndefined();
    expect((body.encryption as Record<string, unknown>).type).toBe("personal");
    expect((body.encryption as Record<string, unknown>).passwordFingerprint).toBeDefined();
    expect(body.content).not.toBe("hi");
    expect(body.title).not.toBe("secret");
  });

  test("notification with no topic goes to your own devices as a single Notification", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([notificationResponse], calls) });
    const note = await client.sendNotification({ content: "ping" });
    expect(note).toBeInstanceOf(Notification);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.topic).toBeUndefined();
    expect(body.encryption).toBeUndefined();
    // A personal notification create (even plaintext, no media) MUST carry the
    // API-Token — the backend rejects an unauthenticated create.
    expect(calls[0]!.headers["API-Token"]).toBe("tok");
  });

  test("passing a password with no topic throws", async () => {
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([taskResponse]) });
    // @ts-expect-error — password with no topic isn't a valid overload; runtime guards too.
    await expect(client.sendTask({ content: "hi", password: "ad-hoc" })).rejects.toThrow();
  });
});
