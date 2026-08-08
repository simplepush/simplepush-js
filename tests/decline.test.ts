// Recipient-side decline markers: the per-recipient signal surfacing
// mid-stream (a shared task stays live for the others) and the collective
// `taskDeclined` terminal ending streams chain-wide. No network — events are
// fed into the demux hub.

import { describe, expect, test } from "bun:test";
import { Client, TaskGroup, type GroupInput } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { TaskDeclined, TaskDeclinedByRecipient } from "../src/event-views.js";

function respondingFetch(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    return new Response(resp === null ? "" : JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const groupResponse = {
  groupId: "grptsk_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-08-06T10:00:00Z",
  groupWaitToken: "wt_group",
  groupAppendToken: "at_group",
  instances: [
    { taskId: "tsk_00000000-0000-7000-8000-00000000000a", waitToken: "wt_a", appendToken: "at_a", recipient: { publicId: "usr_a", name: "Alice" } },
    { taskId: "tsk_00000000-0000-7000-8000-00000000000b", waitToken: "wt_b", appendToken: "at_b", recipient: { publicId: "usr_b", name: "Bob" } },
  ],
  attachments: [],
};

const TASK_A = groupResponse.instances[0]!.taskId;
const TASK_B = groupResponse.instances[1]!.taskId;

function declinedByRecipientEvent(taskId: string, version: number, extra: Record<string, unknown> = {}, actor?: Record<string, unknown>): Event {
  return {
    eventType: "TaskDeclinedByRecipient",
    version,
    createdAt: "2026-08-06T10:02:00Z",
    data: { type: "taskDeclinedByRecipient", taskId, reason: "declined", ...extra },
    ...(actor ? { actor } : {}),
  } as Event;
}

function declinedEvent(taskId: string, version: number): Event {
  return { eventType: "TaskDeclined", version, createdAt: "2026-08-06T10:03:00Z", data: { type: "taskDeclined", taskId } };
}

async function sendGroup(responses: unknown[]): Promise<{ group: TaskGroup; dispatch: (ev: Event) => void }> {
  const client = new Client({ apiToken: "tok", fetch: respondingFetch(responses) });
  const group = (await client.sendTask({ topic: "alerts", content: "hi" })) as TaskGroup;
  const hub = (client as unknown as { hub(): unknown }).hub() as { ensureRunning: () => void; dispatch: (ev: Event) => void };
  hub.ensureRunning = () => {}; // never open a real WS in a test
  return { group, dispatch: (ev) => hub.dispatch(ev) };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("declined markers", () => {
  test("a decline signals mid-stream, then the collective terminal ends the inputs stream", async () => {
    const { group, dispatch } = await sendGroup([groupResponse]);
    const actor = { publicId: "usr_a", name: "Alice", deviceName: "Pixel" };
    dispatch(declinedByRecipientEvent(TASK_A, 1, { reason: "failed", note: "printer is on fire" }, actor));
    dispatch(declinedEvent(TASK_A, 2));

    // No idleMs: this resolves ONLY because taskDeclined is terminal.
    const items = await collect(group.instances[0]!.inputs({ replay: true }));
    expect(items.length).toBe(2);
    const signal = items[0] as TaskDeclinedByRecipient;
    expect(signal.kind).toBe("taskDeclinedByRecipient");
    expect(signal.reason).toBe("failed");
    expect(signal.note).toBe("printer is on fire");
    expect(signal.actor).toEqual(actor);
    expect((items[1] as TaskDeclined).kind).toBe("taskDeclined");
  });

  test("a partial decline is NOT terminal: the stream stays open (idle timeout ends it)", async () => {
    const { group, dispatch } = await sendGroup([groupResponse]);
    dispatch(declinedByRecipientEvent(TASK_A, 1));

    const items = await collect(group.instances[0]!.inputs({ replay: true, idleMs: 60 }));
    expect(items.length).toBe(1);
    expect((items[0] as TaskDeclinedByRecipient).kind).toBe("taskDeclinedByRecipient");
  });

  test("the replies stream surfaces the signal and ends on the collective terminal too", async () => {
    const { group, dispatch } = await sendGroup([groupResponse]);
    dispatch(declinedByRecipientEvent(TASK_A, 1, { note: "not me" }));
    dispatch(declinedEvent(TASK_A, 2));

    const items = await collect(group.instances[0]!.replies({ replay: true }));
    expect(items.map((i) => (i as { kind: string }).kind)).toEqual(["taskDeclinedByRecipient", "taskDeclined"]);
    expect((items[0] as TaskDeclinedByRecipient).note).toBe("not me");
  });

  test("a fully-declined root ends a subtask's stream too (entity-wide terminal)", async () => {
    const { group, dispatch } = await sendGroup([
      groupResponse,
      { subtaskId: "sub_00000000-0000-7000-8000-000000000010", createdAt: "2026-08-06T10:00:30Z", attachments: [] },
    ]);
    const subtask = await group.instances[0]!.append({ content: "follow-up" });
    dispatch(declinedEvent(TASK_A, 1));

    const items = await collect(subtask.inputs({ replay: true }));
    expect(items.length).toBe(1);
    expect((items[0] as TaskDeclined).kind).toBe("taskDeclined");
  });

  test("group inputs surface each member's decline countdown, then end when all members end", async () => {
    const { group, dispatch } = await sendGroup([groupResponse]);
    dispatch(declinedByRecipientEvent(TASK_A, 1));
    dispatch(declinedEvent(TASK_A, 2));
    dispatch(declinedByRecipientEvent(TASK_B, 3));
    dispatch(declinedEvent(TASK_B, 4));

    // No idleMs: resolves only because every member ends on its taskDeclined.
    const items = await collect<GroupInput>(group.inputs({ replay: true }));
    expect(items.length).toBe(4);
    const kindsByTask = new Map<string, string[]>();
    for (const gi of items) {
      const list = kindsByTask.get(gi.instance.taskId) ?? [];
      list.push((gi.item as { kind: string }).kind);
      kindsByTask.set(gi.instance.taskId, list);
    }
    expect(kindsByTask.get(TASK_A)).toEqual(["taskDeclinedByRecipient", "taskDeclined"]);
    expect(kindsByTask.get(TASK_B)).toEqual(["taskDeclinedByRecipient", "taskDeclined"]);
  });
});

describe("subtask declined markers (scoped)", () => {
  function subtaskDeclinedByRecipientEvent(taskId: string, subtaskId: string, version: number, extra: Record<string, unknown> = {}): Event {
    return {
      eventType: "SubtaskDeclinedByRecipient",
      version,
      createdAt: "2026-08-07T10:02:00Z",
      data: { type: "subtaskDeclinedByRecipient", parentTaskId: taskId, subtaskId, reason: "declined", ...extra },
    };
  }
  function subtaskDeclinedEvent(taskId: string, subtaskId: string, version: number): Event {
    return { eventType: "SubtaskDeclined", version, createdAt: "2026-08-07T10:03:00Z", data: { type: "subtaskDeclined", parentTaskId: taskId, subtaskId } };
  }

  test("a subtask decline signals then ends only ITS stream; the root stays open", async () => {
    const { group, dispatch } = await sendGroup([
      groupResponse,
      { subtaskId: "sub_00000000-0000-7000-8000-000000000010", createdAt: "2026-08-07T10:00:30Z", attachments: [] },
    ]);
    const subtask = await group.instances[0]!.append({ content: "follow-up" });
    dispatch(subtaskDeclinedByRecipientEvent(TASK_A, subtask.subtaskId, 1, { reason: "failed", note: "not this step" }));
    dispatch(subtaskDeclinedEvent(TASK_A, subtask.subtaskId, 2));

    // No idleMs: resolves only because subtaskDeclined is a scoped terminal.
    const items = await collect(subtask.inputs({ replay: true }));
    expect(items.map((i) => (i as { kind: string }).kind)).toEqual(["subtaskDeclinedByRecipient", "subtaskDeclined"]);
    const signal = items[0] as { reason?: string; note?: string; subtaskId?: string };
    expect(signal.reason).toBe("failed");
    expect(signal.note).toBe("not this step");
    expect(signal.subtaskId).toBe(subtask.subtaskId);

    // The ROOT task's stream is untouched (scoped, not chain-wide).
    const rootItems = await collect(group.instances[0]!.inputs({ replay: true, idleMs: 60 }));
    expect(rootItems).toEqual([]);
  });

  test("a subtask's replies stream ends on the scoped decline terminal too", async () => {
    const { group, dispatch } = await sendGroup([
      groupResponse,
      { subtaskId: "sub_00000000-0000-7000-8000-000000000010", createdAt: "2026-08-07T10:00:30Z", attachments: [] },
    ]);
    const subtask = await group.instances[0]!.append({ content: "follow-up" });
    dispatch(subtaskDeclinedEvent(TASK_A, subtask.subtaskId, 1));

    const items = await collect(subtask.replies({ replay: true }));
    expect(items.length).toBe(1);
    expect((items[0] as { kind: string }).kind).toBe("subtaskDeclined");
  });
});
