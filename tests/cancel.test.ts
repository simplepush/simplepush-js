// Coverage for sender-side cancellation: the request shapes of the three
// cancel POSTs (task / subtask / task group), the client-side validation, and
// the canceled terminal markers ending handle streams. No network — requests
// are served by a recording fake fetch, events are fed into the demux hub.

import { describe, expect, test } from "bun:test";
import { Client, TaskGroup, type GroupInput } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { SubtaskCanceled, TaskCanceled } from "../src/event-views.js";

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

const groupResponse = {
  groupId: "grptsk_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-08-04T10:00:00Z",
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

function canceledEvent(taskId: string, version: number, extra: Record<string, unknown> = {}): Event {
  return { eventType: "TaskCanceled", version, createdAt: "2026-08-04T10:02:00Z", data: { type: "taskCanceled", taskId, reason: "canceled", ...extra } };
}

function subtaskCanceledEvent(taskId: string, subtaskId: string, version: number, extra: Record<string, unknown> = {}): Event {
  return { eventType: "SubtaskCanceled", version, createdAt: "2026-08-04T10:03:00Z", data: { type: "subtaskCanceled", parentTaskId: taskId, subtaskId, reason: "superseded", ...extra } };
}

async function sendGroup(responses: unknown[], calls: RecordedCall[]): Promise<{ group: TaskGroup; dispatch: (ev: Event) => void }> {
  const client = new Client({ apiToken: "tok", fetch: recordingFetch(responses, calls) });
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

describe("cancel requests", () => {
  test("Task.cancel POSTs reason + note to the task's cancel endpoint", async () => {
    const calls: RecordedCall[] = [];
    const { group } = await sendGroup([groupResponse, null], calls);
    await group.instances[0]!.cancel({ reason: "answered", note: "already handled" });

    const call = calls.at(-1)!;
    expect(call.url).toContain(`/v1/tasks/${TASK_A}/cancel`);
    expect(call.body).toEqual({ reason: "answered", note: "already handled" });
  });

  test("cancel defaults to plain `canceled`", async () => {
    const calls: RecordedCall[] = [];
    const { group } = await sendGroup([groupResponse, null], calls);
    await group.instances[0]!.cancel();
    expect(calls.at(-1)!.body).toEqual({ reason: "canceled" });
  });

  test("supersededBy without the superseded reason is rejected before any request", async () => {
    const calls: RecordedCall[] = [];
    const { group } = await sendGroup([groupResponse], calls);
    expect(group.instances[0]!.cancel({ reason: "answered", supersededBy: TASK_B })).rejects.toThrow("supersededBy");
    expect(calls.length).toBe(1); // only the send
  });

  test("TaskGroup.cancel targets the group endpoint and returns the counts", async () => {
    const calls: RecordedCall[] = [];
    const { group } = await sendGroup([groupResponse, { canceled: 1, skipped: 1 }], calls);
    const result = await group.cancel({ reason: "superseded", supersededBy: "grptsk_00000000-0000-7000-8000-000000000002" });

    const call = calls.at(-1)!;
    expect(call.url).toContain(`/v1/task-groups/${group.groupId}/cancel`);
    expect(call.body).toEqual({ reason: "superseded", supersededBy: "grptsk_00000000-0000-7000-8000-000000000002" });
    expect(result).toEqual({ canceled: 1, skipped: 1 });
  });

  test("an encrypted send's cancel encrypts the note and stamps ITS marker", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", passwords: [["pw", "alerts"]], fetch: recordingFetch([groupResponse, null], calls) });
    const group = (await client.sendTask({ topic: "alerts", content: "hi" })) as TaskGroup;
    await group.instances[0]!.cancel({ reason: "answered", note: "already handled" });

    const body = calls.at(-1)!.body as { note?: string; encryption?: { type?: string; keyFingerprint?: string } };
    // The note is sealed under the chain key and carries ITS OWN marker (the
    // send key's fingerprint) — not the task's marker.
    expect(body.note).toBeDefined();
    expect(body.note).not.toBe("already handled");
    expect(body.encryption?.type).toBe("personal");
    expect(typeof body.encryption?.keyFingerprint).toBe("string");
  });

  test("Subtask.cancel targets the subtask endpoint", async () => {
    const calls: RecordedCall[] = [];
    const { group } = await sendGroup(
      [groupResponse, { subtaskId: "sub_00000000-0000-7000-8000-000000000010", createdAt: "2026-08-04T10:00:30Z", attachments: [] }, null],
      calls,
    );
    const subtask = await group.instances[0]!.append({ content: "follow-up" });
    await subtask.cancel({ reason: "superseded", supersededBy: "sub_00000000-0000-7000-8000-000000000011" });

    const call = calls.at(-1)!;
    expect(call.url).toContain(`/v1/subtasks/${subtask.subtaskId}/cancel`);
    expect(call.body).toEqual({ reason: "superseded", supersededBy: "sub_00000000-0000-7000-8000-000000000011" });
  });
});

describe("canceled terminal markers", () => {
  test("a member's cancel surfaces the marker, then that member ends — the group ends when all do", async () => {
    const calls: RecordedCall[] = [];
    const { group, dispatch } = await sendGroup([groupResponse], calls);
    dispatch(canceledEvent(TASK_A, 1, { reason: "answered", supersededBy: TASK_B }));
    dispatch(canceledEvent(TASK_B, 2));

    // No idleMs: this resolves ONLY because every member ends on its cancel.
    const items = await collect<GroupInput>(group.inputs({ replay: true }));

    expect(items.length).toBe(2);
    const byTask = new Map(items.map((gi) => [gi.instance.taskId, gi]));
    const a = byTask.get(TASK_A)!.item as TaskCanceled;
    expect(a.kind).toBe("taskCanceled");
    expect(a.reason).toBe("answered");
    expect(a.supersededBy).toBe(TASK_B);
    expect((byTask.get(TASK_B)!.item as TaskCanceled).kind).toBe("taskCanceled");
  });

  test("a canceled ROOT ends a subtask's stream too (chain-wide terminal)", async () => {
    const calls: RecordedCall[] = [];
    const { group, dispatch } = await sendGroup(
      [groupResponse, { subtaskId: "sub_00000000-0000-7000-8000-000000000010", createdAt: "2026-08-04T10:00:30Z", attachments: [] }],
      calls,
    );
    const subtask = await group.instances[0]!.append({ content: "follow-up" });
    dispatch(canceledEvent(TASK_A, 1));

    // No idleMs: resolves only because the root cancel is entity-wide terminal.
    const items = await collect(subtask.inputs({ replay: true }));
    expect(items.length).toBe(1);
    expect((items[0] as TaskCanceled).kind).toBe("taskCanceled");
  });

  test("a subtask cancel ends only its own stream, not the root's", async () => {
    const calls: RecordedCall[] = [];
    const { group, dispatch } = await sendGroup(
      [groupResponse, { subtaskId: "sub_00000000-0000-7000-8000-000000000010", createdAt: "2026-08-04T10:00:30Z", attachments: [] }],
      calls,
    );
    const subtask = await group.instances[0]!.append({ content: "follow-up" });
    dispatch(subtaskCanceledEvent(TASK_A, subtask.subtaskId, 1, { supersededBy: "sub_replacement" }));

    const subItems = await collect(subtask.inputs({ replay: true }));
    expect(subItems.length).toBe(1);
    const marker = subItems[0] as SubtaskCanceled;
    expect(marker.kind).toBe("subtaskCanceled");
    expect(marker.subtaskId).toBe(subtask.subtaskId);
    expect(marker.supersededBy).toBe("sub_replacement");

    // The root's stream is untouched: it only ends via the idle timeout.
    const rootItems = await collect(group.instances[0]!.inputs({ replay: true, idleMs: 60 }));
    expect(rootItems).toEqual([]);
  });
});
