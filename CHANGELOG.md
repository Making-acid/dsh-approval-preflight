# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.1.1] - 2026-10-30

Live verification of 2.1.0 on the real Host, plus the two issues it exposed.

### Fixed

- When the only remaining work was a suspended node, `preflight_status` said "当前没有
  可执行的节点" instead of pointing at `preflight_node_start <id>` to resume it. The
  model-facing hint now has an explicit resume branch.
- Suspension reasons no longer nest parentheses: `等待「pwsh」审批超时 90 秒` instead of
  `等待「pwsh」审批超时（90 秒）`.

### Changed

- Prompt section: `effect` is only a classification hint; `impacts` decide what the
  running node covers and must match the tools actually used. Deleting a file through
  `pwsh` is `exec`, not the `fs-delete` default of `effect: delete` — learned from the
  live run, where a `delete` node could not cover its own command.
- `docs/verify.md` records the 2026-10-30 live verification (what was checked, the
  screenshots, and the two rough edges below).

### Known issues (documented, not fixed here)

- After a timeout hand-off the native approval card can linger although the request has
  already settled; clicking any of its buttons only dismisses it. The plugin cannot
  withdraw the presenter's pending UI.
- The side panel is a fixed overlay and can be partially covered by a persona avatar in
  the Web UI.

## [2.1.0] - 2026-10-30

### Added

- **Dependency-aware auto-switch.** `dependsOn` is now part of the runtime model, not
  only display order. When a running node hits an unplanned permission request that
  nobody answers within `approvalTimeoutSeconds`, the plugin suspends that node
  (approval kept, running slot released), computes the independent branch
  (`approved` ∧ dependencies done ∧ dependency closure excludes the suspended node)
  and hands it to the model by name. With no candidate it says so explicitly instead
  of letting the turn spin on a retry.
- **`suspended` node status** with a durable marker
  `[[preflight:suspend:<graphVersion>:<nodeId>]]`: replayable from the session log,
  resumable with `preflight_node_start` (no re-approval), revocable from the panel,
  visible with its reason in the strip and the node card. The idle timeout now
  suspends instead of silently closing.
- Dependency cycles are rejected at `preflight_graph` / `preflight_graph_append` time.
- Panel: dependency-layered graph columns (independent branches stack in one column,
  arrows show flow), `前置` / `后续` tags, suspend reason, and the "不依赖它的可做节点"
  hint on a suspended card.
- `scripts/contract-test.mjs` now validates every tool output against its declared
  `output.schema` — the check that would have caught the fix below.

### Fixed

- **Every tool failed in a real Host with `value.running must be a string`.** The shared
  output schema declared `running: string` while the view returned `null` when idle, so
  the Host's output validator rejected the results of `preflight_graph`,
  `preflight_node_start`, `preflight_node_end` and `preflight_status`. The view now
  emits `''` plus `hasRunning`, and the contract suite guards the schema.

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
