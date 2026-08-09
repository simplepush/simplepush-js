// Task creation. `createTask` POSTs to /v1/tasks/json; the returned
// `Task` handle (see handles.ts) streams the task's events off the shared
// multiplexed event hub.

import { HttpError } from "./errors.js";
import { fetchWithRetry, mintIdempotencyKey } from "./retry.js";
import type { CreateTaskRequest, CreateTaskResponse } from "./types.js";

export type CreateTaskOptions = {
  baseUrl: URL;
  body: CreateTaskRequest;
  /** Auth headers: the sender credential — the API-Token for personal sends,
   * the org Api-Key for org member/broadcast sends. */
  authHeaders?: Record<string, string>;
  fetch?: typeof fetch;
};

export async function createTask(opts: CreateTaskOptions): Promise<CreateTaskResponse> {
  const f = opts.fetch ?? fetch;
  const url = new URL("v1/tasks/json", opts.baseUrl).toString();
  // One key per logical create: every retry resends it, so a create that
  // committed before the connection died is replayed, never duplicated.
  const body: CreateTaskRequest = { idempotencyKey: mintIdempotencyKey(), ...opts.body };
  const resp = await fetchWithRetry(f, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.authHeaders ?? {}) },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new HttpError("POST", "v1/tasks/json", resp.status, await resp.text().catch(() => ""));
  }
  return (await resp.json()) as CreateTaskResponse;
}
