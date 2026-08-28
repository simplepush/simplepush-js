// Org integration tokens: `spi_<credential>.<seed>`, minted by `sp integration
// create`. The credential half is the bearer for the org surface; the seed half
// never leaves the process — it derives the X25519 keypair the org admin
// wrapped the master keys to, so only the token holder can open them.

import _sodium from "libsodium-wrappers-sumo";

import { HttpError } from "./errors.js";
import type { OrgMasterKey } from "./keyring.js";

export type IntegrationToken = { credential: string; seed: Uint8Array };

let readyPromise: Promise<typeof _sodium> | null = null;
async function sodium(): Promise<typeof _sodium> {
  if (!readyPromise) readyPromise = _sodium.ready.then(() => _sodium);
  return readyPromise;
}

/** Splits a token on its FIRST dot: the credential half is base64url (dot-free)
 * by construction, and no base64 variant emits a dot, so the separator is
 * unambiguous. */
export async function parseIntegrationToken(raw: string): Promise<IntegrationToken> {
  const s = await sodium();
  const trimmed = raw.trim();
  const dot = trimmed.indexOf(".");
  if (!trimmed.startsWith("spi_") || dot <= 0 || dot === trimmed.length - 1) {
    throw new Error("an integration token looks like spi_<credential>.<seed> — the exact string `sp integration create` printed");
  }
  let seed: Uint8Array;
  try {
    seed = s.from_base64(trimmed.slice(dot + 1), s.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new Error("the seed half of the integration token is not valid base64url; was the token truncated?");
  }
  if (seed.length !== 32) throw new Error(`the seed half of the integration token must decode to 32 bytes, got ${seed.length}`);
  return { credential: trimmed.slice(0, dot), seed };
}

/** Wire shape of GET /v1/org/integration/keys (mirrors the backend's
 * IntegrationKeysResponse, which itself mirrors what member devices fetch). */
type IntegrationKeysWire = {
  enabled: boolean;
  adminPubkeyB64?: string;
  wrappedKeys?: { version: number; blob: string }[];
};

/** Fetches the master keys the org admin wrapped to this integration and opens
 * them with the seed-derived keypair. `crypto_box_open_easy` also AUTHENTICATES
 * the admin: a blob not wrapped by the holder of the admin private key fails
 * the tag check against the pinned admin pubkey, so the backend cannot forge
 * wraps. Returns [] when the org has no encryption enabled. */
export async function fetchOrgMasterKeys(baseUrl: URL, token: IntegrationToken, fetchImpl: typeof fetch = fetch): Promise<OrgMasterKey[]> {
  const s = await sodium();
  const path = "v1/org/integration/keys";
  const resp = await fetchImpl(new URL(path, baseUrl), { headers: { Authorization: `Bearer ${token.credential}` } });
  if (!resp.ok) throw new HttpError("GET", path, resp.status, await resp.text().catch(() => ""));
  const body = (await resp.json()) as IntegrationKeysWire;
  if (!body.enabled || !body.adminPubkeyB64) return [];

  const adminPubkey = s.from_base64(body.adminPubkeyB64, s.base64_variants.ORIGINAL);
  const keypair = s.crypto_box_seed_keypair(token.seed);
  const nonceBytes = s.crypto_box_NONCEBYTES;
  const keys: OrgMasterKey[] = [];
  for (const wrap of body.wrappedKeys ?? []) {
    const blob = s.from_base64(wrap.blob, s.base64_variants.ORIGINAL);
    if (blob.length <= nonceBytes) throw new Error(`wrapped org master key v${wrap.version} is truncated`);
    // Throws on tag mismatch: a wrap not made by the org admin for THIS
    // integration is an error worth dying on, not skipping.
    const key = s.crypto_box_open_easy(blob.slice(nonceBytes), blob.slice(0, nonceBytes), adminPubkey, keypair.privateKey);
    keys.push({ version: wrap.version, key });
  }
  return keys;
}
