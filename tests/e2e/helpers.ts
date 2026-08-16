// Live e2e helpers. Tests in this directory hit a REAL backend and skip
// entirely unless the environment points at a disposable dev backend:
//
//   SP_E2E_BASE_URL=http://localhost:8000 SP_E2E_API_TOKEN=... bun test tests/e2e
//
// Optional: SP_E2E_TOPIC (topic tests skip without it). The suites bring their
// own throwaway client-side passwords — nothing needs to be set in the app;
// every account has a server-issued password_salt from creation, and key
// fingerprints on the encryption markers keep test keys and any app-held
// passwords from conflicting.
//
// Oracles (task creation appends NO event — /ws/v1/events carries only
// recipient-action events like inputs/completion/cancel):
//   - send shape & at-rest encryption: the sender-side read GET /v1/tasks/{id}
//   - what actually left the client: a capturing fetch wrapper
//   - lifecycle events (cancel/complete/...): the events stream via findEvent

import type { Client } from "../../src/index.js";
import type { Event } from "../../src/events.js";

export const BASE = process.env.SP_E2E_BASE_URL;
export const TOKEN = process.env.SP_E2E_API_TOKEN;
export const TOPIC = process.env.SP_E2E_TOPIC;
export const enabled = Boolean(BASE && TOKEN);

export const secret = () => `e2e-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

/** ISO timestamp safely before "now" — the replay cursor for actions taken in
 * the same test. Capture it BEFORE acting. */
export const sinceNow = () => new Date(Date.now() - 5_000).toISOString();

/** Sender-side read of a task: the at-rest payload as the server stores it. */
export async function senderRead(taskId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/v1/tasks/${taskId}`, { headers: { "API-Token": TOKEN! } });
  if (!res.ok) throw new Error(`sender read of ${taskId} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function sha256b64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** A fetch that records the raw bodies of presigned PUT uploads — the exact
 * bytes that land in storage — then forwards to the real fetch. */
export function capturingPutFetch(captured: Array<{ url: string; body: Uint8Array }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT" && init.body) {
      const bytes =
        init.body instanceof Uint8Array
          ? new Uint8Array(init.body)
          : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      captured.push({ url: String(input), body: bytes });
    }
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
}

/** A fetch that records JSON request bodies for URLs matching `pathPart`, then
 * forwards to the real fetch — asserts what the SDK actually sent. */
export function capturingFetch(pathPart: string, captured: unknown[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body && String(input).includes(pathPart)) {
      try {
        captured.push(JSON.parse(String(init.body)));
      } catch {
        captured.push(String(init.body));
      }
    }
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
}

/** Replays the client's event stream from `since` until an event matches, the
 * timeout fires, or the stream errors. Only lifecycle events exist here —
 * never use this to observe a send. */
export async function findEvent(
  client: Client,
  since: string,
  pred: (ev: Event) => boolean,
  timeoutMs = 20_000,
): Promise<Event> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const seen: string[] = [];
  try {
    for await (const ev of client.events({ since, signal: ac.signal })) {
      if (pred(ev)) return ev;
      seen.push(ev.eventType);
    }
  } catch (e) {
    if (!ac.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`no matching event within ${timeoutMs}ms; saw types: ${seen.join(", ")}`);
}
