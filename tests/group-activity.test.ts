// Coverage for TaskGroup.activity() — the combined inputs+replies stream over
// one subscription per member. Key property: a member deletion surfaces ONCE
// (not once per want-set). No network: events are fed into the demux hub.

import { describe, expect, test } from "bun:test";
import { Client, TaskGroup, type GroupActivity } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { InputEvent, Reply, TaskCompleted, TaskDeleted } from "../src/event-views.js";

const groupResponse = {
  groupId: "grptsk_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-07-09T10:00:00Z",
  groupWaitToken: "wt_group",
  groupAppendToken: "at_group",
  instances: [
    { taskId: "tsk_00000000-0000-7000-8000-00000000000a", waitToken: "wt_a", appendToken: "at_a", recipient: { publicId: "usr_a", name: "Alice" } },
  ],
  attachments: [],
};
const TASK_A = groupResponse.instances[0]!.taskId;

function replyEvent(v: number): Event {
  return { eventType: "ReplyAppended", version: v, createdAt: "2026-07-09T10:01:00Z", data: { type: "replyAppended", taskId: TASK_A, reply: { id: "rpl_1", body: { type: "text", value: "hi" }, createdAt: "2026-07-09T10:01:00Z" } } };
}
function inputEvent(v: number): Event {
  return { eventType: "TaskInputUploaded", version: v, createdAt: "2026-07-09T10:01:10Z", data: { type: "taskInputUploaded", taskId: TASK_A } };
}
function completedEvent(v: number): Event {
  return { eventType: "TaskCompleted", version: v, createdAt: "2026-07-09T10:01:20Z", data: { type: "taskCompleted", taskId: TASK_A, inputsUploaded: [] } };
}
function deletedEvent(v: number): Event {
  return { eventType: "TaskDeleted", version: v, createdAt: "2026-07-09T10:02:00Z", data: { type: "taskDeleted", taskId: TASK_A } };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("TaskGroup.activity", () => {
  test("interleaves replies and inputs (incl. completion) from one subscription", async () => {
    const client = new Client({ apiToken: "tok" });
    const g = client.watchTaskGroup({ groupId: groupResponse.groupId, createdAt: groupResponse.createdAt, members: [{ taskId: TASK_A, recipient: { publicId: "usr_a", name: "Alice" } }] });
    const hub = (client as unknown as { hub(): unknown }).hub() as { ensureRunning: () => void; dispatch: (ev: Event) => void };
    hub.ensureRunning = () => {};

    hub.dispatch(replyEvent(1));
    hub.dispatch(inputEvent(2));
    hub.dispatch(completedEvent(3));

    const items = await collect<GroupActivity>(g.activity({ replay: true, idleMs: 80 }));
    const kinds = items.map((i) => i.item.kind);
    expect(kinds).toEqual(["reply", "input", "taskCompleted"]);
    expect((items[0]!.item as Reply).body?.text).toBe("hi");
    expect((items[1]!.item as InputEvent).type).toBe("taskInputUploaded");
    expect((items[2]!.item as TaskCompleted).kind).toBe("taskCompleted");
    expect(items.every((i) => i.recipient?.name === "Alice")).toBe(true);
  });

  test("a member deletion surfaces exactly once", async () => {
    const client = new Client({ apiToken: "tok" });
    const g = client.watchTaskGroup({ groupId: groupResponse.groupId, createdAt: groupResponse.createdAt, members: [{ taskId: TASK_A }] });
    const hub = (client as unknown as { hub(): unknown }).hub() as { ensureRunning: () => void; dispatch: (ev: Event) => void };
    hub.ensureRunning = () => {};

    hub.dispatch(replyEvent(1));
    hub.dispatch(deletedEvent(2));

    const items = await collect<GroupActivity>(g.activity({ replay: true, idleMs: 80 }));
    const deletions = items.filter((i) => (i.item as TaskDeleted).kind === "taskDeleted");
    expect(deletions.length).toBe(1);
  });
});
