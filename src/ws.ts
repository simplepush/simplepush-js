// Lightweight WebSocket abstraction so callers can plug in a custom factory
// (browser, Bun, custom transport). Default uses the `ws` package which works
// on Node and Bun and supports per-request headers — required for sending
// API-Token / Wait-Token on the upgrade.

import WS from "ws";

export type SimplepushWebSocket = {
  /** Resolves once the socket is closed. */
  closed: Promise<void>;
  /** Async iterator over decoded text frames. Binary/ping/pong frames are skipped. */
  messages(): AsyncIterableIterator<string>;
  close(): void;
};

export type WebSocketFactory = (url: string, init: { headers: Record<string, string> }) => SimplepushWebSocket;

export const defaultWebSocketFactory: WebSocketFactory = (url, init) => {
  const sock = new WS(url, { headers: init.headers });
  return adaptWs(sock);
};

function adaptWs(sock: WS): SimplepushWebSocket {
  type Frame = { kind: "msg"; text: string } | { kind: "end"; reason?: string } | { kind: "error"; err: Error };
  const queue: Frame[] = [];
  let waiter: ((f: Frame) => void) | null = null;

  const push = (f: Frame) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(f);
    } else {
      queue.push(f);
    }
  };

  let closed = false;
  let closeResolve!: () => void;
  const closedPromise = new Promise<void>((res) => { closeResolve = res; });

  sock.on("message", (data, isBinary) => {
    if (isBinary) return;
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
    push({ kind: "msg", text });
  });
  sock.on("close", (_code, reason) => {
    if (closed) return;
    closed = true;
    push({ kind: "end", reason: reason?.toString("utf8") });
    closeResolve();
  });
  sock.on("error", (err) => {
    push({ kind: "error", err });
  });

  async function* messages(): AsyncIterableIterator<string> {
    while (true) {
      const next: Frame = queue.length > 0
        ? queue.shift()!
        : await new Promise<Frame>((res) => { waiter = res; });
      if (next.kind === "msg") yield next.text;
      else if (next.kind === "end") return;
      else throw next.err;
    }
  }

  return {
    closed: closedPromise,
    messages,
    close: () => {
      try { sock.close(); } catch { /* ignore */ }
      // The server side doesn't always answer the close frame, and `ws` then
      // holds the socket (and the node event loop) for its 30s close timeout.
      // The caller is done with the connection — allow a short grace for a
      // clean handshake, then force-terminate. Node-only; the timer is
      // unref'd so it never keeps the process alive itself.
      const terminate = (sock as { terminate?: () => void }).terminate;
      if (typeof terminate === "function") {
        const timer = setTimeout(() => { try { terminate.call(sock); } catch { /* ignore */ } }, 1_000);
        (timer as { unref?: () => void }).unref?.();
      }
    },
  };
}
