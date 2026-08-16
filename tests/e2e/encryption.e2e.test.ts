// Same-SDK encryption round-trips against a live backend.
//
// Sends are asserted via the sender-side read (at-rest payload) and, for
// appends, via a capturing fetch (the exact bytes the SDK put on the wire) —
// task creation appends no event, so the events stream is NOT an oracle here.

import { expect, test } from "bun:test";
import { Client, decrypt, tryDecryptEventData } from "../../src/index.js";
import type { EncryptionMarker } from "../../src/index.js";
import {
  BASE,
  TOKEN,
  TOPIC,
  capturingFetch,
  enabled,
  findEvent,
  secret,
  senderRead,
  sinceNow,
} from "./helpers.js";

const t = test.skipIf(!enabled);
const tTopic = test.skipIf(!enabled || !TOPIC);

t("encrypted self-send is ciphertext at rest and decrypts with the keyring", async () => {
  const s = secret();
  const sender = new Client({ apiToken: TOKEN!, baseUrl: BASE!, passwords: "e2e-pw" });
  try {
    const task = await sender.sendTask({ content: `note ${s}` });

    const read = await senderRead(task.taskId);
    expect(JSON.stringify(read)).not.toContain(s);
    const marker = read.encryption as EncryptionMarker | undefined;
    expect(marker?.type).toBe("personal");

    const keyring = await sender.keyring({ includePasswordSalt: true });
    const key = keyring.keyForMarker(marker!);
    expect(key).toBeTruthy();
    expect(await decrypt(key!, read.content as string)).toContain(s);
  } finally {
    sender.close();
  }
}, 60_000);

t("stateless append encrypts under the self-send key (2026-08-05 regression)", async () => {
  const s = secret();
  const captured: unknown[] = [];
  const sender = new Client({
    apiToken: TOKEN!,
    baseUrl: BASE!,
    passwords: "e2e-pw",
    fetch: capturingFetch("/v1/subtasks", captured),
  });
  try {
    const task = await sender.sendTask({ content: "append parent" });
    const read = await senderRead(task.taskId);
    const parentMarker = read.encryption as EncryptionMarker;
    expect(parentMarker?.type).toBe("personal");

    const res = await sender.appendSubtask({ appendToken: task.appendToken, content: `child ${s}` });
    expect(JSON.stringify(res)).toMatch(/sub_/);

    // The server accepted it; now assert what actually left the client.
    expect(captured.length).toBe(1);
    const body = JSON.stringify(captured[0]);
    expect(body).not.toContain(s);
    expect(body).toContain(parentMarker.keyFingerprint);
  } finally {
    sender.close();
  }
}, 60_000);

t("appendSubtask rejects password without topic", async () => {
  const sender = new Client({ apiToken: TOKEN!, baseUrl: BASE! });
  try {
    expect(
      sender.appendSubtask({ appendToken: "at_e2e_dummy", password: "pw", content: "x" }),
    ).rejects.toThrow(/password requires a topic/);
  } finally {
    sender.close();
  }
});

t("encrypted cancel note round-trips the events stream", async () => {
  // Cancel IS an event (unlike creation) — this doubles as coverage that the
  // events oracle itself works.
  const s = secret();
  const since = sinceNow();
  const sender = new Client({ apiToken: TOKEN!, baseUrl: BASE!, passwords: "e2e-pw" });
  const keyless = new Client({ apiToken: TOKEN!, baseUrl: BASE! });
  try {
    const task = await sender.sendTask({ content: "cancel target" });
    await task.cancel({ note: `why ${s}` });

    const ev = await findEvent(
      keyless,
      since,
      (e) => (e.taskId ?? (e.data as { taskId?: string } | undefined)?.taskId) === task.taskId,
    );
    expect(JSON.stringify(ev)).not.toContain(s);

    const keyring = await sender.keyring({ includePasswordSalt: true });
    const dec = await tryDecryptEventData(ev, keyring);
    expect(JSON.stringify(dec ?? {})).toContain(s);
  } finally {
    sender.close();
    keyless.close();
  }
}, 60_000);

tTopic("topic-key send and append decrypt for a fresh client", async () => {
  const s = secret();
  const captured: unknown[] = [];
  const sender = new Client({
    apiToken: TOKEN!,
    baseUrl: BASE!,
    passwords: [["e2e-topic-pw", TOPIC!]],
    fetch: capturingFetch("/v1/subtasks", captured),
  });
  try {
    const sent = await sender.sendTask({ topic: TOPIC!, content: `t ${s}` });
    const first = (sent.instances ?? [sent])[0] as { taskId: string };

    const read = await senderRead(first.taskId);
    expect(JSON.stringify(read)).not.toContain(s);
    const marker = read.encryption as EncryptionMarker;

    // A FRESH client configured with the same (password, topic) pair — not the
    // sender's in-memory key cache — must be able to derive the key.
    const reader = new Client({
      apiToken: TOKEN!,
      baseUrl: BASE!,
      passwords: [["e2e-topic-pw", TOPIC!]],
    });
    try {
      const keyring = await reader.keyring();
      const key = keyring.keyForMarker(marker);
      expect(key).toBeTruthy();
      expect(await decrypt(key!, read.content as string)).toContain(s);
    } finally {
      reader.close();
    }

    await sender.appendSubtask({ appendToken: sent.appendToken, topic: TOPIC!, content: `child ${s}` });
    expect(captured.length).toBe(1);
    const body = JSON.stringify(captured[0]);
    expect(body).not.toContain(s);
    expect(body).toContain(marker.keyFingerprint);
  } finally {
    sender.close();
  }
}, 90_000);
