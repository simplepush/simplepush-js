// `GET /v1/user` — credential-authenticated lookup that returns just enough for
// senders/CLI clients to build a decryption keyring without holding a device
// bearer. The api_token rides in an `API-Token` header (wire convention shared
// with the events WebSocket); a bearer credential passes `authHeaders` instead.
// The endpoint is scope-free on the backend, so any live token reaches it.

export interface UserInfoResponse {
  userId: string;
  // Raw wire shape: the backend OMITS the key for a non-org account (zio-json
  // drops None fields) — which is the normal case, since API-Tokens are always
  // personal accounts. It never sends `organizationId: null`.
  organizationId?: string | null;
  passwordSalt: string;
}

export interface FetchUserInfoOptions {
  baseUrl: URL;
  /** API-Token credential. Supply this or `authHeaders`, not both. */
  apiToken?: string;
  /** Pre-built credential headers, for bearer-authenticated callers. */
  authHeaders?: Record<string, string>;
  fetch: typeof fetch;
}

export async function fetchUserInfo(opts: FetchUserInfoOptions): Promise<UserInfoResponse> {
  const url = new URL("v1/user", opts.baseUrl);
  const res = await opts.fetch(url.toString(), {
    method: "GET",
    headers: {
      ...(opts.authHeaders ?? (opts.apiToken !== undefined ? { "API-Token": opts.apiToken } : {})),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /v1/user failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  return (await res.json()) as UserInfoResponse;
}
