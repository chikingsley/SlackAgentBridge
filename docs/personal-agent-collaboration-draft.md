# Personal agents collaborating across owners

Status: the local named-agent hub is implemented and live-tested. The separate
owner-account, multi-computer design below remains a proposal. See the
[tester guide](tester-guide.md) for current capabilities and the next milestone.

## Intended experience

Each person enrolls an agent that retains their own project context and prior
decisions. People and authorized agents can address a selected peer through
Slack to ask questions, compare plans, or delegate bounded work. A display alias
such as `@project-advisor` resolves to an explicitly enrolled session and owner;
whether this uses native Slack mentions or bridge aliases is still undecided.

Example: an owner's agent asks a colleague's agent what constraints the colleague
previously expressed about a proposal. The peer consults only context its owner
has authorized it to use and share, answers with supporting references where
available, and flags uncertainty. The exchange can lead to a revised plan or an
explicit work request. A question alone does not authorize implementation.

## Representation and context

- Agents identify themselves as assistants for their owners, not as the owners.
- Answers distinguish an explicit owner statement, an inference from prior
  discussion, an agent recommendation, and an unknown requiring owner input.
- Historical statements retain dates and scope; they are not current approval.
- No automatic central transcript ingestion, account sharing, or global memory
  merging. The peer chooses a bounded answer from its permitted context.
- Shared conversation content is visible to the intended participants. Private
  source material need not be copied into Slack to support an answer.

## Request contract

Each request records a stable ID, authenticated sender and owner, destination
agent and owner, shared project scope, request kind, and reply destination.
Initial kinds are question, planning request, and bounded work request.

The recipient acknowledges, declines, or requests clarification. Accepted work
reports progress and an explicit result or failure. Authority is checked by the
bridge and recipient node; a message cannot grant itself additional permissions.
Human owner policy determines which peer requests may run unattended. Agent
output cannot impersonate human approval.

Maintain per-task ordering and durable delivery records. Offline peers report
offline; uncertain delivery is not replayed blindly. Automatic exchanges have
bounded turns and budgets and stop when owner input is required.

## Relationship to upstream

Extend `docs/multi-node-architecture.md`: one Slack coordinator, enrolled nodes,
node-local credentials, authenticated routing and exact session ownership.
Use the existing `sab team` interface and immutable identities rather than
introducing a second public command family.

Upstream currently implements local teams and node enrollment/authentication,
but not remote provider lifecycle or cross-node team delivery. Its teams use
owner-created coordinator/worker stars; arbitrary peer-to-peer dispatch is not
currently permitted. Supporting independent owners requires an explicit review
of role state and directed permissions, not simply removing those restrictions.

Existing desktop or cloud task adoption is a separate compatibility question.
Do not assume native task IDs or the desktop's current login make those tasks
controllable. Begin with explicitly enrolled bridge-managed sessions.

## First implementation milestones

1. Inventory existing node transport, routing, lifecycle and team tests; map the
   missing remote lifecycle work against upstream's delivery sequence.
2. Implement and test authenticated text delivery between two enrolled nodes,
   including acknowledgments, offline behavior, restart and duplicate handling.
3. Bind each node to its owner and test directed question/planning permissions.
4. Pilot a question and follow-up between two bridge-managed sessions, retaining
   their separate context and accounts. Verify which native session answered.
5. Add bounded work delegation and owner escalation after the read-only pilot.

Use a separate test Slack app for live validation. No production installation,
account changes, transcript import, or runtime behavior change is part of this
initial fork and product brief.

## Fork scope and cleanup review (2026-09-14)

The requested direction is TypeScript, removal of Pi support, and use of existing
agent installations. Retain Codex integration: upstream `install-codex.sh`
activates hooks/bridge configuration, rather than installing the Codex CLI.
Claude support remains in scope unless deliberately removed later.

At initial inspection the checkout had 132 `.mjs` files and an 8,653-line main
daemon, without a TypeScript build configuration. Pi was present in dedicated
extension files and also in shared provider, daemon, management, installer,
test and documentation paths. Removing only the `pi/` directory is insufficient.

Recommended development sequence:

1. Establish the existing baseline tests and record platform-dependent checks.
2. Remove Pi execution, managed-run controls and commands; update the provider
   union, UI, installer, docs and tests together. Keep non-Pi regression coverage.
3. Introduce a TypeScript build and migrate pure protocol/state/provider modules
   first, then adapters and orchestration. Split the main daemon along existing
   boundaries. Type identities, request envelopes, task states and provider
   events; do not disguise a rename as migration with unchecked `any` types.
4. Keep setup focused on bridge dependencies and explicit integration with
   already installed CLIs. Do not change provider account credentials or install
   or upgrade providers as an incidental setup action.
5. Validate the narrowed local bridge on Hojo before implementing remote delivery.
6. Add Hochi as the second node after cross-node lifecycle and routing tests pass.

### Test placement and clients

Hojo is the proposed initial test machine. A read-only SSH PATH probe found Node,
Claude and Codex there; tmux was not found in that shell. Hochi's probe found Node,
tmux and Codex. These are prerequisite observations, not a deployment check.
No bridge LaunchAgent was found at the standard per-user path on either machine.

The coordinator talks directly to Slack using Socket Mode and the Web API.
Neither execution node needs Slack Desktop installed. Use one test Slack app and
one Socket Mode coordinator; the second machine will become an execution node,
not a duplicate Slack-token consumer.

Beeper may serve as the owner's human Slack client. Its official guide documents
Slack channels and DMs, but bridge slash commands, Block Kit buttons, forms and
approval actions need live verification. Keep Slack in a browser available for
setup and unsupported controls. Do not make Beeper's local API a required part
of agent-to-agent delivery.

References:
- https://docs.slack.dev/apis/events-api/using-socket-mode/
- https://help.beeper.com/en_US/chat-networks/slack

Pi removal is implemented, including runtime, UI, installer, manifest, tests,
and current documentation. The TypeScript App Server hub supports explicit
named agents, mentions, thread replies, owner-approved sharing and durable
restart recovery. Private-channel live checks verified separate agent context,
same-task continuation and replies after restart. No tmux or history import is
used. New bridge-owned tasks avoid taking over the desktop's active writer.
The broader legacy daemon migration and remote connectors remain separate.
See [agent hub](agent-hub.md).
