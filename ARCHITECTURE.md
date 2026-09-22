# Architecture

One Slack Socket Mode gateway routes explicit mentions and known reply roots to
registered local connectors. The gateway has no native execution backend.

Slack -> gateway -> authenticated HTTPS polling -> owner computer -> native
Codex App Server over stdio. Completed agent messages return to the gateway,
which validates the bound task, device and Slack reply destination.

`src/gateway/` owns explicit channel/member policy, pairing, registry, durable
reply roots, event deduplication, output destination checks and the loopback API.
`src/connector/` owns exact task selection, existing local Codex login, local
process lock, native session resume and polling. `src/direct/` contains the
native RPC client, per-task relay and delivery journal. `src/storage.ts` owns
atomic state writes and process locks. All tests are in `tests/` (Vitest).

Pairing invitations are random, hashed at rest, expire after ten minutes and
can be consumed once. A scoped device token binds one Slack owner and one
private channel. Only its connector can register its task IDs. Aliases cannot
be reassigned across devices or task IDs. Owners can share prompt access with
an authorized member, unshare or revoke the connector. Approval and stop
checks remain owner-only inside the local native relay.

The gateway persists accepted message IDs before adding transient jobs. Poll
claims a job once. A lost poll response is not replayed. Gateway restart drops
transient jobs and marks every computer offline until its next poll. Connector
restart resumes only explicitly registered tasks, never scans history. Native
turns belong to the exact relay that started them; unrelated turns and tool
output do not reach Slack. Output is durably claimed before the Slack API call.

This transport favors avoiding duplicate execution over automatic retries.
Operators must inspect uncertain work and send a new message. Bot events are
ignored by default. Exact configured bot collaborators require explicit mentions
and a durable per-thread turn budget. Local credentials
and task history remain on each connector. Prompt and output text passes through
the gateway and Slack; the gateway's state records routing IDs, not transcripts.

HTTPS must terminate before the loopback API. The deployed test route uses
Tailscale Serve; other HTTPS reverse proxies work. Only polling reconnects
automatically. OS service installation is outside the runtime.

An optional `appServerSocket` selects WebSocket RPC over the existing local Unix
control socket instead of starting another Codex process. The connector subscribes
only to its selected tasks. Shared desktop turns and approval requests remain
owned by their initiating client. A bridge turn becomes owned only after the
matching `turn/start` response; early events are buffered until that identity is
known. Shared-mode prompts queue in memory while the task is active and start
after completion. Disconnect drops pending in-memory work and preserves durable
delivery claims, maintaining the existing explicit-resubmission policy.
