// OrgClient.fromIntegrationToken: the credential half authenticates, the seed
// half opens the admin's wraps, and the resulting client holds the org keys.

import { describe, expect, test } from "bun:test";
import _sodium from "libsodium-wrappers-sumo";

import { HttpError, OrgClient } from "../src/index.js";

type RecordedCall = { url: string; headers: Record<string, string> };

function fetchWith(status: number, body: unknown, calls: RecordedCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

async function mint() {
  await _sodium.ready;
  const s = _sodium;
  const seed = s.randombytes_buf(32);
  const integration = s.crypto_box_seed_keypair(seed);
  const admin = s.crypto_box_keypair();
  const master = s.randombytes_buf(32);
  const nonce = s.randombytes_buf(s.crypto_box_NONCEBYTES);
  const ct = s.crypto_box_easy(master, nonce, integration.publicKey, admin.privateKey);
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce);
  blob.set(ct, nonce.length);
  const token = `spi_cred123.${s.to_base64(seed, s.base64_variants.URLSAFE_NO_PADDING)}`;
  return {
    token,
    master,
    keys: { enabled: true, adminPubkeyB64: s.to_base64(admin.publicKey, s.base64_variants.ORIGINAL), wrappedKeys: [{ version: 1, blob: s.to_base64(blob, s.base64_variants.ORIGINAL) }] },
  };
}

describe("OrgClient.fromIntegrationToken", () => {
  test("unwraps the master keys with the seed and authenticates with the credential half", async () => {
    const { token, master, keys } = await mint();
    const calls: RecordedCall[] = [];
    const client = await OrgClient.fromIntegrationToken(token, { baseUrl: "http://backend.test", fetch: fetchWith(200, keys, calls) });
    expect(calls[0]!.url).toBe("http://backend.test/v1/org/integration/keys");
    expect(calls[0]!.headers.Authorization).toBe("Bearer spi_cred123");
    expect(client.bearerToken).toBe("spi_cred123");
    expect(client.orgEncryptionEnabled).toBe(true);
    const ring = await client.keyring();
    expect(ring.keyForMarker({ type: "org", v: 1 })).toEqual(master);
  });

  test("an org without encryption yields a plaintext client", async () => {
    const { token } = await mint();
    const client = await OrgClient.fromIntegrationToken(token, { baseUrl: "http://backend.test", fetch: fetchWith(200, { enabled: false }, []) });
    expect(client.orgEncryptionEnabled).toBe(false);
  });

  test("a rejected credential is an HttpError; a malformed token never reaches the network", async () => {
    const { token } = await mint();
    const calls: RecordedCall[] = [];
    await expect(OrgClient.fromIntegrationToken(token, { baseUrl: "http://backend.test", fetch: fetchWith(401, {}, calls) })).rejects.toBeInstanceOf(HttpError);
    await expect(OrgClient.fromIntegrationToken("spi_nodot", { fetch: fetchWith(200, {}, calls) })).rejects.toThrow(/spi_<credential>.<seed>/);
    expect(calls.length).toBe(1);
  });
});
