// Expired markers: the collective `taskExpired` terminal ends streams
// chain-wide (the clock's mirror of taskCanceled — no actor, no note), and
// `expiresAt` rides the create request. No network — events are fed into the
// demux hub; the send is a canned fetch.

import { describe, expect, test } from "bun:test";
import { Client, TaskGroup } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { TaskExpired } from "../src/event-views.js";

function recordingFetch(responses: unknown[], bodies: unknown[]): typeof fetch {
  let i = 0;
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const groupResponse = {
  groupId: "grptsk_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-08-08T10:00:00Z",
  groupWaitToken: "wt_group",
  groupAppendToken: "at_group",
  instances: [
    { taskId: "tsk_00000000-0000-7000-8000-00000000000a", waitToken: "wt_a", appendToken: "at_a", recipient: { publicId: "usr_a", name: "Alice" } },
  ],
  attachments: [],
};

const TASK_A = groupResponse.instances[0]!.taskId;

function expiredEvent(taskId: string, version: number): Event {
  return { eventType: "TaskExpired", version, createdAt: "2026-08-08T12:00:00Z", data: { type: "taskExpired", taskId } };
}

async function sendGroup(
  responses: unknown[],
  bodies: unknown[] = [],
  opts: Record<string, unknown> = {},
): Promise<{ group: TaskGroup; dispatch: (ev: Event) => void }> {
  const client = new Client({ apiToken: "tok", fetch: recordingFetch(responses, bodies) });
  const group = (await client.sendTask({ topic: "alerts", content: "hi", ...opts })) as TaskGroup;
  const hub = (client as unknown as { hub(): unknown }).hub() as { ensureRunning: () => void; dispatch: (ev: Event) => void };
  hub.ensureRunning = () => {}; // never open a real WS in a test
  return { group, dispatch: (ev) => hub.dispatch(ev) };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("expiresAt on send", () => {
  test("a string passes through and a Date serializes to ISO-8601", async () => {
    const bodies: unknown[] = [];
    await sendGroup([groupResponse], bodies, { expiresAt: "2026-08-09T10:00:00Z" });
    expect((bodies[0] as { expiresAt?: string }).expiresAt).toBe("2026-08-09T10:00:00Z");

    const bodies2: unknown[] = [];
    await sendGroup([groupResponse], bodies2, { expiresAt: new Date("2026-08-09T10:00:00Z") });
    expect((bodies2[0] as { expiresAt?: string }).expiresAt).toBe("2026-08-09T10:00:00.000Z");
  });

  test("absent expiresAt is omitted from the request body", async () => {
    const bodies: unknown[] = [];
    await sendGroup([groupResponse], bodies);
    expect("expiresAt" in (bodies[0] as Record<string, unknown>)).toBe(false);
  });
});

describe("expired marker", () => {
  test("taskExpired ends the inputs stream as a collective terminal", async () => {
    const { group, dispatch } = await sendGroup([groupResponse]);
    dispatch(expiredEvent(TASK_A, 1));

    // No idleMs: this resolves ONLY because taskExpired is terminal.
    const items = await collect(group.instances[0]!.inputs({ replay: true }));
    expect(items.length).toBe(1);
    const marker = items[0] as TaskExpired;
    expect(marker.kind).toBe("taskExpired");
    expect(marker.taskId).toBe(TASK_A);
    expect(marker.actor).toBeUndefined();
  });

  test("an expired root ends a subtask's stream too (entity-wide terminal)", async () => {
    const { group, dispatch } = await sendGroup([
      groupResponse,
      { subtaskId: "sub_00000000-0000-7000-8000-000000000010", createdAt: "2026-08-08T10:00:30Z", attachments: [] },
    ]);
    const subtask = await group.instances[0]!.append({ content: "follow-up" });
    dispatch(expiredEvent(TASK_A, 1));

    const items = await collect(subtask.inputs({ replay: true }));
    expect(items.length).toBe(1);
    expect((items[0] as TaskExpired).kind).toBe("taskExpired");
  });

  test("the replies stream ends on taskExpired too", async () => {
    const { group, dispatch } = await sendGroup([groupResponse]);
    dispatch(expiredEvent(TASK_A, 1));

    const items = await collect(group.instances[0]!.replies({ replay: true }));
    expect(items.map((i) => (i as { kind: string }).kind)).toEqual(["taskExpired"]);
  });
});
