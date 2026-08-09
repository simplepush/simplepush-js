// Retry-path coverage for the create endpoints: 503s and network errors are
// resent under the SAME idempotency key; non-retryable statuses surface
// immediately. No network — fake fetches script the failure sequences.

import { describe, expect, test } from "bun:test";
import { createTask } from "../src/tasks.js";
import { defaultRetryPolicy, fetchWithRetry, mintIdempotencyKey } from "../src/retry.js";

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const fastPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

describe("fetchWithRetry", () => {
  test("retries 503 and succeeds", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 3 ? new Response("down", { status: 503 }) : okJson({ ok: true });
    }) as typeof fetch;
    const resp = await fetchWithRetry(f, "http://test/", {}, fastPolicy);
    expect(resp.status).toBe(200);
    expect(calls).toBe(3);
  });

  test("retries network errors and honors Retry-After on 503", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      if (calls === 2) return new Response("down", { status: 503, headers: { "Retry-After": "0" } });
      return okJson({ ok: true });
    }) as typeof fetch;
    const resp = await fetchWithRetry(f, "http://test/", {}, fastPolicy);
    expect(resp.status).toBe(200);
    expect(calls).toBe(3);
  });

  test("retries 409 idempotency_in_flight but not other 409s", async () => {
    let calls = 0;
    const inFlight = () =>
      new Response(JSON.stringify({ error: "idempotency_in_flight", msg: "..." }), { status: 409 });
    const f = (async () => {
      calls++;
      return calls === 1 ? inFlight() : okJson({ ok: true });
    }) as typeof fetch;
    const resp = await fetchWithRetry(f, "http://test/", {}, fastPolicy);
    expect(resp.status).toBe(200);
    expect(calls).toBe(2);

    let otherCalls = 0;
    const g = (async () => {
      otherCalls++;
      return new Response(JSON.stringify({ error: "task_canceled", msg: "..." }), { status: 409 });
    }) as typeof fetch;
    const conflict = await fetchWithRetry(g, "http://test/", {}, fastPolicy);
    expect(conflict.status).toBe(409);
    expect(otherCalls).toBe(1);
  });

  test("gives up after maxAttempts and returns the last 503", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("down", { status: 503 });
    }) as typeof fetch;
    const resp = await fetchWithRetry(f, "http://test/", {}, fastPolicy);
    expect(resp.status).toBe(503);
    expect(calls).toBe(3);
  });
});

describe("idempotency keys on creates", () => {
  test("createTask mints a key and resends the SAME one across retries", async () => {
    const bodies: { idempotencyKey?: string }[] = [];
    let calls = 0;
    const f = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      bodies.push(JSON.parse(init!.body as string));
      return calls < 2 ? new Response("down", { status: 503, headers: { "Retry-After": "0" } }) : okJson({ taskId: "tsk_x" });
    }) as typeof fetch;
    await createTask({
      baseUrl: new URL("http://test/"),
      body: { inputs: [], links: [], files: [], autoCommit: true, topic: "t" },
      fetch: f,
    });
    expect(bodies.length).toBe(2);
    expect(bodies[0]!.idempotencyKey).toBeDefined();
    expect(bodies[1]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey);
  });

  test("a caller-supplied key wins over the minted one", async () => {
    const bodies: { idempotencyKey?: string }[] = [];
    const f = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return okJson({ taskId: "tsk_x" });
    }) as typeof fetch;
    await createTask({
      baseUrl: new URL("http://test/"),
      body: { inputs: [], links: [], files: [], autoCommit: true, topic: "t", idempotencyKey: "my-key" },
      fetch: f,
    });
    expect(bodies[0]!.idempotencyKey).toBe("my-key");
  });

  test("mintIdempotencyKey is UUID-shaped and unique", () => {
    const a = mintIdempotencyKey();
    const b = mintIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });

  test("default policy waits out a realistic failover window", () => {
    // 1+2+4+8+16 = 31s of backoff across 6 attempts.
    const total = Array.from({ length: defaultRetryPolicy.maxAttempts - 1 }, (_, i) =>
      Math.min(defaultRetryPolicy.baseDelayMs * 2 ** i, defaultRetryPolicy.maxDelayMs),
    ).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(30000);
  });
});
