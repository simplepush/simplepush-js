# @simplepush/sdk

TypeScript SDK for [Simplepush](https://simplepu.sh).

ESM-only. Targets Node 20+, Bun, Deno, and modern browsers (browser usage requires a custom `webSocketFactory` since the standard `WebSocket` API can't send headers).

## Install

```sh
bun add @simplepush/sdk
# or
npm install @simplepush/sdk
```

## Quick start

```ts
import { Client } from "@simplepush/sdk";

const client = new Client({
  apiToken: process.env.SP_API_TOKEN!,  // required
  passwords: [["hunter2", "my-topic"]],         // [password, topic] pairs; or "account-pw" for the default
});

for await (const event of client.events({ since: new Date(Date.now() - 86_400_000).toISOString() })) {
  console.log(event);
}
```

## Sending

Two parallel aggregates: `sendTask` (multiple inputs, replies) and
`sendNotification` (a single choice/text input, no replies). Both take a single
options object; the send target (`topic` for a personal `Client`, or `topic` /
`member` / `broadcast` on an `OrgClient`) lives in that object.

Each send returns a **handle** that streams its events off one shared,
multiplexed `/ws/v1/events` connection (demuxed by id) — the SDK never opens the
per-resource WebSocket endpoints. Iterating a handle opens the connection; it
closes when the last stream ends. Receiving requires the client's `apiToken`
(personal) / `apiKey` (org).

> **Ids are type-prefixed strings.** `taskId`, `subtaskId`, input/reply/file ids
> and the like come back type-tagged — `tsk_…`, `sub_…`, `inp_…`, `rfl_…` — not
> bare UUIDs. The SDK treats them as opaque: pass them straight back to the SDK
> (downloads, etc.). Don't parse a UUID out of them or assume a fixed length.

```ts
import { Client } from "@simplepush/sdk";

const client = new Client({ apiToken: process.env.SP_API_TOKEN! });

// A task send returns a TaskGroup: every recipient gets their OWN independent
// task instance (one recipient's answers never touch another's task).
const group = await client.sendTask({
  topic: "deploys",
  title: "Deploy v1.2.3?",
  inputs: [{ type: "choice", options: ["yes", "no"], required: true }],
});
const task = group.sole; // single-recipient topic; iterate group.instances for many
for await (const ev of task.inputs()) {
  if (ev.kind === "taskCompleted") console.log(ev.uploads);
}

// A notification: lighter — a single input, one completion event.
const note = await client.sendNotification({
  topic: "deploys",
  title: "Build failed",
  content: "main @ a1b2c3 failed 3 tests",
  input: { type: "choice", options: ["ack", "mute"] },
});
for await (const ev of note.inputs()) {
  console.log(ev.reply); // NotificationTextReply | NotificationChoiceReply | undefined
}
```

Streams accept `{ replay, idleMs, signal }`: `replay` emits the buffered backlog
since the send, `idleMs` ends the stream after that many ms of silence, and
`signal` cancels it.

**File downloads.** The binary upload objects (photo/voice/file uploads and a
reply's `photo`/`file`) are download handles bound to the client that yielded
them: `read()` returns the bytes (checksum-verified, decrypted on encrypted
chains), `save(path)` writes to disk (a directory uses the file's own name),
and `downloadUrl()` presigns the raw short-lived (~5 min) S3 URL. Downloads
authenticate with the client's `apiToken`/`apiKey` and are unlimited. Failures
throw `DownloadError`.

```ts
for await (const ev of task.inputs()) {
  if (ev.kind === "taskCompleted") {
    for (const u of ev.uploads) {
      if (u.kind === "photo") await u.save("./captures");
    }
  }
}
for await (const r of task.replies()) {
  if (r.kind === "reply" && r.photo) console.log(await r.photo.read());
}
```

**Encryption.** Pass `password` per send (the topic is the salt) to encrypt the
body; the returned handle decrypts the recipient's replies. Or configure the
client's `passwords` with `[password, topic]` pairs — sends to those topics
encrypt automatically (a per-send `password` overrides):

```ts
const client = new Client({ apiToken, passwords: [["hunter2", "deploys"]] });
await client.sendTask({ topic: "deploys", content: "🤫" });            // encrypted via the "deploys" pair
await client.sendTask({ topic: "other", content: "!", password: "x" }); // per-send password
```

A task can have **subtasks** appended to its chain. A subtask inherits the
parent's recipients and encryption (no target, no password); its `inputs()` /
`replies()` are scoped to it, and stream off the same shared connection.

```ts
const sub = await task.append({
  title: "One more thing",
  inputs: [{ type: "text", required: true }],
});
for await (const ev of sub.inputs()) {
  if (ev.kind === "subtaskCompleted") console.log(ev.uploads);
}
```

## Task groups

By default every recipient of a task send gets their own independent instance,
grouped under a `TaskGroup`:

```ts
const group = await client.sendTask({ topic: "deploys", content: "check in" });
group.groupId;          // grptsk_… — the group handle
for (const task of group.instances) {
  // a full per-recipient Task: its own taskId, appendToken, streams
  console.log(task.taskId, task.recipient?.publicId, task.recipient?.name);
}
```

`group.append(...)` appends a subtask to **every** member's chain atomically and
returns one `Subtask` per member; pass `instances: [taskId, …]` to reach only
some members. File attachments are uploaded ONCE for the whole batch — every
sibling subtask references the same attachment.

```ts
const subs = await group.append({ content: "follow-up" });                       // all members
await group.append({ content: "just you", instances: [group.instances[0]!.taskId] }); // a subset
```

Pass `shared: true` to `sendTask` for the legacy behavior — ONE task all
recipients see and answer together, returned as a plain `Task`.

## Submissions

A **submission** is self-authored user content — a text body plus an optional
photo and file — pushed into a user's own stream with no
associated task; a task reply without the task. Submissions are *created* by the
app; the SDK *observes* them on the client's feed (both `Client` and
`OrgClient`):

```ts
for await (const sub of client.submissions({ idleMs: 300_000 })) {
  // sub: Submission — body?: TextBody, photo?/file?: SubmissionFile
  if (sub.photo) await sub.photo.save("./inbox");
}
```

`photo`/`file`/`audio` are download handles (`read()` / `save()` / `downloadUrl()`). Audio attachments carry `durationSeconds` (voice-recording length in seconds). Location data (latitude, longitude, accuracy, altitude, heading, speed, timestamp) is provided inline via `location` when available; when the parent is encrypted it is decrypted with the same key as the body.
`idleMs` ends the stream after that many ms of silence; `signal` cancels it.

Encrypted submissions are sealed with the **personal default key** — your account
default password plus the account's server-issued salt (not a topic);
`submissions()` derives it for you (fetching the salt via `GET /v1/user`). Pass
the default password in `passwords` (a bare string) to decrypt them:

```ts
const client = new Client({ apiToken: TOKEN, passwords: "your-default-password" });
```

Or pass it per call (personal `Client` only): `client.submissions({ password })`
overrides the account password for that call.

## Crypto pipeline

`sha256(salt) → Argon2id(password) → HKDF-SHA256 → AES-256-GCM(32 bytes)`. Fingerprint is `base64(sha256(symmetric_key)[0:8])`. Ciphertext is `base64(12-byte nonce || ciphertext || 16-byte auth tag)`. Same wire format as the Rust client and existing receivers.

Argon2id runs via `hash-wasm` (WebAssembly); everything else uses Web Crypto.
