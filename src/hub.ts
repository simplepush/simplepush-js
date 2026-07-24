// Demux hub: one multiplexed `/ws/v1/events` connection, many entity subscribers.
//
// Mirrors the Python SDK's `_Hub`. It reads the stream once (via `streamEvents`,
// which already handles reconnect/backoff and throws on permanent 4xx), fans each
// event out to the handles that care about it — matched by `routingId` (task
// chain root or notification id) — and buffers per entity from the moment a send
// registers it, so a consumer that subscribes a beat later still sees everything.
//
// Lifecycle is reference-counted: the socket opens when the first stream is
// iterated and closes when the last one ends or is abandoned. Nothing to close
// by hand.

import type { Event } from "./events.js";
import { routingId } from "./events.js";
import { streamEvents } from "./streams/events-stream.js";
import type { WebSocketFactory } from "./ws.js";

export type EventHubConfig = {
  baseUrl: URL;
  /** `/ws/v1/events` (personal) or `/ws/v1/events/organization` (org). */
  path: string;
  authHeaders: Record<string, string>;
  webSocketFactory?: WebSocketFactory;
  onReconnect?: (attempt: number, backoffMs: number, lastError: Error | undefined) => void;
};

/** What a consumer mailbox carries: a sequenced event, or a fatal stream error
 * that should be thrown into the consumer's `for await` instead of hanging. */
type Delivered = { seq: number; event: Event } | { error: Error };

/** Single-consumer async mailbox (the `adaptWs` push/pull pattern, the TS analog
 * of Python's per-consumer `asyncio.Queue`). `get(signal)` rejects if `signal`
 * aborts while waiting, and detaches its own listener so a later `put` is never
 * lost to a dead resolver. */
class Mailbox {
  private buf: Delivered[] = [];
  private resolve: ((v: Delivered) => void) | null = null;

  put(item: Delivered): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r(item);
    } else {
      this.buf.push(item);
    }
  }

  get(signal: AbortSignal): Promise<Delivered> {
    const queued = this.buf.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<Delivered>((res, rej) => {
      const onAbort = () => {
        if (this.resolve === wrapped) this.resolve = null;
        rej(abortReason(signal));
      };
      const wrapped = (item: Delivered) => {
        signal.removeEventListener("abort", onAbort);
        res(item);
      };
      this.resolve = wrapped;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

const RING_MAX = 2000;

/** Sentinel returned by `next()` when an idle timeout fires (vs. a real item). */
const IDLE = Symbol("idle");

type EntityBuffer = { ring: Array<{ seq: number; event: Event }>; consumers: Set<Mailbox> };

export class EventHub {
  private buffers = new Map<string, EntityBuffer>();
  private rawConsumers = new Set<Mailbox>();
  private since: string | undefined;
  // Global de-dup watermark. The reconnect cursor (`since`) is inclusive, so the
  // boundary event re-arrives after a drop; backend versions are monotonic per
  // stream, so dropping anything at/under the high-water version removes the dupe.
  private lastVersion = Number.NEGATIVE_INFINITY;
  private seq = 0;
  private consumers = 0;
  private runner: AbortController | null = null;
  private failed: Error | null = null;

  constructor(private readonly cfg: EventHubConfig) {}

  /** Start buffering this entity's events now (the send-then-subscribe race).
   * Lowering `since` so the run loop replays from the earliest registered send. */
  registerEntity(id: string, createdAt?: string): void {
    if (!this.buffers.has(id)) this.buffers.set(id, { ring: [], consumers: new Set() });
    if (createdAt && (this.since === undefined || createdAt < this.since)) this.since = createdAt;
  }

  close(): void {
    this.stopRunner();
  }

  // --- consumer streams (public) ---

  /** Async iterator over one entity's events (deduped, in order). `replay` emits
   * the buffered backlog first; `idleMs` ends the stream after that many ms of
   * silence; `signal` cancels it (the iterator then throws AbortError). */
  async *attach(
    id: string,
    opts: { replay?: boolean; signal?: AbortSignal; idleMs?: number } = {},
  ): AsyncIterableIterator<Event> {
    this.ensureRunning();
    const buf = this.bufferFor(id);
    const mailbox = new Mailbox();
    buf.consumers.add(mailbox);
    this.consumers++;
    if (this.failed) mailbox.put({ error: this.failed });

    const snapshot = opts.replay ? [...buf.ring] : [];
    let lastSeq = snapshot.length ? snapshot[snapshot.length - 1]!.seq : 0;
    try {
      for (const item of snapshot) yield item.event;
      while (true) {
        const delivered = await this.next(mailbox, opts.idleMs, opts.signal);
        if (delivered === IDLE) return;
        if ("error" in delivered) throw delivered.error;
        if (delivered.seq <= lastSeq) continue; // already replayed from the snapshot
        lastSeq = delivered.seq;
        yield delivered.event;
      }
    } finally {
      if (buf.consumers.delete(mailbox)) this.release();
    }
  }

  /** Async iterator over the full multiplexed feed (manual inspection). */
  async *attachRaw(opts: { signal?: AbortSignal } = {}): AsyncIterableIterator<Event> {
    this.ensureRunning();
    const mailbox = new Mailbox();
    this.rawConsumers.add(mailbox);
    this.consumers++;
    if (this.failed) mailbox.put({ error: this.failed });
    try {
      while (true) {
        const delivered = await this.next(mailbox, undefined, opts.signal);
        if (delivered === IDLE) return;
        if ("error" in delivered) throw delivered.error;
        yield delivered.event;
      }
    } finally {
      if (this.rawConsumers.delete(mailbox)) this.release();
    }
  }

  // --- internals ---

  private bufferFor(id: string): EntityBuffer {
    let buf = this.buffers.get(id);
    if (!buf) {
      buf = { ring: [], consumers: new Set() };
      this.buffers.set(id, buf);
    }
    return buf;
  }

  /** Await the next item, giving up after `idleMs` of silence (returns IDLE) and
   * propagating a user abort (throws). A fresh idle timer per call makes `idleMs`
   * a silence timeout, matching Python's `asyncio.wait_for(q.get(), timeout)`. */
  private async next(mailbox: Mailbox, idleMs: number | undefined, userSignal: AbortSignal | undefined): Promise<Delivered | typeof IDLE> {
    const ac = new AbortController();
    let idle = false;
    const onUserAbort = () => ac.abort(userSignal!.reason);
    if (userSignal) {
      if (userSignal.aborted) ac.abort(userSignal.reason);
      else userSignal.addEventListener("abort", onUserAbort, { once: true });
    }
    const timer = idleMs !== undefined ? setTimeout(() => { idle = true; ac.abort(); }, idleMs) : undefined;
    try {
      return await mailbox.get(ac.signal);
    } catch (err) {
      if (idle) return IDLE;
      throw err; // user abort
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
    }
  }

  private release(): void {
    this.consumers--;
    if (this.consumers <= 0) {
      this.consumers = 0;
      this.stopRunner();
    }
  }

  private stopRunner(): void {
    if (this.runner) {
      this.runner.abort();
      this.runner = null;
    }
  }

  private ensureRunning(): void {
    // Don't restart after an unrecoverable failure — it would just hit the same
    // error again. A fresh client gets a fresh hub.
    if (this.failed) return;
    if (!this.runner) {
      this.runner = new AbortController();
      void this.run(this.runner.signal);
    }
  }

  private fail(err: Error): void {
    this.failed = err;
    for (const m of this.rawConsumers) m.put({ error: err });
    for (const buf of this.buffers.values()) for (const m of buf.consumers) m.put({ error: err });
  }

  private dispatch(ev: Event): void {
    if (ev.version !== undefined) {
      if (ev.version <= this.lastVersion) return; // reconnect dupe
      this.lastVersion = ev.version;
    }
    this.seq++;
    const item = { seq: this.seq, event: ev };
    for (const m of this.rawConsumers) m.put(item);
    const rid = routingId(ev);
    if (rid !== undefined) {
      const buf = this.buffers.get(rid);
      if (buf) {
        buf.ring.push(item);
        if (buf.ring.length > RING_MAX) buf.ring.shift();
        for (const m of buf.consumers) m.put(item);
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      for await (const ev of streamEvents({
        baseUrl: this.cfg.baseUrl,
        path: this.cfg.path,
        authHeaders: this.cfg.authHeaders,
        ...(this.since !== undefined ? { since: this.since } : {}),
        ...(this.cfg.webSocketFactory ? { webSocketFactory: this.cfg.webSocketFactory } : {}),
        signal,
        ...(this.cfg.onReconnect ? { onReconnect: this.cfg.onReconnect } : {}),
      })) {
        if (ev.createdAt) this.since = ev.createdAt; // persist resume cursor
        this.dispatch(ev);
      }
    } catch (err) {
      if (signal.aborted) return; // stopped on purpose (last consumer left)
      this.fail(err as Error); // permanent: streamEvents throws on a 4xx handshake
    }
  }
}
