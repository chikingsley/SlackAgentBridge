# Contributor instructions

This fork is a TypeScript native Codex bridge. Version 3 deliberately removes
legacy terminal, tmux, Claude/Pi, hooks, installer and automation subsystems.
Historical behavior is available in Git history; do not restore it implicitly.

- One gateway owns the sole Slack Socket Mode consumer and Slack credentials.
- Every connector owns its Codex login, process and explicitly selected tasks.
- No history discovery/import, transcript parsing or active-writer takeover.
- No execution fallback: offline/unknown/mismatched targets fail closed.
- Authorize exact owner, private channel, device, native task, turn and reply root.
- Only owners approve/deny/answer interactions or stop turns. Collaborator prompts
  are labelled. Agents cannot send arbitrary Slack destinations or trigger bots.
- Persist claims before side effects; never replay uncertain work.
- Keep credentials, generated state, logs and transcripts outside the repository.
- Tests live only in tests/, use Vitest and TypeScript. Source lives in src/.
- Read ARCHITECTURE.md before changing identity, lifecycle or delivery.
- Inspect status and live processes before changes. Stop only explicitly owned
  test processes during authorized maintenance, or develop in a separate worktree.
- Test only in channels and tasks explicitly designated for bridge verification.
- Before publishing: npm ci, npm run build, npm run typecheck, npm test,
  npm run audit, inspect tracked files for secrets and generated artifacts.
- Report real live evidence separately from unit tests. Do not claim another
  person's connection works until they connect it on their own computer.
