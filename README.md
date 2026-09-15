# Slack Agent Bridge

Connect selected Codex tasks on your own computer to one shared Slack app.
The gateway holds Slack credentials. Each person's connector uses their own
installed Codex and login. No terminal automation, tmux, Codex installation,
conversation discovery, or history import.

## Connect your computer

You need Node.js 22.12+ and Codex already installed and signed in. The gateway
must be reachable from your computer. Our deployment uses the existing private
Tailscale network; Slack desktop is optional (Slack web works).

1. Clone this repository and run `npm ci`.
2. In an authorized private Slack channel, mention **Codex Agent** with `connect`.
   The bot returns a private, single-use connection command, valid for 10 minutes.
3. Run that command **on your computer**. It stores your scoped connector token,
   never the shared Slack tokens.
4. Register an agent from your computer:

   ```sh
   npm run agent -- --name joey --cwd /absolute/path/to/workspace
   ```

   This creates one named native Codex task. To select an existing task, add
   `--thread TASK_ID`. Close its other active writer first; the connector never
   takes over an active desktop task. Use `--codex /path/to/codex` if it is not on PATH.
5. Start `npm run start:connector`. It runs in the background; you can close the terminal.
6. In Slack: `@Codex Agent joey your question`. Continue by replying in that
   Slack thread. To register another agent, run `npm run stop:connector`, repeat step 4,
   then `npm run start:connector`. Other people's agents run on their computers and accounts.

Remove a registration with `npm run stop:connector`,
`npm run remove-agent -- --name NAME`, then `npm run start:connector`. This preserves
the native task. Background services stop gracefully using `npm run stop:gateway`
and `npm run stop:connector`; they do not require an open terminal or SSH session.

`--config /absolute/path/connector.json` selects a separate connector configuration
for any local command. The default is `~/.config/ccs/connector.json`.

## Slack commands

- `@Codex Agent connect`: private pairing invitation for your identity/channel.
- `@Codex Agent list`: names and connection status you can access.
- `@Codex Agent NAME question`: address a registered agent.
- Reply in a bound Slack thread: continue the same agent and native context.
- `@Codex Agent share NAME @person` / `unshare NAME @person`: owner-controlled
  prompt access for an authorized member. Collaborators are labelled; they
  cannot approve actions, answer permission questions, or stop another owner's task.
- `@Codex Agent revoke NAME`: revoke that computer's connector (all its aliases).
- Reply `sab status` / `sab stop`: inspect or interrupt the exact bridge turn.
- Reply `approve CODE`, `deny CODE`, or `answer CODE text` when the agent requests
  an owner decision. Decisions must be in the exact originating Slack thread.

Bot messages are ignored, so agents cannot recursively trigger each other.
Sharing lets a person ask another person's agent; autonomous agent-to-agent
negotiation is not enabled. Agents do not represent their owner's unstated views.
Text is supported; file messages receive an explicit unsupported response.

## Gateway administrator

Run exactly one gateway per Slack app. Use `slack/app-manifest.json` to configure
the app, install it, and invite its bot to the chosen **private** channels.
Copy `gateway.example.json` to `~/.config/ccs/gateway.json`, selecting the exact
workspace, channel IDs, member IDs and HTTPS URL. Add credentials to the adjacent
private `env` file:

```text
SLACK_BOT_TOKEN=your-bot-token
SLACK_APP_TOKEN=your-socket-mode-token
```

Run `npm run start:gateway` (or `npm run bridge` in the foreground). The HTTP API binds only to `127.0.0.1:8877`. Place it behind
HTTPS, for example `tailscale serve --bg --https=8443 http://127.0.0.1:8877`.
Set `publicUrl` to that HTTPS origin. Remote plaintext and redirects are refused.
Adding a person means authorizing their Slack member ID/channel on the gateway;
they perform pairing, task selection and login on their own computer.
Never distribute Slack tokens to connectors. Gateway needs no Codex installation.

## Reliability and operation

Offline computers fail visibly; work never falls back to the gateway. Accepted
message IDs are persisted before delivery. Uncertain requests and lost responses
are **not automatically replayed**; inspect the task and send a new message.
Connector network polling reconnects automatically. Native App Server failure
requires restarting that connector. Running processes must remain available;
auto-start on OS login is deployment-specific, not installed by this repository.

Tests and source are TypeScript. Build output is ordinary `.js` in ignored `dist/`.
No `.mjs` source or tests remain. All tests live in `tests/` and use Vitest.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run audit
```

Version 3 intentionally removes the original terminal/Claude/Pi daemon, hooks,
installers and its tests. Those remain in Git history at
`rollback-before-native-connectors`. Existing legacy state is not migrated.
See [architecture](ARCHITECTURE.md), [security](SECURITY.md), and
[verification](docs/verification.md).
