// `GET /v1/user` — api-token-authenticated lookup that returns just enough for
// senders/CLI clients to build a decryption keyring without holding a device
// bearer. Wire convention matches the events WebSocket: the api_token rides in
// an `API-Token` header rather than `Authorization`.

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
  apiToken: string;
  fetch: typeof fetch;
}

export async function fetchUserInfo(opts: FetchUserInfoOptions): Promise<UserInfoResponse> {
  const url = new URL("v1/user", opts.baseUrl);
  const res = await opts.fetch(url.toString(), {
    method: "GET",
    headers: {
      "API-Token": opts.apiToken,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /v1/user failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  return (await res.json()) as UserInfoResponse;
}
