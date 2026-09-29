// How `submissions()` streams end and where they start. A fake socket factory
// records every connection the client opens.

import { describe, expect, test } from "bun:test";

import { Client } from "../src/index.js";
import type { Event } from "../src/events.js";
import type { SimplepushWebSocket, WebSocketFactory } from "../src/ws.js";

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

function submissionEvent(version: number, text: string): Event {
  return {
    eventType: "SubmissionCreated",
    version,
    createdAt: "2026-07-03T10:00:00Z",
    data: { type: "submissionCreated", submission: { id: `sbm_${version}`, body: { type: "text", value: text }, createdAt: "2026-07-03T10:00:00Z" } },
  } as unknown as Event;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("submissions() connection", () => {
  test("with since the connection starts there", async () => {
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

  test("idleMs ends a stream that never receives anything", async () => {
    const { factory } = fakeSockets();
    const client = new Client({ apiToken: "tok", fetch: userFetch, webSocketFactory: factory });
    const started = Date.now();
    for await (const _ of client.submissions({ idleMs: 50 })) { /* nothing arrives */ }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
