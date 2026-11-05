---
name: ov-memory-doctor
description: Diagnose the OpenViking Project Memory plugin, primary connection, hooks and MCP configuration. Use for missing memory, failed capture or recall, authentication errors, and post-install status checks. Directory read mode is managed by ov-memory.
---

> Community package note: installation and updates follow the package root README. Do not run an upstream network installer to repair or upgrade this fork. This doctor diagnoses the primary connection; verify directory read modes with the package read-routing instructions.

# OpenViking Memory Doctor (Codex)

Troubleshooting for the OpenViking memory plugin. Three things go
wrong on a user's machine, each silently:

- **Install** — marketplace registration, `[plugins."openviking-memory@openviking-project"]`
  and `[features] plugin_hooks` in the user and current project Codex
  configuration, project/hook trust records, and the independent stdio MCP proxy. When these are wrong, hooks never run and
  nothing is logged anywhere.
- **Configuration** — `~/.openviking/ovcli.conf`, `~/.openviking/ov.conf` and
  `OPENVIKING_*` environment variables. Project connections must be registered
  in the user-level project registry; malformed, unregistered or missing
  registered project files stop sending. Without a project override,
  legacy/default credential resolution can still select localhost.
- **Connection** — `/health` answers 200 even with a bad key, so everything
  can look reachable while every real request 401s.

When the resolved url is loopback, the server runs on this machine and the
doctor adds a **Server health** section: whether anything listens on the
port, plugin-only keys in `ov.conf` (`claude_code`, `codex`, `server.url`)
that make the server refuse to start, and `GET /ready` — the server's own
per-subsystem verdict (agfs, vectordb, api keys, embedding, ollama). For a
remote server only `/ready` is probed. Everything else on the server side —
config validation, live embedding probe, native engine, disk — is
`openviking-server doctor`, run in the server's Python environment.

## Step 1 — run the doctor

The script ships inside the plugin. Codex runs hooks from the plugin cache,
so run the doctor from there (newest version directory):

```bash
PLUGIN_DIR=$(ls -d ~/.codex/plugins/cache/openviking-project/openviking-memory/*/ | sort -V | tail -1)
node "$PLUGIN_DIR/scripts/ov-memory-doctor.mjs"
```

If that directory does not exist, fall back to the marketplace copy reported by
`codex plugin list --json` (`.installed[] | select(.pluginId == "openviking-memory@openviking-project") | .source.path`),
or to this package's `codex-memory-plugin` directory. Run from the target
project directory so the doctor resolves that project's primary connection.

Options: `--json` (machine-readable), `--offline` (skip network probes and local port inspection),
`--timeout <ms>` (per probe, default 5000), `--no-color`.

For an enabled directory, the report has six sections — Environment, Plugin
install, Configuration, Connection, Server health, Recent activity — and a
Summary listing every ✗/⚠ with a fix. When the plugin is disabled for the
current directory, connection and activity checks are skipped; project-only
mode does not require a global OpenViking connection.

Project-only (package README method B) deliberately sets the user-level plugin
and independent MCP to `enabled = false`, then enables both in selected
projects' `.codex/config.toml`. Keep those global defaults disabled. The doctor
inspects project overrides up to the Git root and checks user-level project
trust records. An unknown trust state means the files are configured, not
proof that Codex loaded them; verify trust in Codex and observe a new session.
Hook approvals and project trust are separate checks.
Read the whole report before acting: one root cause usually shows up in
several sections (a bad key → "api key rejected" + "system/status → 401").

The API key is never printed in full. Three-segment keys are shown as
`account=<a> user=<u> secret=abcd…wxyz` (the first two segments are base64url
identity, decoded so the user can see which account/user the key claims);
legacy keys as `abcd…wxyz (64 chars)`. Keep it that way in anything you show
the user.

## Step 2 — map findings to causes

Work top-down; fix the first ✗ and rerun before chasing the next.

| Doctor finding | Meaning | Action |
|---|---|---|
| `ovcli.conf cannot be parsed` / `no usable config` / invalid project configuration | Malformed connection or invalid project registration; project failures stop sending, while legacy global resolution may use defaults | Fix the selected JSON and, for a project connection, its user-level registry entry. Follow the package README; preserve mode 0600. |
| `codex plugin list does not show …` | Plugin never installed, or installed under an old id | Register the unpacked local package and install `openviking-memory@openviking-project` using the package README. |
| `[features] plugin_hooks is not set/false` | Hooks are unavailable in the intended scope | Merge the package template in the intended user/project configuration scope, preserving method B disabled defaults; restart Codex. |
| `user-level plugin default is disabled` / CLI reports disabled | Supported project-only default; CLI output alone does not establish current-directory activation | Keep the global default disabled in method B. Inspect the current project's override and trust; enable only the intended scope. |
| `plugin is disabled for the current directory` | No loaded/configured project override enables the plugin here | Expected in ordinary directories in method B; create or fix the selected project's `.codex/config.toml` only when that project should use memory. |
| `project config trust is not verified` / `project config is untrusted` | The project override may not be loaded, or is ignored | Verify/trust the intended project in Codex. Do not claim activation from the file alone; confirm a new session and hook activity. |
| `independent MCP is disabled while the plugin is configured enabled` | Project/user plugin and independent MCP switches differ | Enable `mcp_servers.openviking-memory` in the same intended scope; retain user-level disabled defaults in method B. |
| `independent MCP remains enabled while the plugin is disabled` | Turning off hooks leaves the independent MCP available | In method B disable both user-level entries, then enable both only in intended trusted projects. |
| `independent MCP entry is missing` / `bundled plugin MCP is not explicitly disabled` | This community package's independent MCP wiring is incomplete | Merge the package README template: disable bundled plugin MCP and configure the independent entry with absolute Node/proxy paths. |
| `hooks disabled in [hooks.state]` | A hook was declined at the trust prompt | Remove `enabled = false` from that `[hooks.state."openviking-memory@openviking-project:hooks/hooks.json:<event>:0:0"]` section; approve the hook again. |
| `hooks without a trust record yet` | Codex has not yet approved those hooks (fresh install or `hooks.json` changed on update) | Start a Codex session and accept the hook prompt; nothing is wrong. |
| `marketplace 'openviking-project' is not registered` / root missing | Local marketplace removed or its unpacked directory moved | Restore a stable package directory and register it using the package README. |
| `plugin.json does not declare skills` | Old plugin copy; `$ov-memory-doctor` and the other bundled skills are not loaded | Update the plugin. |
| `cached plugin X differs from this copy` | The doctor was run from a checkout while Codex runs another version | Rerun from the cache path (Step 1). |
| `node is not on PATH` / node < 22 | Hooks and `.mcp.json` run the bare command `node` | Put node on PATH for the environment that launches Codex. |
| `credential source: env` unexpectedly | A stray `OPENVIKING_*` var forces env mode; `ov config switch` and ovcli.conf edits do nothing | Unset the var (check shell rc files and `~/.openviking/codex-plugin.rc.sh` residue). |
| `OPENVIKING_MEMORY_ENABLED has no effect` | That switch is Claude Code only | For full disablement, disable both the plugin and independent MCP using the package README. Per-feature recall/capture flags do not disable MCP. |
| `server unreachable` (refused / dns / timeout / tls) | Wrong url/port, server down, DNS/VPN, private CA | Compare with `curl -sS <url>/health`; curl OK + doctor fails ⇒ proxy or CA issue (Step 3). |
| `base URL ends with /api/v1` or `/mcp`, no scheme, `GET /health → 404` | url shape wrong; Cloud needs the `/openviking` prefix | Fix `url` to the API root. |
| `api key rejected` then `system/status → 401 Invalid API Key` | Key invalid/revoked/for another deployment | Get the key re-issued; check nothing overrides ovcli.conf ("← env"). |
| `using the ROOT api key` / `403 ROOT API keys cannot access tenant-scoped data APIs` | `api_key` fell through to `ov.conf server.root_api_key`, or the root key was pasted | Use a user/admin key. |
| `plugin auth mode 'trusted' differs from the server's 'api_key'` | account/user set in ovcli.conf ⇒ the plugin sends identity headers, which an `api_key` server ignores; data lands under the key's identity | Remove account/user (or set `OPENVIKING_AUTH_MODE=api_key`), or use a key for that identity. |
| `server is in trusted mode and needs account + user` | Server identity comes from headers | Set `account` and `user` in ovcli.conf. |
| `recall/capture timeout exceeds the hook budget` | Codex kills the hook before the request finishes | Lower `OPENVIKING_RECALL_TIMEOUT_MS` / `OPENVIKING_CAPTURE_TIMEOUT_MS`. |
| `POST /mcp tools/list → 404/406/502/504` while /health is fine | Reverse proxy not forwarding `/mcp`, rewriting `Accept`, or buffering SSE | Fix the proxy (`proxy_buffering off`, forward `/mcp`, pass `Authorization`). |
| `proxy variables set` + curl works but hooks fail | Node's fetch ignores `HTTP(S)_PROXY`; no CA handling | `NODE_USE_ENV_PROXY=1` or `NODE_EXTRA_CA_CERTS=<ca.pem>` in the environment that launches Codex. |
| `no session has ever captured a turn` / idle sessions piling up | Stop hook runs but writes fail, or commits fail | Fix the Connection findings; state files are kept and replay when the server is back. |
| `MCP proxy last started against <other url>` | The proxy is a long-lived process; a changed url only takes effect after restart | Restart Codex. |
| `ov.conf has a top-level 'claude_code' block` / `'codex' block` / `server.url is rejected` | Plugin-only keys in the server's own config; the server refuses to start at its next restart (`Unknown config field` / `Extra inputs are not permitted`) | Move them to ovcli.conf (`plugin.<harness>`, `url`) and delete them from ov.conf. Ignore only if this ov.conf never starts a server. |
| `nothing listens on port … — the server is not running` | Server down or never started; a stale `.openviking.pid` means it died | Start it (`openviking-server`; first time `openviking-server init`) in a terminal and read the startup output. Ask before restarting a server the user runs. |
| `/ready: embedding → error …` | The running server cannot call its embedding provider: recall searches nothing, commits extract nothing | Fix `embedding.*` (api_key/api_base/model) in ov.conf and restart; `openviking-server doctor` prints the provider's reply. |
| `/ready: vectordb → …` / `/ready: agfs → …` | Storage broken: disk full, two servers on one workspace, corrupted index | Server log; stop the duplicate; free disk. |
| `server is still initializing (503 /ready)` | First start downloads a local embedding model, or init is slow | Wait and rerun; if it never finishes, the server log. |
| `docker container is up but has no ov.conf` | Official image started without a config mount (every request 503s) | Mount `~/.openviking` at `/app/.openviking`, or `docker exec -it openviking openviking-server init`. |

More symptoms, exact error strings and log stage names: [reference.md](reference.md).

## Step 3 — targeted checks (only when the report is not conclusive)

Prove hooks run at all: put `OPENVIKING_DEBUG=1` in the environment that
launches Codex, run one turn, then read `~/.openviking/logs/codex-hooks.log`
(JSONL; grep `"error"`). An absent or unchanged log after a full turn means the
hooks were not spawned — a `plugin_hooks` / trust / node problem, not a server
problem. `~/.openviking/logs/cc-hooks.log` belongs to the Claude Code plugin.

Prove the key and identity by hand (`Bearer` is case-sensitive with exactly one
space):

```bash
URL=<url>; KEY=<key>
curl -sS "$URL/health"                                  # reachability, version, auth_mode
curl -sS -H "Authorization: Bearer $KEY" "$URL/health"  # 200 without account_id/user_id/role ⇒ key invalid
curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $KEY" "$URL/api/v1/system/status"  # real 401/403
```

Prove `/mcp` directly (stateless — no initialize needed):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$URL/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $KEY" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Prove a capture landed: inspect
`~/.openviking/codex-plugin-state/<connection-scope>/<safe-session-id>.json`
for `ovSessionId` (`cx-<session_id>`) and `capturedTurnCount`.
Connection bindings live under `codex-plugin-state/routes/`; an explicit
`OPENVIKING_CODEX_STATE_DIR` instead contains both state files and `routes/`.
Check the corresponding session and archives on the selected service.
A commit count confirms submission; verify extracted memory separately,
because extraction is asynchronous and may fail after commit.

Second opinion from the CLI: `ov health` and `ov config validate` use the
CLI's selected connection. The standalone CLI does not automatically follow
this plugin's project selector. Explicitly select the same connection before
comparing results; a global profile switch does not override an approved
project connection or a launch-time explicit connection override.

Server side (only meaningful when the server runs on this machine):

```bash
curl -sS "$URL/ready"                       # agfs / vectordb / api_key_manager / embedding (live probe, ≤10s) / ollama
openviking-server doctor                    # in the server's own environment: config, native engine, embedding probe, VLM key, disk
lsof -nP -iTCP:1933 -sTCP:LISTEN            # who owns the port
docker logs --tail 100 openviking           # container deployments
```

`log.output` defaults to stdout, so the server log is the terminal/tmux pane
it runs in, the nohup file, `journalctl -u openviking`, or `docker logs`;
with `"file"` it is `<storage.workspace>/log/openviking.log`. A server that
exits at startup prints the reason right there — running `openviking-server`
in the foreground is the quickest way to see it. It is the user's process:
ask before stopping or restarting it.

## Fixing

- Edit `~/.openviking/ovcli.conf` only with the user's agreement; show the
  change, keep unknown keys, keep mode 0600, never echo the key.
- Edit Codex configuration only in the intended user/project scope. Method B keeps user-level plugin and independent MCP disabled; change the selected project's `.codex/config.toml` when enabling that project.
- After changing `url`, installing or updating the plugin: restart Codex.
  Hooks re-read config per invocation, the MCP proxy does not.
- Updates: use the new community source package and follow its root README
  to register/install the local marketplace. Verify the installed version,
  cached copy, independent MCP path and hooks trust, then restart with a new
  conversation. Do not repair this extension with upstream network installers.
- Confirm the fix by rerunning the doctor, then by observing an
  `<openviking-context>` block on the next prompt.

## Documentation

- Community installation and updates: the unpacked package root README and local marketplace. Upstream source background: <https://github.com/volcengine/OpenViking>; do not use its network installer to repair this package.
- Documentation index (LLM-friendly): <https://docs.openviking.ai/llms.txt>; the harness integration pages under it cover install paths, configuration keys and known limitations.
- `https://api.vikingdb.cn-beijing.volces.com/openviking` is the Volcengine-hosted OpenViking Service (OpenViking Cloud): the path prefix is part of the base url, it accepts `Authorization: Bearer` only, and its keys are issued from the Volcengine console rather than by a self-hosted admin.

## Rules

- Never print a full API key or the raw contents of `ovcli.conf`; the
  doctor's masked forms are the limit.
- On a fresh machine, create connection files from this package's templates
  and follow the package README. Retained upstream setup scripts are not the
  installation or repair entry point for this extension.
- `/health` returning 200 proves reachability only. Auth is proven by the
  identity fields with a key, or by `/api/v1/system/status`.
- `ov doctor` is `openviking-server doctor`: it validates the server's own
  config and providers in the server's Python environment, makes a live
  embedding call, and says nothing about this plugin. Run it for provider-level
  failures, not first.
- The doctor only reads. Never stop, restart or `kill` the user's server, or
  edit `ov.conf`, without asking.
- Older proxy versions say "check that 'ov serve' is running" — there is no
  such command; the server is started with `openviking-server`.
- Do not read `~/.openviking/state/*.json` for a Codex verdict — those files
  are written by the Claude Code plugin.
