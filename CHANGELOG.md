# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-10-29

### Added

- Build identity: `lib/version.js` is the single source of the version, quoted by
  the Host log (`apply: start (v2.0.1)`), the panel footer, the `ping`/`status`
  panel endpoints and the `preflight_status` tool output. After an in-place
  upgrade the ESM module cache makes "which build is live?" ambiguous; this makes
  it answerable without guessing from `package.json`.
- `scripts/selftest.mjs` asserts the constant still matches `package.json`, and
  the contract/client suites assert it reaches the panel payload and the UI.

### Docs

- `scripts/live-check.mjs` / `npm run verify:loaded`: reads the plugin log and
  says whether the running Host is this build and whether the panel route came up,
  so a stale process is diagnosed in one command instead of by guessing.
- `docs/verify.md`: how to restart, what "loaded" looks like, the end-to-end
  scenario, and the failure modes worth checking first.

## [2.0.0] - 2026-10-27

### Changed — breaking

- **The authorization unit is now a computation-graph node, not a permission
  class.** v1 granted "all `exec` for the session" with one click, which silently
  widened authority. v2 replaces it with a graph whose nodes state the semantic
  operation (action / source / target / details) and are approved one by one.
- One approval covers exactly one successful execution of its node: the approval
  is consumed on `preflight_node_end{success:true}`, restored on failure, and a
  node that was never approved can never start.
- An approval from an older graph version no longer applies (fail closed).

### Added

- `preflight_graph` (declare/replace the graph), `preflight_graph_append`
  (append nodes without invalidating approvals), `preflight_node_start`,
  `preflight_node_end`, `preflight_status`.
- Approval interceptor keyed by the running node and the call's impact kind
  (`fs-write` / `exec` / `network`); requests outside the node's declaration are
  delegated to the native card, with the existing timeout hand-off.
- Audit trail per node: every tool call inside the running window is recorded
  with its outcome, and the panel shows it after the fact ("只做事后核对，不阻断执行").
- Panel rewrite: computation-graph overview (status colors, pending badges, click
  to jump), node cards with semantic essence and impact tags, per-node
  approve/reject, expandable audit, approve-all.
- One running node at a time; a node that never ends is closed after
  `nodeIdleSeconds` (no approval consumed).
- Session-log replay now covers graph, approvals, node windows and audit; any
  replay anomaly marks the affected approvals stale instead of trusting them.

### Removed

- Coarse permission classes and their session-wide grants. Old class-grant
  markers are ignored, and old `needs`-style graphs are not interpreted.

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
