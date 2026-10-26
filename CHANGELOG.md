# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-26

### Added

- Host plugin `approval-preflight` with three model-facing tools:
  `preflight_plan` (publish or clear the task/permission table),
  `preflight_status` (progress, grants, runnable subtasks) and
  `preflight_task` (per-subtask state).
- Plan-first workflow section in the system prompt: plan before touching
  permissions, do not spin on a blocked approval, maintain the table.
- Coarse permission classes (`fs-write`, `exec`, `network`, `danger`) with
  classification from the dispatched call's own arguments, correlated through
  `tools/pre-execute` on `callId`. Unclassifiable requests always fall back to
  the native approval card.
- `approval/request` interceptor registered with `prepend: true`: a granted class
  is answered `allowed-once` before the native presenter runs.
- Timeout hand-off: an ungranted but classifiable approval is raced against
  `approvalTimeoutSeconds`; on timeout the tool fails fast, the class is recorded
  as pending, and the model receives "go do something else" guidance. A late
  native approval click is promoted into a standing grant and wakes the model.
- Browser half: a composer strip above the input and a fixed side panel
  (`shell.overlay`) rendering the task/permission table, auto-opening when
  permissions are missing, with one-click per-class grants, revoke, grant-all,
  `Esc` to close and 2.5s polling.
- Panel channel: an owned `webServer` prefix route speaking the platform's
  `client-request` / `server-response` envelope, authenticated through
  `connection.admit` (same Host/Origin fence and browser credential as `/api`).
- Durable state without a database: the plan is rebuilt from `tool/call` events,
  grants from injected user messages carrying a `[[preflight:grant:...]]` marker.
- Verification: `scripts/selftest.mjs` (27), `scripts/contract-test.mjs` (31,
  loads the real Host entry against a Cordis stand-in) and
  `scripts/client-test.mjs` (22, loads the real browser bundle in a DOM
  stand-in). Live end-to-end checked in the desktop profile: panel rendering,
  Host↔Client channel, grant write, injected grant notice and model wake-up.

### Known limitations

- Does not take over the native approval card; it only short-circuits granted
  classes and hands off on timeout.
- Third-party / MCP tools cannot be classified, so they always use the native
  card.
- Timeout hand-off is not background execution: the model retries after the
  grant arrives.
- The browser bundle ships its own stylesheet and controls, using only
  `--dsw-alias-*` theme tokens.
