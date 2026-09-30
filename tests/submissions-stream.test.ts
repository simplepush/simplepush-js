// Which connection `submissions()` reads: without `since` the client's shared
// event hub (one socket for everything), with `since` a connection of its own.
// A fake socket factory records every connection the client opens.

import { describe, expect, test } from "bun:test";

import { Client, HttpError } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { SimplepushWebSocket, WebSocketFactory } from "../src/ws.js";

const TASK = "tsk_00000000-0000-7000-8000-00000000000a";

type FakeSocket = { url: string; push: (ev: Event) => void };

function fakeSockets(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let closeResolve!: () => void;
    const socket: SimplepushWebSocket = {
      closed: new Promise<void>((resolve) => { closeResolve = resolve; }),
      async *messages() {
        while (true) {
          if (queue.length > 0) { yield queue.shift()!; continue; }
          if (closed) return;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
      close() {
        closed = true;
        closeResolve();
        wake?.();
      },
    };
    sockets.push({
      url,
      push: (ev) => {
        queue.push(JSON.stringify(ev));
        const w = wake;
        wake = null;
        w?.();
      },
    });
    return socket;
  };
  return { factory, sockets };
}

// The Personal Password salt, fetched once to decrypt submissions.
const userFetch = (async () =>
  new Response(JSON.stringify({ userId: "u", passwordSalt: "salt" }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

function submissionEvent(version: number, text: string, createdAt = "2026-07-03T10:00:00Z"): Event {
  return {
    eventType: "SubmissionCreated",
    version,
    createdAt,
    data: { type: "submissionCreated", submission: { id: `sbm_${version}`, body: { type: "text", value: text }, createdAt } },
  } as unknown as Event;
}

function completedEvent(version: number): Event {
  return { eventType: "TaskCompleted", version, createdAt: "2026-07-03T10:01:30Z", data: { type: "taskCompleted", taskId: TASK, inputsUploaded: [] } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("submissions() connection", () => {
  test("without since it shares one socket with task streams", async () => {
    const { factory, sockets } = fakeSockets();
    const client = new Client({ apiToken: "tok", fetch: userFetch, webSocketFactory: factory });
    const group = client.watchTaskGroup({ groupId: "grptsk_1", members: [{ taskId: TASK }] });

    const subs = client.submissions()[Symbol.asyncIterator]();
    const firstSub = subs.next();
    const inputs = group.inputs()[Symbol.asyncIterator]();
    const firstInput = inputs.next();
    await tick();

    expect(sockets.length).toBe(1);
    sockets[0]!.push(submissionEvent(1, "pump 3 is leaking", new Date(Date.now() + 1000).toISOString()));
    sockets[0]!.push(completedEvent(2));

    const sub = await firstSub;
    expect(sub.done).toBe(false);
    expect(sub.value!.body).toEqual({ kind: "text", text: "pump 3 is leaking" });
    expect((await firstInput).value!.item.kind).toBe("taskCompleted");
    expect(sockets.length).toBe(1);
    await subs.return?.();
    await inputs.return?.();
  });

  test("with since it opens a connection of its own that starts there", async () => {
    const { factory, sockets } = fakeSockets();
    const client = new Client({ apiToken: "tok", fetch: userFetch, webSocketFactory: factory });
    const subs = client.submissions({ since: "2026-07-01T00:00:00Z" })[Symbol.asyncIterator]();
    const first = subs.next();
    await tick();

    expect(sockets.length).toBe(1);
    expect(new URL(sockets[0]!.url).searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    sockets[0]!.push(submissionEvent(1, "old"));
    expect((await first).value!.body).toEqual({ kind: "text", text: "old" });
    await subs.return?.();
  });

  test("the caller's signal ends the stream without an error", async () => {
    const { factory } = fakeSockets();
    const client = new Client({ apiToken: "tok", fetch: userFetch, webSocketFactory: factory });
    const ac = new AbortController();
    const seen: unknown[] = [];
    const done = (async () => { for await (const s of client.submissions({ signal: ac.signal })) seen.push(s); })();
    await tick();
    ac.abort();
    await done;
    expect(seen).toEqual([]);
  });

  test("a rejected API token surfaces as an HttpError with its status", async () => {
    // With a Personal Password the stream first fetches the password salt.
    const rejected = (async () =>
      new Response('{"error":"authorization_error","msg":"Invalid API token"}', { status: 401 })) as typeof fetch;
    const { factory, sockets } = fakeSockets();
    const client = new Client({ apiToken: "revoked", passwords: "personal-pw", fetch: rejected, webSocketFactory: factory });
    let caught: unknown;
    try {
      for await (const _ of client.submissions()) { /* nothing arrives */ }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect([err.method, err.path, err.status]).toEqual(["GET", "/v1/user", 401]);
    expect(err.body).toContain("Invalid API token");
    expect(sockets.length).toBe(0);
  });

  test("idleMs ends a stream that never receives anything", async () => {
    const { factory } = fakeSockets();
    const client = new Client({ apiToken: "tok", fetch: userFetch, webSocketFactory: factory });
    const started = Date.now();
    for await (const _ of client.submissions({ idleMs: 50 })) { /* nothing arrives */ }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("with since the caller's signal ends the stream without an error", async () => {
    const { factory } = fakeSockets();
    const client = new Client({ apiToken: "tok", fetch: userFetch, webSocketFactory: factory });
    const ac = new AbortController();
    const seen: unknown[] = [];
    const done = (async () => {
      for await (const s of client.submissions({ since: "2026-07-01T00:00:00Z", signal: ac.signal })) seen.push(s);
    })();
    await tick();
    ac.abort();
    await done;
    expect(seen).toEqual([]);
  });

  test("with since idleMs ends a stream that never receives anything", async () => {
    const { factory } = fakeSockets();
    const client = new Client({ apiToken: "tok", fetch: userFetch, webSocketFactory: factory });
    const started = Date.now();
    for await (const _ of client.submissions({ since: "2026-07-01T00:00:00Z", idleMs: 50 })) { /* nothing arrives */ }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("without since a backfill for an earlier send delivers no earlier submissions", async () => {
    const { factory, sockets } = fakeSockets();
    const client = new Client({ apiToken: "tok", fetch: userFetch, webSocketFactory: factory });
    // The earlier send moves the shared connection's start back to its send time.
    client.watchTaskGroup({ groupId: "grptsk_1", createdAt: "2026-07-01T00:00:00Z", members: [{ taskId: TASK }] });

    const subs = client.submissions()[Symbol.asyncIterator]();
    const first = subs.next();
    await tick();

    sockets[0]!.push(submissionEvent(1, "before the call", "2026-07-02T00:00:00Z"));
    sockets[0]!.push(submissionEvent(2, "after the call", new Date(Date.now() + 1000).toISOString()));
    expect((await first).value!.body).toEqual({ kind: "text", text: "after the call" });
    await subs.return?.();
  });
});
