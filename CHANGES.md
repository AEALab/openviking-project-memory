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

npm 0.2.1 / plugin 0.7.7-project.9 (2026-11-16):
`openviking-project-memory setup` offers reconfigure libraries and defaults,
adjust project rules without re-entering connections or changing the default
read mode, preserve and exit, or cancel. The project-only entry can still
change global activation. Personal-only and team-only setups support all projects or selected
projects. Dual-library setups choose a personal default, a team default, or
default-off with explicit projects. Library roles describe usage rather than
deployment location; team-only setup requires no personal library. Keys are
hidden on input. Configuring two libraries does not enable combined reads:
read scope is chosen separately and defaults to the current write library.
Full setup with default-off requires at least one explicitly enabled project.

Multiple project paths can select a saved personal/team library, follow the
default, use a custom connection, disable memory, or preserve existing rules.
Shared selections use user-level read-routing.json writeDirectories roles and
sourceUrls approvals, without project Key copies or new registry entries.
Custom connections retain project ovcli.conf and registry approval, Git ignore
checks and local info/exclude updates; tracked credentials are refused and
invalid connections fail closed. Returning to a shared library backs up and
removes the project connection and its approval. Directory inheritance uses
the nearest parent rule; existing user-level rules can be preserved or cleared.
Unlisted projects keep their own explicit switches and independent connections.

Setup shows the complete plan before a final save confirmation, writes private
0600 configuration files and backups (centralized under user setup-backups
with an original-path manifest), and rolls back written files on failure
(reporting any incomplete restoration). Installation still preserves existing
connection files or environment configuration and points to setup for changes;
first interactive installation without a connection opens the complete wizard.
New registrations leave the plugin and independent MCP disabled until setup
confirms activation; reinstallations retain existing switches. CI and missing
terminals skip questions. Chinese postinstall messages explain registration,
preserved connections, manual setup, cancellation and restart requirements;
setup errors do not print exception secrets. Connection formats and routing
are validated without network or Key-permission probes, and environment
connection/identity overrides must be removed before changes. Manual
configuration examples remain reference material; real memory-service validation
is separate from the isolated regression suite.

Wizard wording consistently distinguishes global defaults from project settings,
and explicitly labels separate and combined reads. Combined MCP discovery gives
each source a shared five-second deadline across initialization and tool listing;
a stalled source cannot block the healthy source at startup or on tools/list.
Reads skip sources still awaiting successful discovery, preserve healthy source
results, and report a tool error only when all selected sources fail. Failed
discovery is retried by tools/list; writes remain pinned to the primary source.
Regression coverage includes either source offline or stalled, multi-stage
discovery timeouts, both sources offline, recovery, and automatic recall.

npm distribution (0.1.0 / plugin 0.7.7-project.5): publish as
`@haowux/openviking-project-memory`; global installation registers the local
marketplace and plugin, configures independent stdio MCP with absolute paths,
and enables new installations globally. Reinstallation preserves existing
disabled settings. The installer backs up Codex configuration with private
permissions, preserves unrelated settings, and restores the prior plugin
enabled setting on failure. `openviking-project-memory install` retries
registration; `openviking-project-memory setup` reuses the connection wizard.
Installation tests cover configuration merging, old-path migration, failure
recovery and npm lifecycle behavior. Plugin identifiers remain compatible;
connection, routing and memory files are not changed by registration.

npm 0.1.1 / plugin 0.7.7-project.6: global installation and manual registration
offer connection setup through the controlling terminal, so npm's captured
lifecycle output no longer hides the first-run wizard. Existing connection
files and environment credentials are preserved. CI and installations without
an interactive terminal skip questions; cancelled or failed connection setup
can be retried with the existing setup command. No dependency is added.

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
