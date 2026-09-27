// Priority on send: the plaintext `priority` / `criticalVolume` fields ride
// the create request unchanged, the deprecated `critical` flag maps to 5, and
// nothing is sent when nothing is set. No network: canned fetch.

import { describe, expect, test } from "bun:test";
import { Client } from "../src/index.js";

function recordingFetch(responses: unknown[], bodies: unknown[]): typeof fetch {
  let i = 0;
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const taskResponse = {
  groupId: "grptsk_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-08-08T10:00:00Z",
  groupWaitToken: "wt_group",
  groupAppendToken: "at_group",
  instances: [{ taskId: "tsk_00000000-0000-7000-8000-00000000000a", waitToken: "wt_a", appendToken: "at_a", recipient: { publicId: "usr_a", name: "Alice" } }],
  attachments: [],
};

const notificationResponse = {
  groupId: "grpntf_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-08-08T10:00:00Z",
  instances: [{ notificationId: "ntf_00000000-0000-7000-8000-00000000000a", recipient: { publicId: "usr_a", name: "Alice" } }],
};

function client(responses: unknown[], bodies: unknown[]): Client {
  const c = new Client({ apiToken: "tok", fetch: recordingFetch(responses, bodies) });
  const hub = (c as unknown as { hub(): { ensureRunning: () => void } }).hub();
  hub.ensureRunning = () => {};
  return c;
}

describe("priority on send", () => {
  test("task: priority and criticalVolume ride the request", async () => {
    const bodies: unknown[] = [];
    await client([taskResponse], bodies).sendTask({ topic: "alerts", content: "hi", priority: 5, criticalVolume: 0.4 });
    expect(bodies[0]).toMatchObject({ priority: 5, criticalVolume: 0.4 });
  });

  test("notification: priority rides the request; nothing set sends nothing", async () => {
    const bodies: unknown[] = [];
    const c = client([notificationResponse, notificationResponse], bodies);
    await c.sendNotification({ topic: "alerts", content: "hi", priority: 2 });
    await c.sendNotification({ topic: "alerts", content: "hi" });
    expect(bodies[0]).toMatchObject({ priority: 2 });
    expect("priority" in (bodies[1] as Record<string, unknown>)).toBe(false);
    expect("critical" in (bodies[0] as Record<string, unknown>)).toBe(false);
  });

  test("deprecated critical maps to priority 5 unless priority is set", async () => {
    const bodies: unknown[] = [];
    const c = client([notificationResponse, notificationResponse], bodies);
    await c.sendNotification({ topic: "alerts", content: "hi", critical: true });
    await c.sendNotification({ topic: "alerts", content: "hi", critical: true, priority: 3 });
    expect(bodies[0]).toMatchObject({ priority: 5 });
    expect(bodies[1]).toMatchObject({ priority: 3 });
    expect("critical" in (bodies[0] as Record<string, unknown>)).toBe(false);
  });

  test("subtask: priority rides the append data", async () => {
    const bodies: unknown[] = [];
    const c = client([taskResponse, { subtaskId: "sub_00000000-0000-7000-8000-00000000000b", parentTaskId: taskResponse.instances[0]!.taskId, createdAt: "2026-08-08T10:01:00Z", attachments: [] }], bodies);
    const group = await c.sendTask({ topic: "alerts", content: "hi" });
    await group.instances[0]!.append({ content: "more", priority: 4 });
    expect((bodies[1] as { data: Record<string, unknown> }).data).toMatchObject({ priority: 4 });
  });
});
