// Coverage for rebuilding a TaskGroup from ids (no send) and collecting over it
// — the path `sp collect` uses to gather replies/inputs for a group it did not
// create in-process. No network: events are fed into the demux hub directly.

import { describe, expect, test } from "bun:test";
import { Client, type GroupReply } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { Reply } from "../src/event-views.js";

const TASK_A = "tsk_00000000-0000-7000-8000-00000000000a";
const TASK_B = "tsk_00000000-0000-7000-8000-00000000000b";

function replyEvent(taskId: string, text: string, version: number, replyId: string): Event {
  return {
    eventType: "ReplyAppended",
    version,
    createdAt: "2026-07-03T10:01:00Z",
    data: { type: "replyAppended", taskId, reply: { id: replyId, body: { type: "text", value: text }, createdAt: "2026-07-03T10:01:00Z" } },
  };
}

function watchGroup() {
  const client = new Client({ apiToken: "tok" });
  const group = client.watchTaskGroup({
    groupId: "grptsk_00000000-0000-7000-8000-000000000001",
    createdAt: "2026-07-03T10:00:00Z",
    members: [
      { taskId: TASK_A, recipient: { publicId: "usr_a", name: "Alice" } },
      { taskId: TASK_B, recipient: { publicId: "usr_b", name: "Bob" } },
    ],
  });
  const hub = (client as unknown as { hub(): unknown }).hub() as { ensureRunning: () => void; dispatch: (ev: Event) => void };
  hub.ensureRunning = () => {};
  return { group, dispatch: (ev: Event) => hub.dispatch(ev) };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("Client.watchTaskGroup", () => {
  test("rebuilt group collects replies across members, tagged by recipient", async () => {
    const { group, dispatch } = watchGroup();
    dispatch(replyEvent(TASK_A, "from alice", 1, "rpl_a"));
    dispatch(replyEvent(TASK_B, "from bob", 2, "rpl_b"));

    const items = await collect<GroupReply>(group.replies({ replay: true, idleMs: 80 }));

    const byTask = new Map(items.map((gr) => [gr.instance.taskId, gr]));
    expect(new Set(byTask.keys())).toEqual(new Set([TASK_A, TASK_B]));
    expect((byTask.get(TASK_A)!.item as Reply).body?.text).toBe("from alice");
    expect(byTask.get(TASK_A)!.recipient?.name).toBe("Alice");
    expect(byTask.get(TASK_B)!.recipient?.name).toBe("Bob");
  });

  test("watch handles carry no append capability at all", () => {
    const { group } = watchGroup();
    // The watch surface is observe-only BY TYPE: append/tokens exist solely on
    // the rich Task/TaskGroup a send returns, not on Watched* handles.
    expect("append" in group).toBe(false);
    expect("append" in group.instances[0]!).toBe(false);
    expect("appendToken" in group).toBe(false);
    expect("waitToken" in group.instances[0]!).toBe(false);
    // @ts-expect-error — append is not part of WatchedTaskGroup
    void group.append;
    // @ts-expect-error — append is not part of WatchedTask
    void group.instances[0]!.append;
  });
});
