// Connect to the WebSocket events stream and yield each parsed event,
// reconnecting transparently across transient drops (network blips, pod
// restarts, server 5xx, rate limits) and resuming from the last-seen cursor.
// A permanent failure — the server refusing the handshake with a 4xx (bad or
// expired token, forbidden, unknown endpoint) — is thrown to the caller instead
// of retried forever. Mirrors the Python hub's behaviour.

import type { Event } from "../events.js";
import { toWsScheme } from "../url.js";
import { defaultWebSocketFactory, type WebSocketFactory } from "../ws.js";
import { INITIAL_BACKOFF_MS, isPermanentWsError, nextBackoff, sleep } from "./reconnect.js";

export type EventStreamOptions = {
  baseUrl: URL;
  /** WS endpoint path: `/ws/v1/events` (personal) or
   * `/ws/v1/events/organization` (org). */
  path: string;
  /** Auth headers for the WS handshake: `API-Token` (personal) or
   * `Api-Key` (org). */
  authHeaders: Record<string, string>;
  since?: string;
  webSocketFactory?: WebSocketFactory;
  signal?: AbortSignal;
  /** Called before each reconnect after a transient drop, so callers can log /
   * surface the blip. `lastError` is undefined when the server closed cleanly. */
  onReconnect?: (attempt: number, backoffMs: number, lastError: Error | undefined) => void;
};

export async function* streamEvents(opts: EventStreamOptions): AsyncIterableIterator<Event> {
  const factory = opts.webSocketFactory ?? defaultWebSocketFactory;
  let since = opts.since;
  // Resume version paired with `since`. The `since` window is inclusive
  // (created_at >= since), so on reconnect we also send `after_version` to skip
  // the boundary event we already yielded. Undefined until the first event.
  let afterVersion: number | undefined;
  let backoff = INITIAL_BACKOFF_MS;
  let attempt = 0;

  while (true) {
    if (opts.signal?.aborted) return;

    let ws;
    try {
      ws = factory(eventsWsUrl(opts.baseUrl, opts.path, since, afterVersion).toString(), { headers: opts.authHeaders });
    } catch (err) {
      // Factory itself failed (e.g. invalid URL) — fatal, don't retry.
      throw err;
    }
    if (opts.signal) {
      if (opts.signal.aborted) { ws.close(); return; }
      opts.signal.addEventListener("abort", () => ws.close(), { once: true });
    }

    let lastError: Error | undefined;
    try {
      for await (const text of ws.messages()) {
        let event: Event;
        try { event = JSON.parse(text) as Event; }
        catch { continue; } // skip a malformed frame rather than tear the stream down
        if (event.createdAt) {
          // Resume cursor: created_at + its version move together so the next
          // reconnect skips exactly this event.
          since = event.createdAt;
          if (event.version !== undefined) afterVersion = event.version;
        }
        backoff = INITIAL_BACKOFF_MS;                  // a healthy frame resets backoff
        yield event;
      }
      // Server closed the stream cleanly — fall through and reconnect.
    } catch (err) {
      if (opts.signal?.aborted) return;
      lastError = err as Error;
      if (isPermanentWsError(lastError)) throw lastError;
    } finally {
      ws.close();
    }

    if (opts.signal?.aborted) return;
    attempt += 1;
    opts.onReconnect?.(attempt, backoff, lastError);
    try { await sleep(backoff, opts.signal); } catch { return; } // aborted during backoff
    backoff = nextBackoff(backoff);
  }
}

function eventsWsUrl(baseUrl: URL, path: string, since: string | undefined, afterVersion: number | undefined): URL {
  const url = toWsScheme(baseUrl);
  url.pathname = path;
  url.search = "";
  if (since) url.searchParams.set("since", since);
  if (afterVersion !== undefined) url.searchParams.set("after_version", String(afterVersion));
  return url;
}
