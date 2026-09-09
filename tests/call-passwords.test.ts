// Per-call `passwords` on the receive side: watch handles, downloads and
// id-addressed cancels take the same shape as the constructor's `passwords`,
// scoped to that call. Events are fed into the demux hub directly; reads use a
// recording fetch.

import { describe, expect, test } from "bun:test";

import { Client, OrgClient, decrypt, type GroupReply } from "../src/index.js";
import { deriveKey, encrypt } from "../src/crypto.js";
import type { Event } from "../src/events.js";
import type { Reply } from "../src/event-views.js";

const TASK = "tsk_00000000-0000-7000-8000-00000000000a";
const GROUP = "grptsk_00000000-0000-7000-8000-000000000001";

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

async function encryptedReply(password: string, salt: string, text: string): Promise<Event> {
  const dk = await deriveKey(password, salt);
  return {
    eventType: "ReplyAppended",
    version: 1,
    createdAt: "2026-07-03T10:01:00Z",
    encryption: { type: "personal", keyFingerprint: dk.fingerprint },
    data: { type: "replyAppended", taskId: TASK, reply: { id: "rpl_1", body: { type: "text", value: await encrypt(dk.symmetricKey, text) }, createdAt: "2026-07-03T10:01:00Z" } },
  };
}

function hubOf(client: Client) {
  const hub = (client as unknown as { hub(): unknown }).hub() as { ensureRunning: () => void; dispatch: (ev: Event) => void };
  hub.ensureRunning = () => {};
  return hub;
}

async function firstReply(group: { replies: (o: { replay: boolean; idleMs: number }) => AsyncIterable<GroupReply> }): Promise<Reply> {
  for await (const gr of group.replies({ replay: true, idleMs: 80 })) return gr.item as Reply;
  throw new Error("no reply");
}

const userInfo = { userId: "u", passwordSalt: "server-salt" };

describe("per-call passwords on watch handles", () => {
  test("a [password, topic] pair given to watchTaskGroup decrypts that topic's replies", async () => {
    const client = new Client({ apiToken: "tok" });
    const group = client.watchTaskGroup({ groupId: GROUP, members: [{ taskId: TASK }], passwords: [["topic-pw", "alerts"]] });
    hubOf(client).dispatch(await encryptedReply("topic-pw", "alerts", "from alice"));
    expect((await firstReply(group)).body?.text).toBe("from alice");
  });

  test("without the password the ciphertext is left in place", async () => {
    const client = new Client({ apiToken: "tok" });
    const group = client.watchTaskGroup({ groupId: GROUP, members: [{ taskId: TASK }] });
    hubOf(client).dispatch(await encryptedReply("topic-pw", "alerts", "from alice"));
    expect((await firstReply(group)).body?.text).not.toBe("from alice");
  });

  test("a bare string is the Personal Password for the call and decrypts a watched self-send", async () => {
    const client = new Client({ apiToken: "tok", fetch: recordingFetch([userInfo], []) });
    const group = client.watchTaskGroup({ groupId: GROUP, members: [{ taskId: TASK }], passwords: "personal-pw" });
    hubOf(client).dispatch(await encryptedReply("personal-pw", "server-salt", "to myself"));
    expect((await firstReply(group)).body?.text).toBe("to myself");
  });

  test("the configured Personal Password also decrypts a watched self-send", async () => {
    const client = new Client({ apiToken: "tok", passwords: "personal-pw", fetch: recordingFetch([userInfo], []) });
    const group = client.watchTaskGroup({ groupId: GROUP, members: [{ taskId: TASK }] });
    hubOf(client).dispatch(await encryptedReply("personal-pw", "server-salt", "to myself"));
    expect((await firstReply(group)).body?.text).toBe("to myself");
  });

  test("call passwords stay with the call: the client's keyring does not learn them", async () => {
    const client = new Client({ apiToken: "tok" });
    client.watchTaskGroup({ groupId: GROUP, members: [{ taskId: TASK }], passwords: [["topic-pw", "alerts"]] });
    const dk = await deriveKey("topic-pw", "alerts");
    expect((await client.keyring()).keyForMarker({ type: "personal", keyFingerprint: dk.fingerprint })).toBeUndefined();
  });

  test("an OrgClient takes no call passwords", () => {
    const org = new OrgClient({ apiKey: "k" });
    // @ts-expect-error — org content decrypts with the configured master keys only
    org.watchTaskGroup({ groupId: GROUP, members: [{ taskId: TASK }], passwords: "x" });
  });
});

describe("per-call passwords on id-addressed cancels", () => {
  test("seals the note under the task's topic key given for the call", async () => {
    const dk = await deriveKey("topic-pw", "alerts");
    const calls: RecordedCall[] = [];
    const client = new Client({
      apiToken: "tok",
      fetch: recordingFetch([{ taskId: TASK, status: "pending", encryption: { type: "personal", keyFingerprint: dk.fingerprint } }, null], calls),
    });
    await client.cancelTask(TASK, { note: "sent by mistake", passwords: [["topic-pw", "alerts"]] });
    const body = calls[1]!.body as { note: string; encryption?: unknown; passwords?: unknown };
    expect(await decrypt(dk.symmetricKey, body.note)).toBe("sent by mistake");
    expect(body.encryption).toEqual({ type: "personal", keyFingerprint: dk.fingerprint });
    expect(body.passwords).toBeUndefined();
  });
});

describe("keyring caching", () => {
  test("the Personal Password key is added even when the keyring was first built without the salt", async () => {
    const client = new Client({ apiToken: "tok", passwords: "personal-pw", fetch: recordingFetch([userInfo], []) });
    await client.keyring();
    const ring = await client.keyring({ includePasswordSalt: true });
    const dk = await deriveKey("personal-pw", "server-salt");
    expect(ring.keyForMarker({ type: "personal", keyFingerprint: dk.fingerprint })).toEqual(dk.symmetricKey);
  });

  test("the salt is fetched once across repeated requests", async () => {
    const calls: RecordedCall[] = [];
    const client = new Client({ apiToken: "tok", passwords: "personal-pw", fetch: recordingFetch([userInfo], calls) });
    await client.keyring({ includePasswordSalt: true });
    await client.keyring({ includePasswordSalt: true });
    const scoped = (client as unknown as { scopedKeyring(scope: unknown, opts: unknown): Promise<unknown> });
    await scoped.scopedKeyring({ passwords: "other-pw" }, { includePasswordSalt: true });
    expect(calls.filter((c) => c.url.endsWith("/v1/user")).length).toBe(1);
  });
});

describe("OrgClient submissions", () => {
  test("an org member's submission decrypts under the configured master key, with no salt fetch", async () => {
    const KEY = new Uint8Array(32).fill(7);
    const noFetch = (async () => {
      throw new Error("an OrgClient must not fetch /v1/user");
    }) as typeof fetch;
    const org = new OrgClient({ apiKey: "k", orgMasterKeys: [{ version: 3, key: KEY }], fetch: noFetch });
    const ev: Event = {
      eventType: "SubmissionCreated",
      encryption: { type: "org", v: 3 },
      data: { type: "submissionCreated", submission: { id: "sbm_1", body: { type: "text", value: await encrypt(KEY, "pump 3 is leaking") }, createdAt: "t" } },
    };
    (org as unknown as { events: () => AsyncIterable<Event> }).events = async function* () { yield ev; };
    const seen: string[] = [];
    for await (const sub of org.submissions({ idleMs: 50 })) seen.push(sub.body?.kind === "text" ? sub.body.text : "");
    expect(seen).toEqual(["pump 3 is leaking"]);
  });
});
