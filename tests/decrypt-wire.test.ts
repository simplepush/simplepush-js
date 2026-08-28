// Field-schema decryption: seals a payload exactly the way the send side
// does, then asserts the wire decryptors open precisely the sealed fields
// and nothing else, however ciphertext-like the plaintext neighbors look.

import { describe, expect, test } from "bun:test";

import { decryptEvent, decryptSubmission, decryptTaskPayload, decryptTaskSummary } from "../src/decrypt-wire.js";
import { encrypt } from "../src/crypto.js";
import { Keyring } from "../src/keyring.js";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const FP = "test-fp";
const MARKER = { type: "personal", keyFingerprint: FP } as const;
const ring = await Keyring.build({ passwords: [], topics: [], personalKeys: [{ symmetricKey: KEY, fingerprint: FP }] });
const e = (s: string) => encrypt(KEY, s);

// 64 hex chars of pure base64 alphabet: plaintext that must survive untouched.
const CHECKSUM = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
const BASE64ISH_ANSWER = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQyNDI0Mg==";

describe("decryptTaskPayload", () => {
  test("opens exactly the sealed fields and leaves plaintext lookalikes alone", async () => {
    const payload = {
      id: "tsk_x",
      title: await e("Pool pH check"),
      content: await e("Log the readings"),
      status: "pending",
      encryption: MARKER,
      attachments: [{ type: "link", url: await e("https://example.com/manual") }],
      inputs: [
        { type: "text", id: "inp_1", required: true, description: await e("Pressure (bar)"), defaultValue: await e("7") },
        { type: "choice", id: "inp_2", required: true, options: [await e("Yes"), await e("No")], multi: false },
        {
          type: "actions",
          id: "inp_3",
          required: true,
          actions: [{ key: await e("ok"), label: await e("Done"), style: "primary" }],
        },
        { type: "slider", id: "inp_4", required: true, encrypted: await e(JSON.stringify({ min: 0, max: 14, step: 0.5, unit: "pH" })) },
        { type: "photo", id: "inp_5", required: false },
      ],
      uploads: [
        { type: "textUploaded", id: "inp_1", value: await e("8.5") },
        { type: "fileUploaded", id: "inp_5", filename: "report.pdf", checksumSha256: CHECKSUM, objectKey: CHECKSUM },
      ],
      replies: [
        {
          id: "rpl_1",
          authorPublicUserId: "usr_a",
          body: { type: "text", value: await e("All good") },
          encryption: MARKER,
          createdAt: "2026-08-27T10:00:00Z",
        },
      ],
      declines: [{ by: "usr_b", reason: "other", note: await e("On vacation"), encryption: MARKER, declinedAt: "2026-08-27T10:00:00Z" }],
    };

    const { value, undecryptable } = await decryptTaskPayload(payload, ring);
    const p = value as any;
    expect(undecryptable).toBe(0);
    expect(p.title).toBe("Pool pH check");
    expect(p.content).toBe("Log the readings");
    expect(p.encryption).toBeUndefined();
    expect(p.attachments[0].url).toBe("https://example.com/manual");
    expect(p.inputs[0].description).toBe("Pressure (bar)");
    expect(p.inputs[0].defaultValue).toBe("7");
    expect(p.inputs[1].options).toEqual(["Yes", "No"]);
    expect(p.inputs[2].actions[0]).toEqual({ key: "ok", label: "Done", style: "primary" });
    expect(p.inputs[3]).toMatchObject({ min: 0, max: 14, step: 0.5, unit: "pH" });
    expect(p.inputs[3].encrypted).toBeUndefined();
    expect(p.uploads[0].value).toBe("8.5");
    expect(p.uploads[1].checksumSha256).toBe(CHECKSUM);
    expect(p.uploads[1].objectKey).toBe(CHECKSUM);
    expect(p.replies[0].body.value).toBe("All good");
    expect(p.declines[0].note).toBe("On vacation");
  });

  test("plaintext payload passes through untouched, even base64-looking answers", async () => {
    const payload = {
      id: "tsk_y",
      title: "Plain",
      status: "pending",
      inputs: [],
      uploads: [{ type: "textUploaded", id: "inp_1", value: BASE64ISH_ANSWER }],
    };
    const { value, undecryptable } = await decryptTaskPayload(payload, ring);
    expect(undecryptable).toBe(0);
    expect((value as any).uploads[0].value).toBe(BASE64ISH_ANSWER);
  });

  test("a sealed field under an unheld key is counted, not mangled", async () => {
    const foreign = await encrypt(OTHER_KEY, "secret");
    const payload = { id: "tsk_z", title: foreign, status: "pending", encryption: { type: "personal", keyFingerprint: "unknown-fp" } };
    const { value, undecryptable } = await decryptTaskPayload(payload, ring);
    expect(undecryptable).toBe(1);
    expect((value as any).title).toBe(foreign);
  });

  test("an upload's own marker wins over the payload's", async () => {
    const payload = {
      id: "tsk_r",
      title: await e("t"),
      status: "pending",
      encryption: MARKER,
      uploads: [{ type: "textUploaded", id: "inp_1", value: await e("rotated"), encryption: MARKER }],
    };
    const { value, undecryptable } = await decryptTaskPayload(payload, ring);
    expect(undecryptable).toBe(0);
    expect((value as any).uploads[0].value).toBe("rotated");
    expect((value as any).uploads[0].encryption).toBeUndefined();
  });
});

describe("decryptTaskSummary", () => {
  test("title and tag", async () => {
    const { value, undecryptable } = await decryptTaskSummary(
      { taskId: "tsk_s", title: await e("Sealed title"), tag: await e("safety"), topic: "alerts", status: "pending", recipients: [], subtasks: {}, inputs: ["text"], encryption: MARKER },
      ring,
    );
    expect(undecryptable).toBe(0);
    expect((value as any).title).toBe("Sealed title");
    expect((value as any).tag).toBe("safety");
    expect((value as any).topic).toBe("alerts");
    expect((value as any).inputs).toEqual(["text"]);
  });
});

describe("decryptSubmission", () => {
  test("body and location under the entry marker", async () => {
    const { value, undecryptable } = await decryptSubmission(
      {
        id: "sbm_1",
        body: { type: "text", value: await e("pump 3 leaking") },
        location: { encrypted: await e(JSON.stringify({ latitude: 48.1, longitude: 11.5 })) },
        createdAt: "2026-08-27T09:00:00Z",
      },
      ring,
      MARKER,
    );
    expect(undecryptable).toBe(0);
    expect((value as any).body.value).toBe("pump 3 leaking");
    expect((value as any).location).toMatchObject({ latitude: 48.1, longitude: 11.5 });
  });
});

describe("decryptEvent", () => {
  test("per-type field maps: answer, reply, notification, cancel note", async () => {
    const answer = await decryptEvent(
      {
        version: 1,
        type: "TaskInputCompleted",
        encryption: MARKER,
        data: { type: "taskInputCompleted", taskId: "tsk_1", inputUploaded: { type: "choiceSelected", id: "inp_1", selectedIndex: 0, selectedValue: await e("Yes") } },
      },
      ring,
    );
    expect(answer.undecryptable).toBe(0);
    expect((answer.value as any).data.inputUploaded.selectedValue).toBe("Yes");

    const reply = await decryptEvent(
      { version: 2, type: "ReplyAppended", encryption: MARKER, data: { type: "replyAppended", reply: { id: "rpl_1", body: { type: "text", value: await e("On it") } } } },
      ring,
    );
    expect((reply.value as any).data.reply.body.value).toBe("On it");

    const ntf = await decryptEvent(
      { version: 3, type: "NotificationCompleted", encryption: MARKER, data: { type: "notificationCompleted", notificationId: "ntf_1", reply: { type: "actions", selectedKey: await e("ack") } } },
      ring,
    );
    expect((ntf.value as any).data.reply.selectedKey).toBe("ack");

    const cancel = await decryptEvent(
      { version: 4, type: "TaskCanceled", encryption: MARKER, data: { type: "taskCanceled", taskId: "tsk_1", reason: "canceled", note: await e("Sent by mistake") } },
      ring,
    );
    expect((cancel.value as any).data.note).toBe("Sent by mistake");
    expect((cancel.value as any).data.reason).toBe("canceled");
  });

  test("unencrypted events pass through, unknown types untouched", async () => {
    const ev = { version: 5, type: "TaskCompleted", data: { type: "taskCompleted", taskId: "tsk_1", inputsUploaded: [{ type: "textUploaded", id: "i", value: BASE64ISH_ANSWER }] } };
    const { value, undecryptable } = await decryptEvent(ev, ring);
    expect(undecryptable).toBe(0);
    expect((value as any).data.inputsUploaded[0].value).toBe(BASE64ISH_ANSWER);
  });
});
