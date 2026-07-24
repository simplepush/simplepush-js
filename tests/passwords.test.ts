// The personal-client `passwords` config: [password, topic] pairs → topic keys,
// bare strings → account default passwords (derived against the server salt).

import { describe, expect, test } from "bun:test";

import { Client } from "../src/client.js";
import { deriveKey, encrypt } from "../src/crypto.js";

describe("Client `passwords` config", () => {
  test("a [password, topic] pair derives that topic key into the keyring", async () => {
    const client = new Client({ apiToken: "tok", passwords: [["topic-pw", "alerts"]] });
    const ring = await client.keyring();
    const dk = await deriveKey("topic-pw", "alerts");
    expect(ring.keyForMarker({ type: "personal", passwordFingerprint: dk.fingerprint })).toEqual(dk.symmetricKey);
  });

  test("a bare default password derives the account key when the salt is included", async () => {
    // No organizationId key: the backend omits it for personal accounts
    // (zio-json drops None fields) — it never sends `organizationId: null`.
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ userId: "u", passwordSalt: "server-salt" }), {
        status: 200,
      })) as typeof fetch;
    const client = new Client({ apiToken: "tok", passwords: "account-pw", fetch: fakeFetch });
    const ring = await client.keyring({ includePasswordSalt: true });
    const dk = await deriveKey("account-pw", "server-salt");
    expect(ring.keyForMarker({ type: "personal", passwordFingerprint: dk.fingerprint })).toEqual(dk.symmetricKey);
  });

  test("the account key is NOT derived without includePasswordSalt", async () => {
    const fakeFetch = (async () => {
      throw new Error("should not fetch /v1/user");
    }) as typeof fetch;
    const client = new Client({ apiToken: "tok", passwords: "account-pw", fetch: fakeFetch });
    const ring = await client.keyring(); // no salt → no /v1/user fetch
    const dk = await deriveKey("account-pw", "server-salt");
    expect(ring.keyForMarker({ type: "personal", passwordFingerprint: dk.fingerprint })).toBeUndefined();
  });

  test("invalid passwords entry throws", () => {
    expect(() => new Client({ apiToken: "tok", passwords: [123 as unknown as string] })).toThrow();
  });

  test("Client.submissions accepts a per-call password and returns a lazy iterator", () => {
    const client = new Client({ apiToken: "tok" }); // no configured default password
    const it = client.submissions({ password: "given-pw" });
    // Lazy: nothing connected/fetched at call time; it's an async iterator.
    expect(typeof (it as AsyncIterableIterator<unknown>)[Symbol.asyncIterator]).toBe("function");
  });

  test("encrypt/decrypt round-trips through a configured topic key", async () => {
    const client = new Client({ apiToken: "tok", passwords: [["pw", "deploys"]] });
    const ring = await client.keyring();
    const dk = await deriveKey("pw", "deploys");
    const ct = await encrypt(dk.symmetricKey, "secret");
    const key = ring.keyForMarker({ type: "personal", passwordFingerprint: dk.fingerprint });
    expect(key).toEqual(dk.symmetricKey);
    void ct;
  });
});
