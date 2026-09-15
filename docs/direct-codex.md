# Direct Codex connection

Direct mode runs on Windows and macOS with the existing Codex installation and
its existing login. It connects one private Slack channel to one explicitly
selected Codex task through `codex app-server --listen stdio://`. It does not
launch a Codex terminal UI, tmux, Ghostty, or a local HTTP server.

## Setup

From this fork's checkout, run `npm ci` once. The new adapter is TypeScript;
`npm run direct` builds it before starting it.

Copy `direct-agent.example.json` to `~/.config/ccs/direct-agent.json` and set:

- `threadId`: the single existing Codex task to connect.
- `channelId`: the private Slack channel's ID.
- `ownerId`: the Slack user allowed to send prompts and answer approvals.
- `codexPath` (optional): the existing Codex executable's path.
- `workspaceDomain` (optional): the exact Slack workspace hostname; when set,
  startup rejects credentials from any other workspace before attaching Codex.

Use the canonical [Slack app manifest](../slack/app-manifest.json), install the
app in your workspace, enable Socket Mode, and invite its bot to that private
channel. Supply `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` through the process
environment or the existing `~/.config/ccs/env` file. When using `--config PATH`,
the optional `env` file is read from that config's directory. Tokens are never
stored in the binding or passed to the Codex child process.

```sh
npm run direct -- --probe --thread YOUR_CODEX_TASK_ID
npm run direct -- --probe --attach --thread YOUR_CODEX_TASK_ID
npm run direct
```

The first probe checks the existing account and reads only the selected task's
metadata. The second tests whether that task can actually be resumed, without
starting a turn or fetching conversation history. No Slack credentials are
needed for either probe. Neither probe lists tasks or imports history.

Run direct mode as the sole Socket Mode consumer for its Slack app. It replaces
the legacy daemon for that app; the legacy macOS installer does not launch this
mode. A local lock prevents two direct consumers for the same app on this host.
After a crash, check the PID stored in the reported lock before removing it.

## Using the agent

Send ordinary text in the bound private channel. The bridge forwards it to the
selected Codex task and returns completed agent messages from that turn.
`/sab-status` and `/sab-stop` are supported; `sab status` and `sab stop` also
work as ordinary messages. Stop applies only to a turn started by this bridge.
The owner answers approval requests with `approve ID` or `deny ID`. Single
question requests support `answer ID your answer`.

Other users, other channels, bot messages, edited messages, historical turns,
tool output, and reasoning are not relayed. Files are explicitly rejected in
this first direct adapter. Multi-question forms and other client-only requests
report that they require a supported Codex client. Legacy team, automation,
provider-switching, App Home controls, and file delivery remain in the legacy
daemon; they have not been wired into direct mode.

The selected task's native model, instructions, working directory, sandbox and
approval settings are inherited. Direct mode does not force dangerous-mode
flags or copy another account's credentials or conversations. Desktop-only
client tools are not supplied by starting a separate App Server.

## Desktop ownership and delivery

Codex permits only one active writer for a task. If the desktop app owns the
selected task, direct attachment fails with `already has an active writer`.
The bridge does not kill that writer, rewrite the rollout, or create a duplicate
task. A metadata probe succeeding does not imply that attachment will succeed.
Release that task from its current writer, or bind an existing task that is not
owned by another client. The desktop's private stdio connection cannot be
attached to by this separate process.

Delivery IDs are journaled before side effects. An uncertain send is not retried
after reconnect or restart. A failed `turn/start` requires restarting the
connection before accepting another prompt. Busy turns are not silently
steered. On restart, history and previous outputs are not replayed; only new
turns started by the bridge are eligible for output. The journal contains IDs,
not messages, and sits alongside the config as `*.delivery.json`.

## Validation

```sh
npm run build
npm run test:direct
npm run check
```

The tests exercise actual stdio subprocess framing, disconnects, timeouts,
owner/channel filtering, approval ownership, exact-turn stop, output isolation,
and durable duplicate suppression. A real Windows Codex 0.154.0 probe verified
ChatGPT authentication and selected-task metadata. An ephemeral read-only
Codex turn returned the expected response through stdio without tmux. This is
provider-transport evidence; live Slack delivery still requires configured
workspace credentials and an available selected task.

Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
