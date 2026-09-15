# Test the native Codex bridge

This is a working single-computer milestone. The native TypeScript bridge
supports named agents, Slack mentions, thread replies, explicit sharing and
restart recovery. Each agent currently runs through the bridge computer's
Codex account. A shared Slack app routing to different people's computers is
the next milestone, not a feature available in this checkout yet.

## Checks anyone can run now

Use Node 22.12 or later and an existing Codex installation. No Codex installer,
tmux or Slack Desktop application is required.

```sh
git clone https://github.com/chikingsley/SlackAgentBridge.git
cd SlackAgentBridge
npm ci
npm test
npm run typecheck
npm run check
```

All tests live under `tests/`. The TypeScript bridge uses Vitest. The separate
legacy shell/Node suite runs with `npm run test:legacy` on macOS or Linux;
`npm run test:all` runs both. Tests use disposable directories and stub services.
They do not send Slack messages or use real Codex inference.

To check an existing Codex task without running a prompt or importing history:

```sh
npm run direct -- --probe --thread YOUR_TASK_ID --codex /path/to/codex
```

The metadata probe is read-only. `--attach` additionally checks whether the
native task is available to another App Server client; a desktop-owned task
may reject that request with an active-writer error.

Report the operating system, Node and Codex versions, failing command, and
redacted error. Do not send credentials, configuration dumps or chat histories.

## Live Slack test

Coordinate with the person operating the bridge before starting a live test.
Use only an explicitly designated private test channel and authorized tester
IDs. The operator must enable each tester in `allowedUserIds` and invite them
to that channel. A tester then creates their own test agent using the commands
in [the agent hub guide](agent-hub.md).

Verify creation, a named mention, a plain thread reply, separate context for a
second agent, and a reply after a controlled bridge restart. Confirm replies
stay in the designated Slack thread. Current shared-hub tests exercise the
operator computer's Codex account, not the tester's own account.

Do not run a second bridge with the shared app's Socket Mode token. For a
completely independent end-to-end installation today, use a separate test Slack
app, separate tokens, a private test channel, and your own Codex login.

## Next milestone: one Slack app, separate owner accounts

The central gateway will retain the sole Slack connection. Each owner runs a
small local connector that opens an authenticated outbound connection to that
gateway and uses their own Codex login. The connector must explicitly register
the selected agent/task; it must not enumerate or upload chat history.

Before asking another person to install that connector, implement and verify:

1. Owner-bound pairing and revocation, with separate connector credentials.
2. Routing by authenticated owner, connector and exact Codex task; no fallback
   to another person's machine or account when a connector is unavailable.
3. Durable request IDs, acknowledgments, offline status and restart recovery
   without replaying uncertain prompts.
4. Return-path binding to the originating Slack thread, and owner-only approvals.
5. A two-computer private-channel test proving independent accounts and context.

The legacy node modules may provide reusable authentication and transport
pieces. Their existence does not mean the native hub already supports remote
execution. The owner/context policy is described in the
[collaboration proposal](personal-agent-collaboration-draft.md).
