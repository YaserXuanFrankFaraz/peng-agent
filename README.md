# Peng v0.1.0

Peng is a self-contained AI agent application foundation. The runtime, web UI, resources, and macOS bundle are built from files shipped in this repository; Peng does not require another installed application.

## What is included

- Agent runtime with deterministic planning and tool execution
- Multi-step agent loop that feeds tool results back into the provider
- Thread and event persistence under `.peng/`
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
- Terminal command history, persisted session metadata, real workspace Git status/history/diff/branch/stash/worktree RPC helpers, Git status/log parsing, and Peng-style resource/tool icon manifest with static asset serving
- Optional resource import for tool icons, themes, docs, release notes, permissions, logos, helper bin wrappers, scripts, and default resource files. Peng's own bundled resources are used by default.
- Bundled Web UI entrypoint integrity checks for `index.html`/`login.html` scripts, styles, icons, and manifest references, plus boot-time config/workspace/logout endpoint and Craft RPC WebSocket compatibility for sessions, projects, tasks, labels, statuses, views, sources, knowledge/vault/QMD state, local semantic index search, messaging/provider-auth state, local Telegram/Lark/WhatsApp messaging gateway lifecycle, WhatsApp connect-phone RPC state, messaging access-control RPC state, inbound-message sessions, loop/goal state, persisted window focus/close/new-window request state, browser-pane navigation/history with optional HTML snapshot extraction, update/Pilot/RTK/computer-use status, safe menu/shell/auth/dialog/deeplink/debug acknowledgements, preferences, drafts, theme/input/power/settings, LLM connection lists/defaults/tests, model/onboarding/workspace settings, workspace file/image/permission RPCs, workspace-confined file watcher events, release notes, memory/cache/observability toggles, terminal probes, and safe workspace file reads
- Local push-notification compatibility for Web UI boot flows, including a deterministic browser application-server key and persisted PushManager subscription records
- Local updater compatibility state for check/download progress/dismiss/install-complete Web UI flows without invoking the native macOS updater
- Local observability compatibility for session traces, estimated session usage, and unlimited quota summaries backed by persisted protocol events
- Remote connection test compatibility using real HTTP probes with status, latency, and error classification
- Computer-use permission compatibility with persisted prompt/request/opened/granted/denied state for Web UI flows
- Pilot runtime compatibility state for local install/start/stop/dashboard Web UI flows
- RTK compatibility state with persisted enabled/disabled timing and local gain reporting
- Workspace-local file and folder dialog compatibility for imported Web UI flows without invoking native pickers
- Workspace-local skill editor/Finder open intent recording for imported skill-management flows
- Workspace-local skill soft-delete compatibility that archives deleted skills under `.peng/deleted-skills`
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
- macOS `.app` bundle packager with Peng bundle id, URL schemes, server resources, and web UI layout
- Finder-launchable macOS app lifecycle: double-click starts the bundled local server and renders the Web UI inside a native AppKit/WKWebView window; `--status` and `--stop` manage the local process
- Compressed `Peng v0.1.0.dmg` installer image with an `/Applications` shortcut
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
node ./bin/peng.mjs run "List project files"
```

Show threads:

```bash
node ./bin/peng.mjs threads
```

Show a thread transcript:

```bash
node ./bin/peng.mjs show <thread-id>
```

Inspect run protocol events:

```bash
node ./bin/peng.mjs protocol
node ./bin/peng.mjs protocol --thread <thread-id>
node ./bin/peng.mjs protocol --type tool.completed
```

Inspect or replay queued follow-up messages:

```bash
node ./bin/peng.mjs queue list
node ./bin/peng.mjs queue add <thread-id> "Follow up on the last result"
node ./bin/peng.mjs queue replay <thread-id>
```

Inspect or control active runs:

```bash
node ./bin/peng.mjs run-control list
node ./bin/peng.mjs run-control stop <thread-id> "User stopped"
node ./bin/peng.mjs run-control resume <thread-id> "Continue from here"
node ./bin/peng.mjs run-control watchdog 30000
node ./bin/peng.mjs power state
```

Inspect or select a model provider:

```bash
node ./bin/peng.mjs provider
node ./bin/peng.mjs provider model-request anthropic --api-key test-key
node ./bin/peng.mjs provider models ollama --ollama-tags
PENG_PROVIDER=openai-compatible OPENAI_API_KEY=... OPENAI_MODEL=gpt-4.1-mini node ./bin/peng.mjs run "List project files"
```

Inspect Craft-style configuration surfaces:

```bash
node ./bin/peng.mjs config
node ./bin/peng.mjs permissions check "ls -la"
node ./bin/peng.mjs permissions check /workspace/tmp/out.txt --kind write
node ./bin/peng.mjs permissions check /api/status --kind api --method GET
node ./bin/peng.mjs skills
node ./bin/peng.mjs workflows
```

Inspect citable memory:

```bash
node ./bin/peng.mjs memory remember "Prefer focused implementation notes"
node ./bin/peng.mjs memory search focused
node ./bin/peng.mjs memory context focused
node ./bin/peng.mjs memory citations "[memory:memory_example]"
node ./bin/peng.mjs memory extract "Remember prefer concise implementation notes" --persist
node ./bin/peng.mjs memory maintain --max 500 --max-removed 25 --scan-citations
node ./bin/peng.mjs memory maintain --user-compat
```

Inspect indexed knowledge:

```bash
node ./bin/peng.mjs knowledge create Notes ./notes
node ./bin/peng.mjs knowledge index <collection-id>
node ./bin/peng.mjs knowledge search ripgrep
node ./bin/peng.mjs knowledge inspect
node ./bin/peng.mjs knowledge repair
node ./bin/peng.mjs knowledge report
node ./bin/peng.mjs knowledge semantic
node ./bin/peng.mjs knowledge semantic-job --collection <collection-id>
```

Inspect source authentication:

```bash
node ./bin/peng.mjs sources auth-help openai
node ./bin/peng.mjs credentials storage
node ./bin/peng.mjs credentials save openai bearer "$OPENAI_API_KEY"
node ./bin/peng.mjs sources auth-save openai '{"token":"sk-test"}'
node ./bin/peng.mjs sources auth-state openai
node ./bin/peng.mjs sources signature openai
node ./bin/peng.mjs sources test openai
node ./bin/peng.mjs sources icon openai
node ./bin/peng.mjs sources mcp-tools my-mcp
node ./bin/peng.mjs sources mcp-call my-mcp echo '{"text":"hello"}'
node ./bin/peng.mjs sources oauth-url my-mcp --state local --pkce
node ./bin/peng.mjs sources oauth-device my-mcp
node ./bin/peng.mjs sources oauth-callback my-mcp
node ./bin/peng.mjs sources oauth-poll-device my-mcp <device-code>
```

Set `PENG_CREDENTIAL_STORE=macos-keychain` to keep credential secret values in macOS Keychain while `.peng/credentials.json` stores only metadata and secret references. Without that setting, the runtime keeps the portable JSON credential format.

Manage Craft-style sessions and metadata:

```bash
node ./bin/peng.mjs statuses
node ./bin/peng.mjs statuses create blocked "Blocked"
node ./bin/peng.mjs statuses default blocked
node ./bin/peng.mjs statuses delete blocked --replacement todo
node ./bin/peng.mjs labels validate
node ./bin/peng.mjs labels create priority "Priority" --value-type number
node ./bin/peng.mjs labels create frontend "Frontend" --parent eng
node ./bin/peng.mjs labels update priority --name "Priority Score"
node ./bin/peng.mjs labels delete priority
node ./bin/peng.mjs sessions create "Investigate a bug"
node ./bin/peng.mjs sessions status <session-id> needs-review
node ./bin/peng.mjs sessions label <session-id> bug
node ./bin/peng.mjs projects create "Launch"
node ./bin/peng.mjs projects update <project-id> --name "Launch Ops"
node ./bin/peng.mjs tasks create "Write release notes" --project <project-id> --labels docs,release
node ./bin/peng.mjs tasks list --status done --label release --query notes
node ./bin/peng.mjs tasks update <task-id> --title "Publish release notes" --status done
node ./bin/peng.mjs views create Done tasks --filters '{"statusId":"done"}' --sort updatedAt:desc
node ./bin/peng.mjs views update <view-id> --filters '{"label":"release"}'
node ./bin/peng.mjs search release
```

Inspect command history, Git parser output, and command resources:

```bash
node ./bin/import-peng-resources.mjs --from <resource-directory> --out resources
node ./bin/peng.mjs terminal record "npm test" 0
node ./bin/peng.mjs terminal run "node -e \"console.log('ok')\""
node ./bin/peng.mjs terminal session-create Build
node ./bin/peng.mjs terminal run --session <session-id> "node -e \"console.log('ok')\""
node ./bin/peng.mjs terminal sessions
node ./bin/peng.mjs terminal session-attach <session-id> <record-id>
node ./bin/peng.mjs terminal session-close <session-id>
node ./bin/peng.mjs terminal
node ./bin/peng.mjs terminal append <record-id> stdout "ok"
node ./bin/peng.mjs terminal finish <record-id> 0
node ./bin/peng.mjs terminal replay <record-id>
node ./bin/peng.mjs git parse-status ' M src/app.js\n?? notes.md'
node ./bin/peng.mjs git log-format
node ./bin/peng.mjs tool-icons "npm test"
node ./bin/peng.mjs resources
node ./bin/peng.mjs resources tool-icons
node ./bin/import-peng-resources.mjs --include-webui
node ./bin/peng.mjs audit --json
node ./bin/peng.mjs helpers
node ./bin/peng.mjs helpers smoke-profiles
node ./bin/peng.mjs helpers plan docx-tool --help
node ./bin/peng.mjs helpers run docx-tool --help --json
node ./bin/peng.mjs helpers smoke --profile help --json --timeout-ms 60000
node ./bin/peng.mjs helpers behavior-smoke --profile ical-basic --json --timeout-ms 60000
node ./bin/peng.mjs helpers behavior-smoke --profile xlsx-basic --json --timeout-ms 60000
node ./bin/peng.mjs helpers behavior-smoke --profile docx-basic --json --timeout-ms 60000
node ./bin/peng.mjs helpers behavior-smoke --profile img-basic --json --timeout-ms 60000
node ./bin/peng.mjs helpers behavior-smoke --profile markitdown-basic --json --timeout-ms 60000
node ./bin/peng.mjs helpers behavior-smoke --profile pdf-basic --json --timeout-ms 60000
node ./bin/peng.mjs helpers behavior-smoke --profile pptx-basic --json --timeout-ms 60000
node ./bin/peng.mjs helpers behavior-smoke --profile doc-diff-basic --json --timeout-ms 60000
```

The HTTP/tool terminal surface also supports persisted terminal sessions, background command start, stdin input, resize events, live process status, cancellation, and replay through `/api/terminal/sessions`, `/api/terminal/start`, `/api/terminal/history/:id/input`, `/api/terminal/history/:id/resize`, `/api/terminal/history/:id/process`, `/api/terminal/history/:id/cancel`, and `/api/terminal/history/:id/replay`.

Imported Peng resources include shared docs/themes/icons/helper scripts and, when imported with `--include-webui`, the authorized server web UI distribution under `resources/webui/`. Imported helper wrappers are exposed through CLI/API/tool surfaces. `helpers plan` shows the exact wrapper, script, PEP 723 dependencies, arguments, and Craft-style `CRAFT_UV`/`CRAFT_SCRIPTS` environment without executing it; `helpers run` executes only a known imported wrapper from `resources/bin`; `helpers smoke` runs lightweight per-wrapper probes and reports `ok`, exit code, timeout state, stdout, stderr, and a diagnosis such as `ok`, `timeout`, `uv-cache-permission`, or `dependency-resolution`. The standard `help` smoke profile runs `--help` against the eight document/media helpers: `doc-diff`, `docx-tool`, `ical-tool`, `img-tool`, `markitdown`, `pdf-tool`, `pptx-tool`, and `xlsx-tool`.
When `resources/webui` exists, the headless server serves it as the default static app at `/`, and macOS packaging uses it by default for `Contents/Resources/server/resources/webui/`.
`peng audit --json` audits a local Peng `.app` bundle against the repository resources and behavior profiles, producing machine-readable `ok`/`gap` checks for identity, server package manifests, package export coverage, webui/resources, Web UI RPC channel coverage, helper coverage, resource manifests, SHA-256 content fingerprints, root resource file hashes, and Finder-style duplicate resource variants.
Package export coverage maps observed package exports to local clone modules so remaining API-surface gaps can be tracked; behavior parity for each export still needs targeted tests as the clone deepens.
`helpers behavior-smoke --profile ical-basic` performs a real file-processing loop through `ical-tool create`, `ical-tool read --format json`, and `ical-tool filter --format json`. `helpers behavior-smoke --profile xlsx-basic` writes a workbook, reads it as JSON, exports CSV, and adds a sheet through the real `xlsx-tool` wrapper. `helpers behavior-smoke --profile docx-basic` creates a document, extracts text, fills a template, replaces text, and verifies the extracted output through the real `docx-tool` wrapper. `helpers behavior-smoke --profile img-basic` inspects, resizes, and converts a PNG image. `helpers behavior-smoke --profile markitdown-basic` converts plain text and a generated `.docx` file through the real `markitdown` wrapper. `pdf-basic`, `pptx-basic`, and `doc-diff-basic` cover PDF image/sanitize, slide deck create/info/extract, and document comparison summaries.

Inspect automation and source surfaces:

```bash
node ./bin/peng.mjs automations validate
node ./bin/peng.mjs automations lint
node ./bin/peng.mjs automations test '{"type":"LabelAdd","label":"urgent"}'
node ./bin/peng.mjs automations run '{"type":"Notification","matchValue":"build"}' --execute-webhooks
node ./bin/peng.mjs automations tick --now 2026-08-07T09:30:00.000Z
node ./bin/peng.mjs automations history
node ./bin/peng.mjs sources
node ./bin/peng.mjs sources validate
```

Start the local API server:

```bash
node ./bin/peng.mjs server --port 4721
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

Create the installable DMG (macOS only):

```bash
npm run package:dmg
```

The resulting `dist/Peng-v0.1.0.dmg` contains a self-contained `Peng.app`. Open the DMG, drag Peng to Applications, and double-click `Peng.app`; it starts the bundled server and renders the Web UI in Peng's own native window. It does not open Chrome or Safari. The app stores runtime state under `.peng/` in the selected workspace and keeps its launcher state under `~/Library/Application Support/Peng`.

For an existing app bundle, use `dist/Peng.app/Contents/MacOS/Peng --status` or `--stop`. To select a workspace, set `PENG_WORKSPACE=/path/to/workspace` before launching. See `docs/protocol.md` for the JSON API, SSE event stream, and WebSocket command transport.

## Model providers

The default provider is deterministic and local. It is useful for development and tests.

Provider profiles are selected with `PENG_PROVIDER`:

- `deterministic`
- `openai` / `openai-compatible`
- `openrouter`
- `anthropic`
- `ollama`
- `lmstudio`
- `anthropic-compatible`

Run `node ./bin/peng.mjs provider list` to inspect built-in profiles. OpenAI-compatible profiles use profile-specific variables such as `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OLLAMA_BASE_URL`, or `LMSTUDIO_MODEL`, and fall back to `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` where appropriate. The native Anthropic profile uses `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL`.

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

## Implementation Boundary

Peng is implemented from public Craft Agents surfaces, authorized product observations, product behavior, and original implementation work. The packaged application is self-contained and does not load code or resources from another installed app.
