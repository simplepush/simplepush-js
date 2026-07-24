// Coverage for collecting replies over a whole task group (`TaskGroup.replies()`).
// No network: the send is served by a fake `fetch`, and reply events are fed
// straight into the client's demux hub, so the merge over the members' shared
// `ws/v1/events` stream is exercised without a socket.

import { describe, expect, test } from "bun:test";
import { Client, TaskGroup, type GroupReply } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { Reply, TaskDeleted } from "../src/event-views.js";

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

function replyEvent(taskId: string, text: string, version: number, replyId: string): Event {
  return {
    eventType: "ReplyAppended",
    entityId: "usr_x",
    version,
    createdAt: "2026-07-03T10:01:00Z",
    data: { type: "replyAppended", taskId, reply: { id: replyId, body: { type: "text", value: text }, createdAt: "2026-07-03T10:01:00Z" } },
  };
}

function deletedEvent(taskId: string, version: number): Event {
  return { eventType: "TaskDeleted", version, createdAt: "2026-07-03T10:02:00Z", data: { type: "taskDeleted", taskId } };
}

/** Send a group, then stub the hub so it never opens a socket. Returns the group
 * plus a `dispatch` that feeds events straight into the demux buffers. */
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

describe("TaskGroup.replies", () => {
  test("merges replies from every member, tagged by originating instance", async () => {
    const { group, dispatch } = await sendGroup();
    dispatch(replyEvent(TASK_A, "from alice", 1, "rpl_a"));
    dispatch(replyEvent(TASK_B, "from bob", 2, "rpl_b"));

    const items = await collect<GroupReply>(group.replies({ replay: true, idleMs: 80 }));

    expect(items.length).toBe(2);
    const byTask = new Map(items.map((gr) => [gr.instance.taskId, gr]));
    expect(new Set(byTask.keys())).toEqual(new Set([TASK_A, TASK_B]));
    expect((byTask.get(TASK_A)!.item as Reply).body?.text).toBe("from alice");
    expect((byTask.get(TASK_B)!.item as Reply).body?.text).toBe("from bob");
    // `recipient` is the shortcut to which recipient replied.
    expect(byTask.get(TASK_A)!.recipient?.name).toBe("Alice");
    expect(byTask.get(TASK_B)!.recipient?.name).toBe("Bob");
  });

  test("carries multiple replies from one member", async () => {
    const { group, dispatch } = await sendGroup();
    dispatch(replyEvent(TASK_A, "one", 1, "rpl_1"));
    dispatch(replyEvent(TASK_A, "two", 2, "rpl_2"));

    const items = await collect<GroupReply>(group.replies({ replay: true, idleMs: 80 }));

    expect(items.map((gr) => (gr.item as Reply).body?.text)).toEqual(["one", "two"]);
    expect(items.every((gr) => gr.instance.taskId === TASK_A)).toBe(true);
  });

  test("surfaces a member's deletion, then that member ends", async () => {
    const { group, dispatch } = await sendGroup();
    dispatch(replyEvent(TASK_A, "hi", 1, "rpl_a"));
    dispatch(deletedEvent(TASK_B, 2));

    const items = await collect<GroupReply>(group.replies({ replay: true, idleMs: 80 }));

    const byTask = new Map(items.map((gr) => [gr.instance.taskId, gr]));
    expect((byTask.get(TASK_A)!.item as Reply).kind).toBe("reply");
    expect((byTask.get(TASK_B)!.item as TaskDeleted).kind).toBe("taskDeleted");
  });

  test("an empty group yields nothing", async () => {
    const { group } = await sendGroup({ ...groupResponse, instances: [] });
    const items = await collect<GroupReply>(group.replies({ replay: true, idleMs: 80 }));
    expect(items).toEqual([]);
  });
});
