// Send-path coverage for the two create-response shapes (independent groups
// are the backend default; `shared: true` opts into the single shared task)
// and the group append. No network: a fake `fetch` serves queued JSON bodies
// and records request payloads.

import { describe, expect, test } from "bun:test";
import { Client, Task, TaskGroup } from "../src/index.js";

type RecordedCall = { url: string; body: unknown };

function queuedFetch(responses: unknown[], calls: RecordedCall[] = []): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: RequestInit) => {
    // JSON bodies decode for assertions; binary bodies (the S3 PUT) record raw.
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? undefined;
    calls.push({ url: String(url), body });
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
    // A nameless recipient arrives WITHOUT a name key (zio-json omits None) —
    // the handle normalizes it to null.
    { taskId: "tsk_00000000-0000-7000-8000-00000000000b", waitToken: "wt_b", appendToken: "at_b", recipient: { publicId: "usr_b" } },
  ],
  attachments: [],
};

const sharedResponse = {
  taskId: "tsk_00000000-0000-7000-8000-00000000000c",
  createdAt: "2026-07-03T10:00:00Z",
  waitToken: "wt_s",
  appendToken: "at_s",
  attachments: [],
};

describe("sendTask response shapes", () => {
  test("default send returns a TaskGroup with one Task per recipient", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([groupResponse], calls) });
    const group = await client.sendTask({ topic: "alerts", content: "hi" });
    expect(group).toBeInstanceOf(TaskGroup);
    expect(group.groupId).toBe(groupResponse.groupId);
    expect(group.appendToken).toBe("at_group");
    expect(group.instances.length).toBe(2);
    expect(group.instances[0]).toBeInstanceOf(Task);
    expect(group.instances[0]!.taskId).toBe(groupResponse.instances[0]!.taskId);
    expect(group.instances[0]!.recipient?.publicId).toBe("usr_a");
    expect(group.instances[1]!.recipient?.name).toBeNull();
    // No `shared` key rides the request in default mode.
    expect((calls[0]!.body as Record<string, unknown>).shared).toBeUndefined();
    // Two instances → `sole` must refuse.
    expect(() => group.sole).toThrow();
  });

  test("sole unwraps a single-instance group", async () => {
    const oneInstance = { ...groupResponse, instances: [groupResponse.instances[0]] };
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([oneInstance]) });
    const group = await client.sendTask({ topic: "alerts", content: "hi" });
    expect(group.sole.taskId).toBe(groupResponse.instances[0]!.taskId);
  });

  test("shared: true sends the flag and returns a legacy Task", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([sharedResponse], calls) });
    const task = await client.sendTask({ topic: "alerts", content: "hi", shared: true });
    expect(task).toBeInstanceOf(Task);
    expect(task.taskId).toBe(sharedResponse.taskId);
    expect(task.appendToken).toBe("at_s");
    expect((calls[0]!.body as Record<string, unknown>).shared).toBe(true);
  });
});

describe("group append", () => {
  const appendGroupResponse = {
    groupId: groupResponse.groupId,
    createdAt: "2026-07-03T10:05:00Z",
    subtasks: [
      { taskId: groupResponse.instances[0]!.taskId, subtaskId: "sub_00000000-0000-7000-8000-000000000010" },
      { taskId: groupResponse.instances[1]!.taskId, subtaskId: "sub_00000000-0000-7000-8000-000000000011" },
    ],
    attachments: [],
  };

  test("TaskGroup.append returns one Subtask per member and threads the subset", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([groupResponse, appendGroupResponse], calls) });
    const group = await client.sendTask({ topic: "alerts", content: "hi" });
    const subtasks = await group.append({ content: "follow-up", instances: [group.instances[0]!.taskId] });
    expect(subtasks.length).toBe(2);
    expect(subtasks[0]!.subtaskId).toBe(appendGroupResponse.subtasks[0]!.subtaskId);
    expect(subtasks[0]!.parentTaskId).toBe(groupResponse.instances[0]!.taskId);
    const appendBody = calls[1]!.body as Record<string, unknown>;
    expect(appendBody.appendToken).toBe("at_group");
    expect(appendBody.instances).toEqual([group.instances[0]!.taskId]);
  });

  test("TaskGroup.append with files sends the metadata and uploads ONCE for the batch", async () => {
    const calls: RecordedCall[] = [];
    const withAttachment = {
      ...appendGroupResponse,
      attachments: [{ id: "att_00000000-0000-7000-8000-000000000020", filename: "a.png" }],
    };
    const presign = { presignedPutUrl: "https://s3.example/put", objectKey: "k", expiresAt: "2026-07-03T11:00:00Z" };
    // append → presign → PUT → complete: exactly ONE upload for two siblings.
    const client = new Client({
      apiToken: "tok",
      fetch: queuedFetch([groupResponse, withAttachment, presign, {}, {}], calls),
    });
    const group = await client.sendTask({ topic: "alerts", content: "hi" });
    const subtasks = await group.append({ content: "x", files: [{ filename: "a.png", data: new Uint8Array([1, 2, 3]) }] });
    expect(subtasks.length).toBe(2);
    const appendBody = calls[1]!.body as { data: { files: unknown[] } };
    expect(appendBody.data.files.length).toBe(1);
    expect(calls[2]!.url).toContain("attachments/att_00000000-0000-7000-8000-000000000020/upload-url");
    expect(calls[3]!.url).toBe("https://s3.example/put");
    expect(calls[4]!.url).toContain("attachments/att_00000000-0000-7000-8000-000000000020/complete");
    expect(calls.length).toBe(5);
  });

  test("stateless Client.appendSubtask surfaces the group shape untouched", async () => {
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([appendGroupResponse]) });
    const resp = await client.appendSubtask({ appendToken: "at_group", content: "x" });
    expect("groupId" in resp).toBe(true);
  });
});
