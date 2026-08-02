// Send-path coverage for the notification create-response union (independent
// groups are the backend default; `shared: true` opts into the single shared
// notification) and the `actions` input kind. No network: a fake `fetch`
// serves queued JSON bodies and records request payloads. Mirrors tasks.test.ts.

import { describe, expect, test } from "bun:test";
import { Client, Notification, NotificationGroup } from "../src/index.js";

type RecordedCall = { url: string; body: unknown };

function queuedFetch(responses: unknown[], calls: RecordedCall[] = []): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? undefined;
    calls.push({ url: String(url), body });
    const resp = responses[i++];
    if (resp === undefined) throw new Error("fake fetch exhausted");
    return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const groupResponse = {
  groupId: "grpntf_00000000-0000-7000-8000-000000000001",
  createdAt: "2026-07-03T10:00:00Z",
  groupWaitToken: "wt_group",
  instances: [
    { notificationId: "ntf_00000000-0000-7000-8000-00000000000a", waitToken: "wt_a", recipient: { publicId: "usr_a", name: "Alice" } },
    // A nameless recipient arrives WITHOUT a name key (zio-json omits None) —
    // the handle normalizes it to null.
    { notificationId: "ntf_00000000-0000-7000-8000-00000000000b", waitToken: "wt_b", recipient: { publicId: "usr_b" } },
  ],
};

const sharedResponse = {
  notificationId: "ntf_00000000-0000-7000-8000-00000000000c",
  createdAt: "2026-07-03T10:00:00Z",
  waitToken: "wt_s",
};

describe("sendNotification response shapes", () => {
  test("default send returns a NotificationGroup with one Notification per recipient", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([groupResponse], calls) });
    const group = await client.sendNotification({ topic: "alerts", content: "hi" });
    expect(group).toBeInstanceOf(NotificationGroup);
    expect(group.groupId).toBe(groupResponse.groupId);
    expect(group.waitToken).toBe("wt_group");
    expect(group.instances.length).toBe(2);
    expect(group.instances[0]).toBeInstanceOf(Notification);
    expect(group.instances[0]!.notificationId).toBe(groupResponse.instances[0]!.notificationId);
    expect(group.instances[0]!.recipient?.publicId).toBe("usr_a");
    expect(group.instances[0]!.recipient?.name).toBe("Alice");
    // Absent name key normalizes to null.
    expect(group.instances[1]!.recipient?.name).toBeNull();
    // No `shared` key rides the request in default mode.
    expect((calls[0]!.body as Record<string, unknown>).shared).toBeUndefined();
    // Two instances → `sole` must refuse.
    expect(() => group.sole).toThrow();
  });

  test("sole unwraps a single-instance group", async () => {
    const oneInstance = { ...groupResponse, instances: [groupResponse.instances[0]] };
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([oneInstance]) });
    const group = await client.sendNotification({ topic: "alerts", content: "hi" });
    expect(group.sole.notificationId).toBe(groupResponse.instances[0]!.notificationId);
  });

  test("an empty group (zero recipients) stays valid with no instances", async () => {
    const empty = { ...groupResponse, instances: [] };
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([empty]) });
    const group = await client.sendNotification({ topic: "alerts", content: "hi" });
    expect(group).toBeInstanceOf(NotificationGroup);
    expect(group.instances.length).toBe(0);
    expect(() => group.sole).toThrow();
  });

  test("shared: true sends the flag and returns a legacy Notification", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([sharedResponse], calls) });
    const notification = await client.sendNotification({ topic: "alerts", content: "hi", shared: true });
    expect(notification).toBeInstanceOf(Notification);
    expect(notification.notificationId).toBe(sharedResponse.notificationId);
    expect(notification.waitToken).toBe("wt_s");
    expect((calls[0]!.body as Record<string, unknown>).shared).toBe(true);
  });
});

describe("notification actions input", () => {
  type ActionsBody = { actionInput?: { actions: { key: string; label: string; style?: string }[] } };

  test("maps to actionInput with keys, labels, and styles verbatim (plaintext send)", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([groupResponse], calls) });
    await client.sendNotification({
      topic: "alerts",
      content: "Deploy?",
      input: { type: "actions", actions: [{ key: "approve", label: "Approve" }, { key: "deny", label: "Deny", style: "destructive" }] },
    });
    const body = calls[0]!.body as ActionsBody;
    expect(body.actionInput?.actions).toEqual([
      { key: "approve", label: "Approve" },
      { key: "deny", label: "Deny", style: "destructive" },
    ]);
    // Mutually exclusive with text/choice — neither rides along.
    expect((calls[0]!.body as Record<string, unknown>).textInput).toBeUndefined();
    expect((calls[0]!.body as Record<string, unknown>).choiceInput).toBeUndefined();
  });

  test("encrypts both the key and the label when the send is encrypted", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", passwords: [["pw", "alerts"]], fetch: queuedFetch([groupResponse], calls) });
    await client.sendNotification({
      topic: "alerts",
      input: { type: "actions", actions: [{ key: "approve", label: "Approve", style: "primary" }] },
    });
    const action = (calls[0]!.body as ActionsBody).actionInput!.actions[0]!;
    // The key carries the same meaning as the label ("approve"), so it is sealed
    // too — matching a task's actions input. `style` stays plaintext.
    expect(action.key).not.toBe("approve");
    expect(action.label).not.toBe("Approve");
    expect(action.key.length).toBeGreaterThan(0);
    expect(action.label.length).toBeGreaterThan(0);
    expect(action.style).toBe("primary");
  });

  test("rejects duplicate action keys before sending", async () => {
    const client = new Client({ apiToken: "tok", fetch: queuedFetch([groupResponse]) });
    await expect(
      client.sendNotification({
        topic: "alerts",
        input: { type: "actions", actions: [{ key: "x", label: "A" }, { key: "x", label: "B" }] },
      }),
    ).rejects.toThrow(/duplicate action key/);
  });
});
