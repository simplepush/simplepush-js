// Per-answer encryption markers: an upload record's own marker (aggregate
// completion events) wins over the envelope's (single-answer events).

import { describe, expect, test } from "bun:test";
import { wrapInput, type Decryptor, type TaskCompleted, type InputEvent, type TextUpload } from "../src/event-views.js";
import type { Event } from "../src/events.js";

// Echoes which marker decrypted the value — proves marker routing.
const echoDec: Decryptor = async (marker, value) => {
  if (value === undefined || marker === undefined) return value;
  const id = marker.type === "personal" ? marker.keyFingerprint : `v${marker.v}`;
  return `dec[${id}]:${value}`;
};

describe("upload marker routing", () => {
  test("aggregate completion decrypts each record under its own marker (empty envelope)", async () => {
    const ev = {
      eventType: "TaskCompleted",
      data: {
        type: "taskCompleted",
        taskId: "tsk-1",
        inputsUploaded: [
          { type: "textUploaded", id: "inp-1", value: "ct1", encryption: { type: "personal", keyFingerprint: "fp-v4" } },
          { type: "textUploaded", id: "inp-2", value: "ct2", encryption: { type: "personal", keyFingerprint: "fp-v5" } },
        ],
      },
    } as unknown as Event;
    const done = (await wrapInput(ev, echoDec)) as TaskCompleted;
    expect(done.uploads.map((u) => (u as TextUpload).value)).toEqual(["dec[fp-v4]:ct1", "dec[fp-v5]:ct2"]);
  });

  test("a single-answer event decrypts under the envelope marker", async () => {
    const ev = {
      eventType: "TaskInputCompleted",
      encryption: { type: "personal", keyFingerprint: "fp-answer" },
      data: {
        type: "taskInputCompleted",
        taskId: "tsk-1",
        inputUploaded: { type: "textUploaded", id: "inp-1", value: "ct" },
      },
    } as unknown as Event;
    const item = (await wrapInput(ev, echoDec)) as InputEvent;
    expect((item.uploads[0] as TextUpload).value).toBe("dec[fp-answer]:ct");
  });
});
