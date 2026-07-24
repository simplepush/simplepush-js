// Shared reconnect policy for the long-lived WebSocket streams. A failure is
// either permanent — the server actively refused us (a 4xx handshake) — and
// should surface to the caller, or transient (network drop, pod restart, 5xx,
// rate limit) and should be retried with capped backoff while resuming from the
// last-seen cursor. Mirrors the Python hub's classification.

export const INITIAL_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 30_000;

// 4xx codes worth retrying despite being client errors: request timeout, too
// early, and rate-limited. Every other 4xx is treated as permanent.
const RETRYABLE_4XX = new Set([408, 425, 429]);

/** HTTP status from a rejected WebSocket handshake, parsed from the `ws`
 * package's error message ("Unexpected server response: 401"). undefined for
 * non-handshake errors (socket drops, clean closes). */
export function handshakeStatus(err: Error | undefined): number | undefined {
  const m = err?.message?.match(/Unexpected server response:\s*(\d{3})/);
  return m ? Number(m[1]) : undefined;
}

/** True for failures that won't recover on retry: a 4xx handshake (auth/client
 * error). Network drops, server 5xx, and rate limits are transient. */
export function isPermanentWsError(err: Error | undefined): boolean {
  const code = handshakeStatus(err);
  return code !== undefined && code >= 400 && code < 500 && !RETRYABLE_4XX.has(code);
}

export function nextBackoff(current: number): number {
  return Math.min(current * 2, MAX_BACKOFF_MS);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}
