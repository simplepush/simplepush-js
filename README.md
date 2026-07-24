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
`sendNotification` (a single text/choice/actions input, no replies). Both take a
single options object; the send target (`topic` for a personal `Client`, or
`topic` / `member` / `broadcast` on an `OrgClient`) lives in that object. Omit
the target on a personal `Client` to send to your own devices (a note-to-self;
encrypted under the account default password when one is configured).

> **Ids are type-prefixed strings.** `taskId`, `subtaskId`, input/reply/file ids
> and the like come back type-tagged — `tsk_…`, `sub_…`, `inp_…`, `rfl_…` — not
> bare UUIDs.

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

// A notification: lighter — a single input, one completion event. A personal
// topic send defaults to independent mode, so this returns a NotificationGroup
// (pass `shared: true` to get one shared Notification instead).
const notifGroup = await client.sendNotification({
  topic: "deploys",
  title: "Build failed",
  content: "main @ a1b2c3 failed 3 tests",
  input: { type: "choice", options: ["ack", "mute"] },
});
for await (const ev of notifGroup.inputs()) {
  console.log(ev.item.reply); // NotificationTextReply | NotificationChoiceReply | NotificationActionReply | undefined
}
```

Task inputs: `text`, `choice` (set `multi: true`, with optional
`minSelections`/`maxSelections`), `actions` (styled buttons; the tapped
action's stable `key` comes back), `slider` (`min`/`max`/`step`/`unit`),
`photo`, `voiceRecording`, `file`, `location`. A notification input is `text`,
`choice`, or `actions`; a notification can also carry ONE media item — `image`
(iOS + Android) or `audio` (iOS only), an uploaded `FileAttachment` or a URL
string — and `critical: true` (iOS Critical Alert).

```ts
// Richer inputs: action buttons, a slider, multi-choice, a photo request.
const incident = await client.sendTask({
  topic: "ops",
  title: "Incident 4711",
  inputs: [
    { type: "actions", required: true, actions: [
      { key: "ack", label: "Acknowledge", style: "primary" },
      { key: "escalate", label: "Escalate", style: "destructive" },
    ]},
    { type: "slider", min: 0, max: 10, step: 1, unit: "sev", required: true },
    { type: "choice", options: ["db", "api", "infra"], multi: true, required: false },
    { type: "photo", required: false },
  ],
});
for await (const ev of incident.inputs()) {
  if (ev.item.kind !== "taskCompleted") continue;
  for (const u of ev.item.uploads) {
    if (u.kind === "action") console.log(ev.recipient?.name, "pressed", u.key);
    if (u.kind === "slider") console.log("severity", u.value);
    if (u.kind === "multiChoice") console.log("areas", u.values);
    if (u.kind === "photo") await u.save("./incident-4711");
  }
}
```

By default each filled input arrives as an intermediate `input` event, then the
terminal `taskCompleted` carries the full committed set; `autoCommit: false`
has the recipient submit the whole form at once instead. Other send options:
`reply: "one-shot" | "sticky" | "one-time-per-user"` opts recipients into the
in-thread reply composer (collect via `replies()`), and
`contentFormat: "markdown"` renders `content` as Markdown.

**Attachments.** `files` uploads local files alongside a task/subtask
(encrypted when the send is); the SDK is environment-agnostic, so you pass the
bytes. A notification takes its single media item the same way, or as a URL:

```ts
import { readFile } from "node:fs/promises";

await client.sendTask({
  topic: "reports",
  title: "Q3 numbers",
  content: "Full report attached.",
  files: [{ filename: "q3.pdf", data: await readFile("q3.pdf"), contentType: "application/pdf" }],
});
await client.sendNotification({ topic: "alerts", title: "Door cam", image: "https://cam.example/last.jpg" });
```

Streams accept `{ replay, idleMs, signal }`: `replay` emits the buffered backlog
since the send, `idleMs` ends the stream after that many ms of silence, and
`signal` cancels it.

**File downloads.** The binary upload objects (photo/voice/file uploads and a
reply's `photo`/`file`/`audio`) are download handles bound to the client that yielded
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

**Encryption.** Pass `password` per send to encrypt the
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

Pass `shared: true` to `sendTask` for shared mode — ONE task all
recipients see and answer together, returned as a plain `Task`.

`activity()` (on `Task` and `TaskGroup`) merges input events AND replies over
one subscription. To collect from a FRESH process, rebuild an observe-only
handle from persisted ids: `client.watchTaskGroup({ groupId, createdAt,
members })` / `client.watchNotificationGroup(...)` — same streams, but no
tokens and no `append()`; pass `createdAt` to backfill everything since the
send.

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
`since` (ISO 8601) resumes from that point, backfilling earlier submissions;
`idleMs` ends the stream after that many ms of silence; `signal` cancels it.

Encrypted submissions are decrypted with your **account default password** (not
a topic password). Pass it in `passwords` (a bare string):

```ts
const client = new Client({ apiToken: TOKEN, passwords: "your-default-password" });
```

Or pass it per call (personal `Client` only): `client.submissions({ password })`
overrides the account password for that call.

## Organizations

`OrgClient` authenticates with the org `apiKey` and addresses sends with
exactly one target: `{ topic }`, `{ member }` (by member name), or
`{ broadcast: true }`. Encryption is automatic: pass the org's master key(s)
(from your org's encryption vault; the SDK can't derive them) and every send is
encrypted under the current key — there are no per-send passwords. Without
keys, sends go out in the clear and org ciphertext is left as-is.

```ts
import { OrgClient } from "@simplepush/sdk";

const org = new OrgClient({
  apiKey: process.env.SP_API_KEY!,
  orgMasterKey: masterKeyBytes,   // Uint8Array(32)
  orgMasterKeyVersion: 3,         // or several: orgMasterKeys: [{ version, key }]
});

const group = await org.sendTask({
  broadcast: true,
  title: "All hands?",
  inputs: [{ type: "choice", options: ["yes", "no"], required: true }],
});
for await (const ev of group.inputs()) {
  console.log(ev.recipient?.name, ev.item.kind); // recipient = the org member
}
```

Everything else works as on a personal `Client`: independent-mode groups (the
member handle/name rides on each instance's `recipient`), subtasks, streams,
submissions, downloads.
