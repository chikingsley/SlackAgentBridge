# Named Codex agents in Slack

Run `npm run bridge` to connect named agents through the installed Codex App
Server. No tmux, terminal UI, Codex installation, or chat-history import is needed.
The original terminal daemon remains a separate legacy entry point.

## Setup

Use Node 22.12 or later. Run `npm ci` and `npm run build`.
Copy [agents.example.json](../agents.example.json) to
`~/.config/ccs/agents.json`, replacing the example values. Choose private channels
explicitly and invite the bot only to those channels. Add each authorized
person's Slack user ID to `allowedUserIds`; membership elsewhere in Slack does
not grant access. Configuration changes take effect after restarting the bridge.

Store `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in the sibling `env` file, outside
the repository, or supply them through the process environment. Use
`npm run manifest:direct --silent` to generate the limited Slack app manifest.
Enable Socket Mode and create an app-level token with `connections:write`.
Only one process may consume that app token, on any computer.

Start with `npm run bridge`, or `npm run bridge -- --config /path/to/agents.json`.
The ready message confirms workspace identity and membership in every configured
private channel. The bridge runs until that process stops; it is not installed
as an operating-system service automatically.

## Use

Select the actual Slack mention from autocomplete when typing `@Codex Agent`.

| Message | Result |
| --- | --- |
| `@Codex Agent new planner` | Creates a fresh Codex conversation named planner |
| `@Codex Agent new planner Help plan this task` | Creates it and sends the first prompt |
| `@Codex Agent planner Your question` | Addresses that existing named agent |
| Reply in an agent's Slack thread | Continues the same Codex conversation without another mention |
| `@Codex Agent list` | Lists your registered agents in this channel |
| `@Codex Agent share planner @person` | Lets an explicitly configured person prompt your agent |
| `@Codex Agent help` | Shows the available actions |
| `sab status` in its thread | Reports whether that agent is ready or working |
| `sab stop` in its thread | Interrupts its current bridge-started turn |

Each authorized person can create their own agents. Names are unique within a
channel. An owner may explicitly share an agent with another configured person;
their prompts are labelled as collaborator messages. Approvals, interactive
answers and stopping remain owner-only. Automated agent-to-agent dispatch and
cross-computer handoff are not implemented in this entry point.

New agents start with native read-only sandboxing and on-request approvals.
Each gets a dedicated working directory under the configured workspace root.
They use this computer's existing Codex login. They do not represent another
person's account or inherit that person's private conversations.

Replies remain in the addressed Slack thread. Ordinary channel messages,
unconfigured channels/users, edits and bot messages are ignored. Files produce
an explicit unsupported message rather than silently disappearing. Busy agents
ask you to wait; incoming prompts do not silently steer an existing turn.

## Persistence and tests

The sibling `agents.json.state.json` stores agent IDs and Slack thread bindings;
delivery journals store only delivery IDs. After restart, a thread reply resumes
the recorded Codex conversation. Uncertain deliveries are never replayed.
If another Codex client owns that task, native resume fails visibly rather than
stealing its writer lock. Fresh Slack-created tasks avoid that desktop conflict.

All new tests are in `tests/direct/`, run by Vitest. No tests ship in `src/` or
the compiled production output. Run `npm test`, `npm run typecheck`, and
`npm run check`. The existing macOS-oriented Node test suite remains available
as `npm run test:legacy`; it is not included in the Vitest test count.

The [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes the native thread/turn protocol used here.
