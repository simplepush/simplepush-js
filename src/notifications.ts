// Notification creation. `createNotification` POSTs to /v1/notifications/json;
// the returned `Notification` handle (see handles.ts) streams its single
// completion event off the shared multiplexed event hub.

import { HttpError } from "./errors.js";
import type { CreateNotificationRequest, CreateNotificationResponse } from "./types.js";

export type CreateNotificationOptions = {
  baseUrl: URL;
  body: CreateNotificationRequest;
  /** Auth headers: the sender credential — the API-Token for personal sends,
   * the org Api-Key for org member/broadcast sends. */
  authHeaders?: Record<string, string>;
  fetch?: typeof fetch;
};

export async function createNotification(opts: CreateNotificationOptions): Promise<CreateNotificationResponse> {
  const f = opts.fetch ?? fetch;
  const url = new URL("v1/notifications/json", opts.baseUrl).toString();
  const resp = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.authHeaders ?? {}) },
    body: JSON.stringify(opts.body),
  });
  if (!resp.ok) {
    throw new HttpError("POST", "v1/notifications/json", resp.status, await resp.text().catch(() => ""));
  }
  // Flat untagged union — the DEFAULT is the group shape; `shared:true` gets the
  // single-notification shape (discriminated by presence of `groupId`).
  return (await resp.json()) as CreateNotificationResponse;
}
