# Verification — 2026-09-15

The same native gateway/connector implementation was tested on Windows and
Hochi (macOS), using each computer's installed Codex and separate explicitly
created test tasks. Only the dedicated private Slack test channel was used.

- Windows: Node 24.19; native Codex 0.154.0.
- Hochi: Node 26.8.1; native Codex 0.153.4.
- Both: build, strict TypeScript check, all 24 Vitest tests passed; production
  dependency audit found zero vulnerabilities.
- Both paired independently using one-use private Slack invitations and the
  same HTTPS gateway. No Slack credentials were copied to Hochi.
- Slack mentions produced WINDOWS_NATIVE_OK and HOCHI_NATIVE_OK from the
  corresponding native tasks. Plain thread replies retained different test words.
- Stopping Hochi produced an explicit offline response. The prompt was not
  executed on Windows or replayed when Hochi returned.
- After restarting the gateway and both connectors, the same native tasks
  retained their separate contexts and answered the original Slack threads.

The empty-new-task issue discovered during live testing was corrected by
completing a minimal BRIDGE_READY initialization turn before setup closes.
The initialization test covers completion arriving before its RPC response.

Unit coverage includes owner/collaborator separation, exact device/task/reply
routing, private invitation delivery and expiry, single-use enrollment,
duplicate suppression, revoked/unauthorized clients, unknown output roots,
unsharing before queued delivery, native approval authority, and private
background-service shutdown controls. Native live evidence is recorded locally
outside the repository; no credentials or private Slack transcripts are published.

This verifies these two devices. Other people must pair and select tasks on
their own computers; their accounts and computers were not configured by us.
