// Subtask append. `createSubtask` POSTs to /v1/subtasks/json; the returned
// `Subtask` handle (see handles.ts) streams the subtask's events off the shared
// multiplexed event hub, scoped within the parent task's chain.

import { HttpError } from "./errors.js";
import type { CreateSubtaskRequest, CreateSubtaskResponse } from "./types.js";

export type CreateSubtaskOptions = {
  baseUrl: URL;
  body: CreateSubtaskRequest;
  /** Auth headers: the sender credential — the API-Token for personal sends,
   * the org Api-Key for org sends. */
  authHeaders?: Record<string, string>;
  fetch?: typeof fetch;
};

export async function createSubtask(opts: CreateSubtaskOptions): Promise<CreateSubtaskResponse> {
  const f = opts.fetch ?? fetch;
  const url = new URL("v1/subtasks/json", opts.baseUrl).toString();
  const resp = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.authHeaders ?? {}) },
    body: JSON.stringify(opts.body),
  });
  if (!resp.ok) {
    throw new HttpError("POST", "v1/subtasks/json", resp.status, await resp.text().catch(() => ""));
  }
  return (await resp.json()) as CreateSubtaskResponse;
}
