# Peng v0.1.0

Peng is an original, clean-room AI agent application foundation. It is intended for building an AI Agent product from public Craft Agents surfaces, authorized observations, and original implementation work.

The legacy `yuumira` CLI and `YUUMIRA_*` environment variables remain available as compatibility aliases for the reverse-engineering harness.

## What is included

- Agent runtime with deterministic planning and tool execution
- Multi-step agent loop that feeds tool results back into the provider
- Thread and event persistence under `.yumira/`
- Tool registry with workspace-safe built-in tools
- Config, permission, skill, and workflow modules modeled from observed Craft Agents behavior
- Craft-style memory records with JSONL persistence, redaction, citations, workspace and optional user-home `.craft-agent/memories/` rendering, and bounded context rendering
- Knowledge Cockpit foundation with collections, markdown/text indexing, literal search, and index reports
- Credential store and source authentication state for bearer/header/query/basic API sources, with optional macOS Keychain secret storage
- Source test and API request execution with credential renewal, source icon caching, restart signatures, redacted request summaries, and persisted connection status
- Stdio MCP source initialization, `tools/list`, and `tools/call` execution
- HTTP MCP JSON-RPC initialization and `tools/list`/`tools/call` with bearer/header credentials
- OAuth authorization URL, PKCE callback, device code, token exchange, and refresh helpers for API/MCP sources
- Source-level MCP permissions and credential-to-env injection for stdio MCP processes
- Workspace domain model for statuses, labels, projects, sessions, and domain events
- Project, task, saved-view, and workspace search models
- Terminal command history, persisted session metadata, real workspace Git status/history/diff/branch/stash/worktree RPC helpers, Git status/log parsing, and YuuMira-style resource/tool icon manifest with static asset serving
- Authorized YuuMira resource import for bundled tool icons, themes, docs, release notes, permissions, logos, helper bin wrappers, scripts, and default resource files, with placeholder fallbacks when assets are absent
- Imported original Web UI entrypoint integrity checks for `index.html`/`login.html` scripts, styles, icons, and manifest references, plus boot-time config/workspace/logout endpoint and Craft RPC WebSocket compatibility for sessions, projects, tasks, labels, statuses, views, sources, knowledge/vault/QMD state, local semantic index search, messaging/provider-auth state, local Telegram/Lark/WhatsApp messaging gateway lifecycle, WhatsApp connect-phone RPC state, messaging access-control RPC state, inbound-message sessions, loop/goal state, persisted window focus/close/new-window request state, browser-pane navigation/history with optional HTML snapshot extraction, update/Pilot/RTK/computer-use status, safe menu/shell/auth/dialog/deeplink/debug acknowledgements, preferences, drafts, theme/input/power/settings, LLM connection lists/defaults/tests, model/onboarding/workspace settings, workspace file/image/permission RPCs, workspace-confined file watcher events, release notes, memory/cache/observability toggles, terminal probes, and safe workspace file reads
- Local push-notification compatibility for Web UI boot flows, including a deterministic browser application-server key and persisted PushManager subscription records
- Local updater compatibility state for check/download progress/dismiss/install-complete Web UI flows without invoking the native macOS updater
- Local observability compatibility for session traces, estimated session usage, and unlimited quota summaries backed by persisted protocol events
- Remote connection test compatibility using real HTTP probes with status, latency, and error classification
- Computer-use permission compatibility with persisted prompt/request/opened/granted/denied state for Web UI flows
- Pilot runtime compatibility state for local install/start/stop/dashboard Web UI flows
- RTK compatibility state with persisted enabled/disabled timing and local gain reporting
- Workspace-local file and folder dialog compatibility for imported Web UI flows without invoking native pickers
- Workspace-local skill editor/Finder open intent recording for imported skill-management flows
- Workspace-local skill soft-delete compatibility that archives deleted skills under `.yuumira/deleted-skills`
- Git Bash browse compatibility with deterministic local candidate selection and persisted browse intents
- Copilot/xAI device-code auth compatibility with persisted local pending flows, verification URLs, expiry, and provider auth status
- Local badge state compatibility for icon/count/text refresh events without requiring native app-shell APIs
- Onboarding Claude/MCP OAuth compatibility with persisted local pending/exchanged sessions and state probes
- Shell open URL/file compatibility with persisted local intents and workspace-confined file path normalization
- Menu edit/window command compatibility with persisted local intents for app-shell execution
- Session event/control command compatibility with persisted local-state records for imported chat UI actions
- Notification show/navigate compatibility with persisted local-state events and native-execution boundaries
- Terminal record/frequent-command compatibility backed by persisted terminal history and hideable suggestions
- RPC changed/broadcast event compatibility with a persisted local replay log for imported Web UI sync signals
- Task run/output/result RPC compatibility with persisted run state, run history, output text, and generated task drafts
- Knowledge Lark/Wiki skill install RPC compatibility that writes workspace-local `.craft-agent/skills/*/SKILL.md`
- Knowledge draft/task-plan confirmation RPC compatibility with persisted review events and task reports
- Resource export/import RPC compatibility with workspace-confined manifest writes and authorized resource copy/import execution
- LLM connection test compatibility with connected/failed/needs_credentials results and persisted redacted test history
- Workspace-confined file RPC write/stat/exists/delete compatibility in addition to read, picker, thumbnail, and attachments
- ChatGPT/Copilot/xAI OAuth start compatibility with persisted local pending sessions and provider authorization URLs
- All 430 recognized original Web UI RPC channel constants are now handled by the clean-room WebSocket bridge, including nested Messaging channels, with native-only actions represented as deterministic local state or safe unavailable boundary responses
- Automation config validation, scheduler ticks, local execution for prompt/webhook actions, and original Web UI RPC compatibility for listing, toggling, duplicating, deleting, testing, replaying, and reading history
- Source config discovery and validation for MCP/API/local integrations
- Headless HTTP/SSE/WebSocket server for local UI and client integration, with a Craft-compatible `craft-server` executable entrypoint
- macOS `.app` bundle packager with YuuMira bundle id, URL schemes, server resources, and web UI layout
- Protocol lifecycle events for runs, assistant messages, tool calls, completion, and failures
- Queued follow-up messages with acknowledgement, persisted replay state, and protocol replay events
- Cooperative stop/resume run control with persisted heartbeats and watchdog stale-run diagnostics
- Keep-awake power leases for long-running agent runs, with macOS `caffeinate` assertion support, CLI/API/tools exposure, and release on completion, stop, or failure
- Provider streaming with assistant token deltas, streamed tool-call deltas, and malformed tool-argument repair diagnostics
- Static web UI for runs, sessions, threads, extensions, provider state, and live events
- Pluggable model providers, including deterministic local mode and OpenAI-compatible chat completions
- CLI for creating threads, running tasks, and inspecting state
- Node test coverage for the core runtime

## Quick start

```bash
npm test
npm run demo
```

Run a task:

```bash
node ./bin/yuumira.mjs run "List project files"
```

Show threads:

```bash
node ./bin/yuumira.mjs threads
```

Show a thread transcript:

```bash
node ./bin/yuumira.mjs show <thread-id>
```

Inspect run protocol events:

```bash
node ./bin/yuumira.mjs protocol
node ./bin/yuumira.mjs protocol --thread <thread-id>
node ./bin/yuumira.mjs protocol --type tool.completed
```

Inspect or replay queued follow-up messages:

```bash
node ./bin/yuumira.mjs queue list
node ./bin/yuumira.mjs queue add <thread-id> "Follow up on the last result"
node ./bin/yuumira.mjs queue replay <thread-id>
```

Inspect or control active runs:

```bash
node ./bin/yuumira.mjs run-control list
node ./bin/yuumira.mjs run-control stop <thread-id> "User stopped"
node ./bin/yuumira.mjs run-control resume <thread-id> "Continue from here"
node ./bin/yuumira.mjs run-control watchdog 30000
node ./bin/yuumira.mjs power state
```

Inspect or select a model provider:

```bash
node ./bin/yuumira.mjs provider
node ./bin/yuumira.mjs provider model-request anthropic --api-key test-key
node ./bin/yuumira.mjs provider models ollama --ollama-tags
YUUMIRA_PROVIDER=openai-compatible OPENAI_API_KEY=... OPENAI_MODEL=gpt-4.1-mini node ./bin/yuumira.mjs run "List project files"
```

Inspect Craft-style configuration surfaces:

```bash
node ./bin/yuumira.mjs config
node ./bin/yuumira.mjs permissions check "ls -la"
node ./bin/yuumira.mjs permissions check /workspace/tmp/out.txt --kind write
node ./bin/yuumira.mjs permissions check /api/status --kind api --method GET
node ./bin/yuumira.mjs skills
node ./bin/yuumira.mjs workflows
```

Inspect citable memory:

```bash
node ./bin/yuumira.mjs memory remember "Prefer focused implementation notes"
node ./bin/yuumira.mjs memory search focused
node ./bin/yuumira.mjs memory context focused
node ./bin/yuumira.mjs memory citations "[memory:memory_example]"
node ./bin/yuumira.mjs memory extract "Remember prefer concise implementation notes" --persist
node ./bin/yuumira.mjs memory maintain --max 500 --max-removed 25 --scan-citations
node ./bin/yuumira.mjs memory maintain --user-compat
```

Inspect indexed knowledge:

```bash
node ./bin/yuumira.mjs knowledge create Notes ./notes
node ./bin/yuumira.mjs knowledge index <collection-id>
node ./bin/yuumira.mjs knowledge search ripgrep
node ./bin/yuumira.mjs knowledge inspect
node ./bin/yuumira.mjs knowledge repair
node ./bin/yuumira.mjs knowledge report
node ./bin/yuumira.mjs knowledge semantic
node ./bin/yuumira.mjs knowledge semantic-job --collection <collection-id>
```

Inspect source authentication:

```bash
node ./bin/yuumira.mjs sources auth-help openai
node ./bin/yuumira.mjs credentials storage
node ./bin/yuumira.mjs credentials save openai bearer "$OPENAI_API_KEY"
node ./bin/yuumira.mjs sources auth-save openai '{"token":"sk-test"}'
node ./bin/yuumira.mjs sources auth-state openai
node ./bin/yuumira.mjs sources signature openai
node ./bin/yuumira.mjs sources test openai
node ./bin/yuumira.mjs sources icon openai
node ./bin/yuumira.mjs sources mcp-tools my-mcp
node ./bin/yuumira.mjs sources mcp-call my-mcp echo '{"text":"hello"}'
node ./bin/yuumira.mjs sources oauth-url my-mcp --state local --pkce
node ./bin/yuumira.mjs sources oauth-device my-mcp
node ./bin/yuumira.mjs sources oauth-callback my-mcp
node ./bin/yuumira.mjs sources oauth-poll-device my-mcp <device-code>
```

Set `YUUMIRA_CREDENTIAL_STORE=macos-keychain` to keep credential secret values in macOS Keychain while `.yumira/credentials.json` stores only metadata and secret references. Without that setting, the clean-room runtime keeps the current portable JSON credential format.

Manage Craft-style sessions and metadata:

```bash
node ./bin/yuumira.mjs statuses
node ./bin/yuumira.mjs statuses create blocked "Blocked"
node ./bin/yuumira.mjs statuses default blocked
node ./bin/yuumira.mjs statuses delete blocked --replacement todo
node ./bin/yuumira.mjs labels validate
node ./bin/yuumira.mjs labels create priority "Priority" --value-type number
node ./bin/yuumira.mjs labels create frontend "Frontend" --parent eng
node ./bin/yuumira.mjs labels update priority --name "Priority Score"
node ./bin/yuumira.mjs labels delete priority
node ./bin/yuumira.mjs sessions create "Investigate a bug"
node ./bin/yuumira.mjs sessions status <session-id> needs-review
node ./bin/yuumira.mjs sessions label <session-id> bug
node ./bin/yuumira.mjs projects create "Launch"
node ./bin/yuumira.mjs projects update <project-id> --name "Launch Ops"
node ./bin/yuumira.mjs tasks create "Write release notes" --project <project-id> --labels docs,release
node ./bin/yuumira.mjs tasks list --status done --label release --query notes
node ./bin/yuumira.mjs tasks update <task-id> --title "Publish release notes" --status done
node ./bin/yuumira.mjs views create Done tasks --filters '{"statusId":"done"}' --sort updatedAt:desc
node ./bin/yuumira.mjs views update <view-id> --filters '{"label":"release"}'
node ./bin/yuumira.mjs search release
```

Inspect command history, Git parser output, and command resources:

```bash
node ./bin/import-yuumira-resources.mjs --from /Applications/YuuMira.app/Contents/Resources/resources --out resources
node ./bin/yuumira.mjs terminal record "npm test" 0
node ./bin/yuumira.mjs terminal run "node -e \"console.log('ok')\""
node ./bin/yuumira.mjs terminal session-create Build
node ./bin/yuumira.mjs terminal run --session <session-id> "node -e \"console.log('ok')\""
node ./bin/yuumira.mjs terminal sessions
node ./bin/yuumira.mjs terminal session-attach <session-id> <record-id>
node ./bin/yuumira.mjs terminal session-close <session-id>
node ./bin/yuumira.mjs terminal
node ./bin/yuumira.mjs terminal append <record-id> stdout "ok"
node ./bin/yuumira.mjs terminal finish <record-id> 0
node ./bin/yuumira.mjs terminal replay <record-id>
node ./bin/yuumira.mjs git parse-status ' M src/app.js\n?? notes.md'
node ./bin/yuumira.mjs git log-format
node ./bin/yuumira.mjs tool-icons "npm test"
node ./bin/yuumira.mjs resources
node ./bin/yuumira.mjs resources tool-icons
node ./bin/import-yuumira-resources.mjs --include-webui
node ./bin/yuumira.mjs audit --json
node ./bin/yuumira.mjs helpers
node ./bin/yuumira.mjs helpers smoke-profiles
node ./bin/yuumira.mjs helpers plan docx-tool --help
node ./bin/yuumira.mjs helpers run docx-tool --help --json
node ./bin/yuumira.mjs helpers smoke --profile help --json --timeout-ms 60000
node ./bin/yuumira.mjs helpers behavior-smoke --profile ical-basic --json --timeout-ms 60000
node ./bin/yuumira.mjs helpers behavior-smoke --profile xlsx-basic --json --timeout-ms 60000
node ./bin/yuumira.mjs helpers behavior-smoke --profile docx-basic --json --timeout-ms 60000
node ./bin/yuumira.mjs helpers behavior-smoke --profile img-basic --json --timeout-ms 60000
node ./bin/yuumira.mjs helpers behavior-smoke --profile markitdown-basic --json --timeout-ms 60000
node ./bin/yuumira.mjs helpers behavior-smoke --profile pdf-basic --json --timeout-ms 60000
node ./bin/yuumira.mjs helpers behavior-smoke --profile pptx-basic --json --timeout-ms 60000
node ./bin/yuumira.mjs helpers behavior-smoke --profile doc-diff-basic --json --timeout-ms 60000
```

The HTTP/tool terminal surface also supports persisted terminal sessions, background command start, stdin input, resize events, live process status, cancellation, and replay through `/api/terminal/sessions`, `/api/terminal/start`, `/api/terminal/history/:id/input`, `/api/terminal/history/:id/resize`, `/api/terminal/history/:id/process`, `/api/terminal/history/:id/cancel`, and `/api/terminal/history/:id/replay`.

Imported YuuMira resources include shared docs/themes/icons/helper scripts and, when imported with `--include-webui`, the authorized server web UI distribution under `resources/webui/`. Imported helper wrappers are exposed through CLI/API/tool surfaces. `helpers plan` shows the exact wrapper, script, PEP 723 dependencies, arguments, and Craft-style `CRAFT_UV`/`CRAFT_SCRIPTS` environment without executing it; `helpers run` executes only a known imported wrapper from `resources/bin`; `helpers smoke` runs lightweight per-wrapper probes and reports `ok`, exit code, timeout state, stdout, stderr, and a diagnosis such as `ok`, `timeout`, `uv-cache-permission`, or `dependency-resolution`. The standard `help` smoke profile runs `--help` against the eight document/media helpers: `doc-diff`, `docx-tool`, `ical-tool`, `img-tool`, `markitdown`, `pdf-tool`, `pptx-tool`, and `xlsx-tool`.
When `resources/webui` exists, the headless server serves it as the default static app at `/`, and macOS packaging uses it by default for `Contents/Resources/server/resources/webui/`.
`yuumira audit --json` compares the authorized installed YuuMira `.app` bundle shape with this clone's imported resources and behavior profiles, producing machine-readable `ok`/`gap` checks for identity, server package manifests, package export coverage, webui/resources, Web UI RPC channel coverage, helper coverage, imported resource file manifests, SHA-256 content fingerprints, root resource file hashes, and Finder-style duplicate resource variants.
Package export coverage maps observed package exports to local clone modules so remaining API-surface gaps can be tracked; behavior parity for each export still needs targeted tests as the clone deepens.
`helpers behavior-smoke --profile ical-basic` performs a real file-processing loop through `ical-tool create`, `ical-tool read --format json`, and `ical-tool filter --format json`. `helpers behavior-smoke --profile xlsx-basic` writes a workbook, reads it as JSON, exports CSV, and adds a sheet through the real `xlsx-tool` wrapper. `helpers behavior-smoke --profile docx-basic` creates a document, extracts text, fills a template, replaces text, and verifies the extracted output through the real `docx-tool` wrapper. `helpers behavior-smoke --profile img-basic` inspects, resizes, and converts a PNG image. `helpers behavior-smoke --profile markitdown-basic` converts plain text and a generated `.docx` file through the real `markitdown` wrapper. `pdf-basic`, `pptx-basic`, and `doc-diff-basic` cover PDF image/sanitize, slide deck create/info/extract, and document comparison summaries.

Inspect automation and source surfaces:

```bash
node ./bin/yuumira.mjs automations validate
node ./bin/yuumira.mjs automations lint
node ./bin/yuumira.mjs automations test '{"type":"LabelAdd","label":"urgent"}'
node ./bin/yuumira.mjs automations run '{"type":"Notification","matchValue":"build"}' --execute-webhooks
node ./bin/yuumira.mjs automations tick --now 2026-08-07T09:30:00.000Z
node ./bin/yuumira.mjs automations history
node ./bin/yuumira.mjs sources
node ./bin/yuumira.mjs sources validate
```

Start the local API server:

```bash
node ./bin/yuumira.mjs server --port 4721
node ./bin/craft-server.mjs --port 4721 --json
```

Build a Bun-compiled craft-server executable:

```bash
node ./bin/build-craft-server.mjs --outfile dist/craft-server
node ./bin/build-craft-server.mjs --outfile dist/craft-server --verify
node ./bin/build-craft-server.mjs --dry-run --target bun-darwin-arm64
```

Package the Peng v0.1.0 macOS app bundle:

```bash
npm run package:macos
node ./bin/package-macos-app.mjs --out dist/Peng.app --sign --verify
node ./bin/package-macos-app.mjs --server-binary dist/craft-server --out dist/Peng.app --sign --verify
```

Open `http://127.0.0.1:4721/` for the web UI. See `docs/protocol.md` for the JSON API, SSE event stream, and WebSocket command transport.

Current reverse-engineering notes are tracked in `docs/research-yuumira-0.11.11.md`.

## Model providers

The default provider is deterministic and local. It is useful for development and tests.

Provider profiles are selected with `YUUMIRA_PROVIDER`:

- `deterministic`
- `openai` / `openai-compatible`
- `openrouter`
- `anthropic`
- `ollama`
- `lmstudio`
- `anthropic-compatible`

Run `node ./bin/yuumira.mjs provider list` to inspect built-in profiles. OpenAI-compatible profiles use profile-specific variables such as `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OLLAMA_BASE_URL`, or `LMSTUDIO_MODEL`, and fall back to `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` where appropriate. The native Anthropic profile uses `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL`.

Provider model-list helpers are exposed through the CLI, HTTP API, runtime tools, and the `src/model-fetchers.js` compatibility module. `provider model-request` plans the exact request without touching the network; `provider models` executes it and normalizes OpenAI-compatible, Anthropic, and Ollama `/api/tags` responses.

Providers implement the `complete()` contract in `src/provider.js`; streaming providers can additionally implement `streamComplete()` to emit assistant and tool-call deltas into the protocol event stream. The rest of the runtime only depends on these interfaces:

```js
await provider.complete({
  system,
  messages,
  tools,
  context
});
```

## Authorized Reverse-Engineering Boundary

This project is built from public Craft Agents surfaces, user-authorized observation of the installed YuuMira bundle, product behavior, and original implementation work. Do not import proprietary source, bypass protections, or copy private implementation details verbatim.
