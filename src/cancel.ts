// Sender-side cancellation. Three POSTs — task, subtask, task group — all
// addressed by ID under the sender credential (API-Token / Api-Key), unlike
// append, which rides a capability token. The request body is flat:
// `{reason, note?, supersededBy?}`; the group endpoint answers with the
// `{canceled, skipped}` counts, the other two with an empty 200.

import { HttpError } from "./errors.js";
import type { CancelGroupResult, CancelRequestBody } from "./types.js";

type CancelCallOptions = {
  baseUrl: URL;
  body: CancelRequestBody;
  /** Auth headers: the sender credential — the API-Token for personal sends,
   * the org Api-Key for org sends. */
  authHeaders?: Record<string, string>;
  fetch?: typeof fetch;
};

async function postCancel(path: string, opts: CancelCallOptions): Promise<unknown> {
  const f = opts.fetch ?? fetch;
  const url = new URL(path, opts.baseUrl).toString();
  const resp = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.authHeaders ?? {}) },
    body: JSON.stringify(opts.body),
  });
  if (!resp.ok) {
    throw new HttpError("POST", path, resp.status, await resp.text().catch(() => ""));
  }
  const text = await resp.text().catch(() => "");
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export async function cancelTask(opts: CancelCallOptions & { taskId: string }): Promise<void> {
  await postCancel(`v1/tasks/${encodeURIComponent(opts.taskId)}/cancel`, opts);
}

export async function cancelSubtask(opts: CancelCallOptions & { subtaskId: string }): Promise<void> {
  await postCancel(`v1/subtasks/${encodeURIComponent(opts.subtaskId)}/cancel`, opts);
}

export async function cancelTaskGroup(opts: CancelCallOptions & { groupId: string }): Promise<CancelGroupResult> {
  const resp = (await postCancel(`v1/task-groups/${encodeURIComponent(opts.groupId)}/cancel`, opts)) as
    | { canceled?: number; skipped?: number }
    | undefined;
  return { canceled: resp?.canceled ?? 0, skipped: resp?.skipped ?? 0 };
}
