# Security

Only configured Slack member IDs in configured private channels may use the
bridge. Connector invitations are private ephemeral Slack messages, single use,
identity/channel scoped and expire after ten minutes. Device credentials are
random bearer tokens; only hashes are stored at the gateway. Local token/state
files use private POSIX permissions; on Windows restrict the configuration
folder ACL to the current user. Never commit these files.

The gateway requires HTTPS for remote connectors and listens only on loopback.
Protect the reverse proxy and restrict network access (the verified deployment
uses Tailscale). Do not expose the loopback HTTP port directly on a public host.
No connectors receive Slack or other owners' Codex credentials.

Fresh native tasks use read-only sandboxing and on-request approval. Existing
selected tasks retain their native policy. Workspace choice happens locally;
Slack cannot select arbitrary filesystem paths or native task IDs. Owners
should review a task's policy before sharing prompt access. A compromised
connector can speak as its own agents, never select another connector's reply
roots. Revocation blocks new polling and outputs; already running local work
must be stopped locally and cannot be undone remotely after revocation.

Uncertain delivery is claimed once, not retried. The agent may have executed
work even when a response is lost. Inspect the task before resubmitting.
Text passes through Slack and the gateway, so do not send data unsuitable for
that channel's members. Permission replies are owner-only in the exact Slack
thread. Untrusted collaborator prompts cannot authorize approvals or stops.

Report suspected defects privately to the repository owner before publishing
credentials or reproduction transcripts. The bridge is not a hardened public
multi-tenant service; deploy behind a trusted network and explicit access policy.
