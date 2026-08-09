// Transparent retry for the create endpoints. The backend rides out short
// database failovers internally and answers 503 + Retry-After (or 409
// idempotency_in_flight) when it can't; paired with the idempotency key each
// create module mints, resending is always safe — a create that actually
// committed is replayed by the backend, not repeated. Retries cover network
// errors, 503, and 409 idempotency_in_flight; every other status is the
// caller's to handle.

export type RetryPolicy = {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

/** 1s → 2s → 4s → 8s → 16s between attempts (~31s total wait): comfortably
 * outlasts a managed-Postgres failover without hanging a caller forever. */
export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
};

/** Idempotency key for one logical create: minted once per call and resent
 * unchanged on every retry of that call. */
export function mintIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // Hermes/older runtimes without crypto.randomUUID: RFC-4122-shaped fallback.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, policy: RetryPolicy, retryAfter: number | undefined): number {
  if (retryAfter !== undefined) return Math.min(retryAfter * 1000, policy.maxDelayMs);
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

function retryAfterSeconds(resp: Response): number | undefined {
  const header = resp.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function isIdempotencyInFlight(resp: Response): Promise<boolean> {
  if (resp.status !== 409) return false;
  try {
    const body = (await resp.clone().json()) as { error?: string };
    return body.error === "idempotency_in_flight";
  } catch {
    return false;
  }
}

/** `fetch` with the retry policy above. The request must be safe to resend —
 * for creates that means the body carries an idempotency key. */
export async function fetchWithRetry(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  policy: RetryPolicy = defaultRetryPolicy,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let resp: Response;
    try {
      resp = await f(url, init);
    } catch (e) {
      // Network-level failure (connection refused/reset, DNS): retryable.
      if (attempt >= policy.maxAttempts) throw e;
      await sleep(backoffMs(attempt, policy, undefined));
      continue;
    }
    const retryable = resp.status === 503 || (await isIdempotencyInFlight(resp));
    if (!retryable || attempt >= policy.maxAttempts) return resp;
    await sleep(backoffMs(attempt, policy, retryAfterSeconds(resp)));
  }
}
