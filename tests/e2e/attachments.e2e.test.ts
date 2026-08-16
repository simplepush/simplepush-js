// Attachment upload lifecycle against a live backend: presign -> PUT ->
// complete. The sender-read exposes `status: "uploaded"` plus the stored
// blob's metadata, and a capturing fetch on the presigned PUT shows the exact
// bytes that landed in storage — so this proves the stored-bytes truth without
// needing a sender-side download endpoint (which doesn't exist; the
// /v1/attachments/{id}/download-url surface is device-bearer only).

import { expect, test } from "bun:test";
import { Client } from "../../src/index.js";
import { BASE, TOKEN, capturingPutFetch, enabled, secret, senderRead, sha256b64 } from "./helpers.js";

const t = test.skipIf(!enabled);

type AttachmentView = {
  type: string;
  id: string;
  filename: string;
  contentType: string;
  size: number;
  checksumSha256: string;
  status: string;
};

t("plaintext attachment completes and stores the exact bytes", async () => {
  const data = new TextEncoder().encode(`attachment payload ${secret()}`);
  const puts: Array<{ url: string; body: Uint8Array }> = [];
  const sender = new Client({ apiToken: TOKEN!, baseUrl: BASE!, fetch: capturingPutFetch(puts) });
  try {
    const task = await sender.sendTask({
      content: "att plaintext",
      files: [{ filename: "e2e-att.txt", data, contentType: "text/plain" }],
    });

    const read = await senderRead(task.taskId);
    const att = (read.attachments as AttachmentView[])[0];
    expect(att.status).toBe("uploaded");
    expect(att.id).toMatch(/^att_/);
    expect(att.filename).toBe("e2e-att.txt");
    expect(att.contentType).toBe("text/plain");
    expect(att.size).toBe(data.length);
    expect(att.checksumSha256).toBe(await sha256b64(data));

    // The presigned PUT carried the original bytes verbatim.
    expect(puts.length).toBe(1);
    expect(puts[0]!.body).toEqual(data);
  } finally {
    sender.close();
  }
}, 60_000);

t("encrypted attachment stores ciphertext whose checksum matches the declared metadata", async () => {
  const data = new TextEncoder().encode(`sealed payload ${secret()}`);
  const puts: Array<{ url: string; body: Uint8Array }> = [];
  const sender = new Client({
    apiToken: TOKEN!,
    baseUrl: BASE!,
    passwords: "e2e-pw",
    fetch: capturingPutFetch(puts),
  });
  try {
    const task = await sender.sendTask({
      content: "att encrypted",
      files: [{ filename: "e2e-att-enc.bin", data, contentType: "application/octet-stream" }],
    });

    const read = await senderRead(task.taskId);
    expect((read.encryption as { type?: string })?.type).toBe("personal");
    const att = (read.attachments as AttachmentView[])[0];
    expect(att.status).toBe("uploaded");

    // What went to storage is ciphertext, and the declared metadata describes
    // THAT blob (size/checksum of the ciphertext, not the plaintext).
    expect(puts.length).toBe(1);
    const stored = puts[0]!.body;
    expect(stored).not.toEqual(data);
    expect(stored.length).toBeGreaterThan(data.length);
    expect(att.size).toBe(stored.length);
    expect(att.checksumSha256).toBe(await sha256b64(stored));
    expect(att.checksumSha256).not.toBe(await sha256b64(data));
  } finally {
    sender.close();
  }
}, 60_000);
