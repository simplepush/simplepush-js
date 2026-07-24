// Coverage for collecting input events over a whole task group
// (`TaskGroup.inputs()`). No network: the send is served by a fake `fetch`, and
// input events are fed straight into the client's demux hub, so the merge over
// the members' shared `ws/v1/events` stream is exercised without a socket.

import { describe, expect, test } from "bun:test";
import { Client, TaskGroup, type GroupInput } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { InputEvent, TaskCompleted, TaskDeleted } from "../src/event-views.js";

function queuedFetch(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const groupResponse = {
  groupId: "grptsk_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-07-03T10:00:00Z",
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

function inputEvent(taskId: string, version: number): Event {
  return { eventType: "TaskInputUploaded", version, createdAt: "2026-07-03T10:01:00Z", data: { type: "taskInputUploaded", taskId } };
}

function completedEvent(taskId: string, version: number): Event {
  return { eventType: "TaskCompleted", version, createdAt: "2026-07-03T10:01:30Z", data: { type: "taskCompleted", taskId, inputsUploaded: [] } };
}

function deletedEvent(taskId: string, version: number): Event {
  return { eventType: "TaskDeleted", version, createdAt: "2026-07-03T10:02:00Z", data: { type: "taskDeleted", taskId } };
}

async function sendGroup(response: unknown = groupResponse): Promise<{ group: TaskGroup; dispatch: (ev: Event) => void }> {
  const client = new Client({ apiToken: "tok", fetch: queuedFetch([response]) });
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

describe("TaskGroup.inputs", () => {
  test("merges input events from every member, tagged by originating instance", async () => {
    const { group, dispatch } = await sendGroup();
    dispatch(inputEvent(TASK_A, 1));
    dispatch(inputEvent(TASK_B, 2));

    const items = await collect<GroupInput>(group.inputs({ replay: true, idleMs: 80 }));

    expect(items.length).toBe(2);
    const byTask = new Map(items.map((gi) => [gi.instance.taskId, gi]));
    expect(new Set(byTask.keys())).toEqual(new Set([TASK_A, TASK_B]));
    expect((byTask.get(TASK_A)!.item as InputEvent).type).toBe("taskInputUploaded");
    expect(byTask.get(TASK_A)!.recipient?.name).toBe("Alice");
    expect(byTask.get(TASK_B)!.recipient?.name).toBe("Bob");
  });

  test("terminal completion ends the group without an idle timeout", async () => {
    const { group, dispatch } = await sendGroup();
    dispatch(completedEvent(TASK_A, 1));
    dispatch(completedEvent(TASK_B, 2));

    // No idleMs: this resolves ONLY because every member's stream ends on its
    // own taskCompleted (it would hang otherwise).
    const items = await collect<GroupInput>(group.inputs({ replay: true }));

    expect(items.length).toBe(2);
    const byTask = new Map(items.map((gi) => [gi.instance.taskId, gi]));
    expect((byTask.get(TASK_A)!.item as TaskCompleted).kind).toBe("taskCompleted");
    expect((byTask.get(TASK_B)!.item as TaskCompleted).kind).toBe("taskCompleted");
  });

  test("surfaces a member's deletion, then that member ends", async () => {
    const { group, dispatch } = await sendGroup();
    dispatch(inputEvent(TASK_A, 1));
    dispatch(deletedEvent(TASK_B, 2));

    const items = await collect<GroupInput>(group.inputs({ replay: true, idleMs: 80 }));

    const byTask = new Map(items.map((gi) => [gi.instance.taskId, gi]));
    expect((byTask.get(TASK_A)!.item as InputEvent).kind).toBe("input");
    expect((byTask.get(TASK_B)!.item as TaskDeleted).kind).toBe("taskDeleted");
  });

  test("an empty group yields nothing", async () => {
    const { group } = await sendGroup({ ...groupResponse, instances: [] });
    const items = await collect<GroupInput>(group.inputs({ replay: true, idleMs: 80 }));
    expect(items).toEqual([]);
  });
});
