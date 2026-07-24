// Coverage for collecting answers over a whole notification group
// (`NotificationGroup.inputs()`), plus the watch path that rebuilds a group
// from ids (`Client.watchNotificationGroup`). Mirrors group-inputs.test.ts /
// watch-task-group.test.ts. No network: the send is served by a fake `fetch`,
// and completion events are fed straight into the client's demux hub, so the
// merge over the members' shared `ws/v1/events` stream is exercised without a
// socket.

import { describe, expect, test } from "bun:test";
import { Client, NotificationGroup, type GroupNotification } from "../src/index.js";
import type { Event } from "../src/events.js";

function queuedFetch(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const groupResponse = {
  groupId: "grpntf_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-07-05T10:00:00Z",
  groupWaitToken: "wt_group",
  instances: [
    { notificationId: "ntf_00000000-0000-7000-8000-00000000000a", waitToken: "wt_a", recipient: { publicId: "usr_a", name: "Alice" } },
    { notificationId: "ntf_00000000-0000-7000-8000-00000000000b", waitToken: "wt_b", recipient: { publicId: "usr_b", name: "Bob" } },
  ],
};

const NTF_A = groupResponse.instances[0]!.notificationId;
const NTF_B = groupResponse.instances[1]!.notificationId;

function completedEvent(notificationId: string, version: number, reply?: unknown): Event {
  return {
    eventType: "NotificationCompleted",
    version,
    createdAt: "2026-07-05T10:01:00Z",
    data: { type: "notificationCompleted", notificationId, ...(reply !== undefined ? { reply } : {}) },
  };
}

async function sendGroup(response: unknown = groupResponse): Promise<{ group: NotificationGroup; dispatch: (ev: Event) => void }> {
  const client = new Client({ apiToken: "tok", fetch: queuedFetch([response]) });
  const group = (await client.sendNotification({ topic: "alerts", content: "hi" })) as NotificationGroup;
  const hub = (client as unknown as { hub(): unknown }).hub() as { ensureRunning: () => void; dispatch: (ev: Event) => void };
  hub.ensureRunning = () => {}; // never open a real WS in a test
  return { group, dispatch: (ev) => hub.dispatch(ev) };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("NotificationGroup.inputs", () => {
  test("completions end the group without an idle timeout, tagged by instance", async () => {
    const { group, dispatch } = await sendGroup();
    dispatch(completedEvent(NTF_A, 1, { type: "choice", selectedIndex: 0, selectedValue: "Yes" }));
    dispatch(completedEvent(NTF_B, 2));

    // No idleMs: this resolves ONLY because every member's stream ends on its
    // own notificationCompleted (it would hang otherwise).
    const items = await collect<GroupNotification>(group.inputs({ replay: true }));

    expect(items.length).toBe(2);
    const byId = new Map(items.map((gn) => [gn.instance.notificationId, gn]));
    expect(new Set(byId.keys())).toEqual(new Set([NTF_A, NTF_B]));
    expect(byId.get(NTF_A)!.item.kind).toBe("notificationCompleted");
    expect(byId.get(NTF_A)!.item.reply).toEqual({ type: "choice", selectedIndex: 0, selectedValue: "Yes" });
    expect(byId.get(NTF_B)!.item.reply).toBeUndefined();
    expect(byId.get(NTF_A)!.recipient?.name).toBe("Alice");
    expect(byId.get(NTF_B)!.recipient?.name).toBe("Bob");
  });

  test("a quiet member never ends the group before the group-wide idleMs", async () => {
    const { group, dispatch } = await sendGroup();
    dispatch(completedEvent(NTF_A, 1));

    const items = await collect<GroupNotification>(group.inputs({ replay: true, idleMs: 80 }));

    // Only Alice answered; Bob's silence ends iteration via the GROUP-WIDE
    // idle timeout, not by dropping his membership.
    expect(items.length).toBe(1);
    expect(items[0]!.instance.notificationId).toBe(NTF_A);
  });

  test("an empty group yields nothing", async () => {
    const { group } = await sendGroup({ ...groupResponse, instances: [] });
    const items = await collect<GroupNotification>(group.inputs({ replay: true, idleMs: 80 }));
    expect(items).toEqual([]);
  });
});

describe("Client.watchNotificationGroup", () => {
  function watchGroup() {
    const client = new Client({ apiToken: "tok" });
    const group = client.watchNotificationGroup({
      groupId: groupResponse.groupId,
      createdAt: groupResponse.createdAt,
      members: [
        { notificationId: NTF_A, recipient: { publicId: "usr_a", name: "Alice" } },
        { notificationId: NTF_B, recipient: { publicId: "usr_b", name: "Bob" } },
      ],
    });
    const hub = (client as unknown as { hub(): unknown }).hub() as { ensureRunning: () => void; dispatch: (ev: Event) => void };
    hub.ensureRunning = () => {};
    return { group, dispatch: (ev: Event) => hub.dispatch(ev) };
  }

  test("rebuilt group collects answers across members, tagged by recipient", async () => {
    const { group, dispatch } = watchGroup();
    dispatch(completedEvent(NTF_A, 1, { type: "text", value: "on it" }));
    dispatch(completedEvent(NTF_B, 2, { type: "text", value: "ack" }));

    const items = await collect<GroupNotification>(group.inputs({ replay: true }));

    const byId = new Map(items.map((gn) => [gn.instance.notificationId, gn]));
    expect(new Set(byId.keys())).toEqual(new Set([NTF_A, NTF_B]));
    expect(byId.get(NTF_A)!.item.reply).toEqual({ type: "text", value: "on it" });
    expect(byId.get(NTF_A)!.recipient?.name).toBe("Alice");
    expect(byId.get(NTF_B)!.recipient?.name).toBe("Bob");
  });

  test("watch handles carry no wait tokens at all", () => {
    const { group } = watchGroup();
    // The watch surface is observe-only BY TYPE: tokens exist solely on the
    // rich Notification/NotificationGroup a send returns, not on Watched*.
    expect("waitToken" in group).toBe(false);
    expect("waitToken" in group.instances[0]!).toBe(false);
    // @ts-expect-error — waitToken is not part of WatchedNotificationGroup
    void group.waitToken;
    // @ts-expect-error — waitToken is not part of WatchedNotification
    void group.instances[0]!.waitToken;
  });
});
