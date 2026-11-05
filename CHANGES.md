# Community changes

Based on installed upstream plugin metadata version 0.7.7. This package adds project write routing, isolated session cursors, configurable per-directory single/combined reads, source-aware MCP reads, and filtering of directly injected retrieval content. No OpenViking server code is included or changed.

Modified/added runtime and test files:

- `codex-memory-plugin/scripts/auto-recall.mjs`
- `codex-memory-plugin/scripts/auto-recall.test.mjs`
- `codex-memory-plugin/scripts/capture-utils.mjs`
- `codex-memory-plugin/scripts/combined-capture.test.mjs`
- `codex-memory-plugin/scripts/combined-read-hooks.test.mjs`
- `codex-memory-plugin/scripts/config.mjs`
- `codex-memory-plugin/scripts/ov-credentials.mjs`
- `codex-memory-plugin/scripts/project-config.mjs`
- `codex-memory-plugin/scripts/project-config.test.mjs`
- `codex-memory-plugin/scripts/project-routing.integration.test.mjs`
- `codex-memory-plugin/scripts/read-routing.mjs`
- `codex-memory-plugin/scripts/read-routing.test.mjs`
- `codex-memory-plugin/scripts/session-start-commit.mjs`
- `codex-memory-plugin/scripts/session-state.mjs`
- `codex-memory-plugin/scripts/shared/profile-inject.mjs`
- `codex-memory-plugin/scripts/shared/recall-core.mjs`
- `codex-memory-plugin/servers/combined-read.mjs`
- `codex-memory-plugin/servers/combined-read.test.mjs`
- `codex-memory-plugin/servers/mcp-proxy.mjs`

Package metadata and installation documentation are community-specific. Upstream notices are retained; see NOTICE.md.

Package-only adaptation: doctor marketplace identity and its reference skill text use `openviking-project`; original upstream installers remain reference files and are not the installation method for this package.

Version 0.7.7-project.3 adds scripts/ov-memory.mjs, scripts/ov-memory.test.mjs, shared resolver exports, skills/ov-memory/SKILL.md and the package root command launcher. Read/write routing behavior and credentials are preserved.

Documentation synchronization (2026-11-05): use generic Experience search/read
tools consistently; replace the legacy v0.6.0 verification SOP with current
package checks and live-verification boundaries; document connection-scoped
state paths; mark the retained upstream README as historical; align the root
README's core verification command. No runtime behavior changes.
Doctor documentation also follows local community installation, scoped state,
project-aware credentials and independent MCP disablement.

Version 0.7.7-project.4 fixes the full-package review findings:
HTTP redirects are rejected; approved project configuration is parsed once;
request and session state share fixed identities; Stop, PreCompact and cleanup
serialize session mutations and persist each successful batch; unassigned or
corrupt cursors are preserved; single-source MCP validates configuration before
tool requests; combined tools rediscover previously unavailable sources;
capture limits apply to uploaded text parts; doctor understands project-only
activation and avoids upstream installer advice; tests isolate user settings;
hook paths are quoted; package validation checks complete file coverage and
runtime references. Regression tests use synthetic data and local mock services.

Repository distribution: use a fixed openviking-project-memory directory and AEALab GitHub repository; ignore Git metadata during source verification. Plugin runtime behavior is unchanged.

SessionStart lock isolation: a busy or abandoned session lock is logged and
skipped during initialization, orphan commit and cursor cleanup, so other
sessions can still be processed. Locked state and lock files remain intact;
other errors retain their existing failure behavior. Regression tests cover
recent, idle, expired-cursor and current-session locks.

Narrow defensive checks: configuration paths no longer count as connection
identity; capture filters confirmed retrieval results before truncation while
preserving ordinary tool examples; session archive routing checks URI fields
instead of search text; status can read configuration symlinks while mutations
still refuse them; secondary actor reads without a configured peer return a
source error instead of widening to all peers. Identity and enrollment checks,
primary-only writes and existing session locks remain in place.

Combined read tools no longer advertise the upstream output schema after their
results are wrapped by source; direct write tools retain their original schema.
Connection comparisons normalize equivalent URL spellings, including host case
and default ports, while preserving endpoint path differences. Verified legacy
routes gain a canonical identity without moving cursors or locks; unverified
legacy bindings remain blocked. Initial routes are published atomically without
overwriting another connection's binding, and diagnostics include legacy state
directories.
