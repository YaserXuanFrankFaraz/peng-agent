# YuuMira 0.11.x Research Notes

These notes record observable facts from the locally installed, authorized YuuMira application bundle. They are used to guide this repository's implementation work.

## Bundle Identity

- App path: `/Applications/YuuMira.app`
- Bundle display name: `YuuMira`
- Bundle identifier: `app.yuuone.yuumira`
- Current local installed version verified by bundle audit: `0.11.12`
- Executable: `craft-agents-tauri`
- URL schemes: `yuumira`, `craftagents`

## Distributed Components

- Tauri desktop executable under `Contents/MacOS/`
- Server distribution under `Contents/Resources/server/`
- Web UI assets under `Contents/Resources/server/resources/webui/`
- Shared resources under `Contents/Resources/resources/`
- Tool binaries/scripts for document, spreadsheet, image, calendar, Markdown, and PDF workflows
- Built-in docs for statuses, workflows, permissions, skills, sources, themes, labels, automations, previews, data tables, and browser tools
- Tool icon resources under `resources/tool-icons/`, including `tool-icons.json` and command icon assets
- Server web UI distribution under `server/resources/webui/`, including `index.html`, `login.html`, PWA icon/manifest files, and hashed JS/CSS/font/image assets

## Package Map

The server package declares a private workspace named `craft-server-dist` with these package manifests:

- `@craft-agent/core`: core types, storage, and agent logic
- `@craft-agent/server`: standalone headless server for Bun
- `@craft-agent/server-core`: reusable headless server infrastructure
- `@craft-agent/shared`: agent, auth, config, credentials, MCP integration, sessions, tasks, projects, sources, memory, skills, automations, protocol, goals, knowledge, terminal, labels, views, search, tools, resources
- `@craft-agent/session-tools-core`: shared utilities for session-scoped tools
- `@craft-agent/pi-agent-server`: out-of-process Pi agent server over JSONL stdio
- `@craft-agent/messaging-gateway`: messaging gateway package
- `@craft-agent/messaging-whatsapp-worker`: WhatsApp worker package

The manifests declare Apache-2.0 licenses for the Craft packages observed in the bundle.

Observed package export coverage against this clone is tracked by `yuumira audit --json`. The installed bundle exposes 93 package exports, all of which are now mapped to local clone modules by conservative module-name coverage. This proves package-level export surface coverage, not deep behavior parity; native desktop bridge behavior, worker semantics, model fetchers, power management, and richer utility edge cases still need behavior-level verification.

## Behavior Targets Captured So Far

- Workspace-scoped session statuses with fixed/default/custom status types
- The shared package exposes task, project, view, and search modules as first-class product domains
- Session statuses are exclusive; labels are additive and can be hierarchical
- Domain events include `LabelAdd`, `LabelRemove`, `PermissionModeChange`, `FlagChange`, and `SessionStatusChange`
- Automations are stored as workspace-level `automations.json` with version `2`, keyed by event name
- Automation actions include `prompt` and `webhook`; prompt actions create sessions, webhook actions expand `CRAFT_*` and `CRAFT_WH_*` variables
- Sources are workspace folders containing `config.json`, optional `guide.md`, optional `permissions.json`, and optional icons
- Source types include `mcp`, `api`, and `local`; MCP supports HTTP/OAuth/bearer/none and stdio command transport
- Source auth state fields include `isAuthenticated`, `connectionStatus` (`connected`, `needs_auth`, `failed`, `untested`), and numeric `lastTestedAt`; authenticated API sources require `testEndpoint`
- API source auth modes include bearer, header, multi-header, query, basic, oauth, and none; basic auth can allow optional passwords
- `source_test` validates schema, tests connectivity, downloads icons, and updates `connectionStatus`; authenticated API `testEndpoint.path` must be relative and lightweight; public API sources can test the base URL
- Non-OAuth bearer sources can define `renewEndpoint` with token substitution, token/expires fields, and fallback TTL; tokens are refreshed before API requests when expiry is near
- The distributed app includes a Bun-packaged `craft-server` executable, web assets, and `server-core`/`protocol` package exports, indicating a headless server boundary beneath the desktop shell
- Release notes describe queued mid-stream message acknowledgement, visible tool calls, malformed tool-call recovery, SSE diagnostics, retryable queued replay failures, and session message loading recovery; these imply durable protocol/run lifecycle events beneath the UI
- Package manifests depend on `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, and Claude SDK/MCP peer dependencies, indicating a pluggable provider/agent runtime beneath the UI
- Shared package exports include `terminal/db`, `terminal/types`, `git/history-parse`, `git/status-parse`, and `resources`
- Safe/explore permission model with read-oriented Bash, MCP, and API allow rules
- Skills stored as `SKILL.md` folders using Claude Code SDK-compatible frontmatter
- Workflow markdown discovery from `workflow/*.md` with runnable `loop: v1` frontmatter
- Defaults for app settings, memory extraction, thinking level, permission mode, and local MCP
- Memory MVP: `codexMemoryEnabled` off by default, `UserPromptSubmit` as the P0 event, user-level `~/.craft-agent/memory/memories.jsonl`, redaction before saving, secret rejection, bounded `<memory_context>` injection, and `[memory:<id>]` citations
- Knowledge/QMD preview: `knowledgeCockpitEnabled` off by default, Settings → Knowledge manages semantic search for Obsidian vaults, index reports show per-collection document counts/gaps/model status/maintenance actions, literal search uses ripgrep for large vaults and in-process scan for smaller vaults, deleting a knowledge source clears its scheduled ingestion
- Credential store behavior: writes are atomic, unreadable stores are renamed aside instead of deleted, credential presence participates in agent restart signatures, OAuth refresh happens before server/source build to avoid transient `needs_auth` flicker

## Implemented In This Repository

- Local thread/event runtime
- Tool registry
- Workspace read/list tools with path containment
- Memory remember/search tools
- Craft-style JSONL memory records with redaction, retrospective candidate extraction, citation extraction/usage scanning, historical assistant/protocol citation scanning, consolidation, retention pruning with per-run removal caps, rendered `.yumira/memory/MEMORIES.md`, workspace `.craft-agent/memories/` compatibility products, optional user-home `~/.craft-agent/memories/` sync, bounded context rendering, and explicit runtime context injection
- Knowledge Cockpit foundation with local collections, collection update/delete, markdown/text indexing, literal search, optional clean-room local semantic index/search, global workspace search integration, index reports, stale/missing document inspection, repair/reindex actions, delete cleanup, persisted semantic model/cache/index state, semantic index job history, and an explicit unavailable fallback when no semantic engine is enabled
- Config defaults matching observed YuuMira defaults
- Safe permission evaluation and validation with deny-first Bash/MCP/API rules, tool allow/deny lists, write-path globs, and source-level allow/deny scoping
- Skill discovery and basic `SKILL.md` parsing
- Workflow discovery and runnable/checkpoint metadata parsing
- Default status configuration and validation
- Status CRUD for workspace custom statuses, default status updates, and deleted-status migration for sessions/tasks
- Hierarchical label parsing, flattening, validation, filtering, CRUD, session label value parsing, and renamed/deleted label reference migration for sessions/tasks
- Workspace, project, and session domain constructors
- Session status/label updates with persisted domain events
- Project model with update/delete lifecycle and deleted-project detachment for session/task references
- Task model with status transitions, update/delete lifecycle, project/session association, label/query/sort filtering, and completion timestamps
- Saved view model with update/delete lifecycle, entity filtering, label-aware filters, sorting, and workspace search over sessions, projects, tasks, and threads
- Automation validation/linting, event matching, state/time/logical conditions, variable expansion, prompt action session creation, webhook request planning/execution with response capture, per-action rate limits, history persistence, scheduler tick execution, background scheduler lifecycle, HTTP/CLI/tool surfaces, and original Web UI RPC compatibility for list/toggle/duplicate/delete/test/history/last-executed/replay
- Source discovery and config validation for MCP/API/local source folders
- Credential summaries, atomic credential persistence, unreadable credential backup, optional macOS Keychain secret backend, credential-derived restart signatures, executable source auth prompt specs, auth state derivation, and API auth application for bearer/header/multi-header/query/basic modes
- Source test execution for local/API sources, redacted API request summaries, source icon download/cache, persisted numeric `lastTestedAt`, and non-OAuth bearer `renewEndpoint` handling before requests
- Stdio MCP source JSON-RPC handshake with `initialize`, initialized notification, `tools/list`, `tools/call`, source test connection persistence, API/CLI/tool surfaces, and clean process shutdown
- Source-level MCP permission scoping from `permissions.json`, safe-mode tool-call enforcement, and saved credential injection into stdio MCP process env via `mcp.credentialEnv`/`tokenEnv`
- HTTP MCP JSON-RPC handshake over POST with `initialize`, initialized notification, `tools/list`, `tools/call`, source test connection persistence, API/CLI/tool surfaces, and bearer/header credential injection
- OAuth source helpers for authorization URL construction, PKCE/state generation, automatic browser launch, localhost desktop callback capture, device authorization polling, authorization-code exchange, device-code exchange, credential persistence, refresh-token renewal, API endpoints, CLI commands, and tool surfaces
- Terminal command history records with command, cwd, exit code, timestamps, duration, truncated output, persisted terminal session metadata, record association, session listing, and close lifecycle
- Git porcelain status parsing, Git log pretty-format parsing, and status summarization
- YuuMira-compatible resource manifest, imported authorized shared resources from the installed app (`tool-icons`, `themes`, `docs`, `release-notes`, `permissions`, `craft-logos`, `bin`, `scripts`, `config-defaults.json`, and `source.png`), static `/resources/` serving, and tool icon command mapping based on observed `tool-icons.json` with deterministic placeholder fallback assets
- Authorized server web UI asset import via `import-yuumira-resources --include-webui`/`--webui-only`, manifest listing for `resources/webui`, and static serving under `/resources/webui/`
- Original Web UI entrypoint integrity validation for imported `index.html`/`login.html` local scripts, styles, icons, and manifest references, exposed through the resource manifest and bundle audit
- Original Web UI boot compatibility for `/api/config` `wsUrl`, default workspace discovery through `/api/config/workspaces`, `/login` static aliasing, login/logout acknowledgement, and local push-notification subscription persistence
- Original Web UI Craft RPC WebSocket handshake compatibility for the observed `handshake`/`handshake_ack`/`request`/`response` envelope family, plus foundational workspace/session/status/label/view/source/tool-icon request channels, persisted preferences/drafts/theme/input/power/settings RPC state, LLM connection list/default/workspace-default/test compatibility, model/onboarding workspace settings probes, session event/control local-state persistence, onboarding Claude/MCP local OAuth pending/exchange compatibility, workspace file/image/permission/read/write/stat/delete RPC compatibility, workspace-local file/folder picker compatibility, workspace-local skill open intent and soft-delete compatibility, Git Bash browse intent compatibility, ChatGPT/Copilot/xAI local OAuth pending-state compatibility, Copilot/xAI local device-code pending-flow compatibility, local badge icon/count/event state compatibility, notification local event persistence, replayable RPC sync-event logging, shell and menu local intent registration, loop/goal local state compatibility, memory/cache/observability toggles, local observability trace and estimated usage/quota compatibility, terminal command history recommendations, release-note/logo resource channels, resource export/import RPC execution, safe auth/dialog/deeplink/debug RPC acknowledgements, RPC CRUD for projects/tasks/labels/statuses/views/sources/workspaces, task run/output/result local state, `knowledge:*` vault/document/search/graph/QMD-state, review/report, and workspace-local skill-install compatibility, local messaging/provider-auth state compatibility, local Telegram/Lark/WhatsApp messaging gateway lifecycle, WhatsApp connect-phone RPC state, messaging access-control RPC state, inbound session creation, browser-pane local state plus optional HTML snapshot extraction, persisted update check/download/install state, real remote HTTP connection probes, local computer-use permission state, local Pilot install/start/dashboard state, and persisted RTK enable/gain status compatibility
- Full recognized original Web UI RPC constant coverage: 430 extracted channel constants, including nested Messaging channel names, with 0 unhandled clean-room bridge channels in the current imported bundle scan
- Bundle parity audit surface via CLI/API/tooling that compares authorized installed bundle identity, server package manifest summaries/fingerprints, package export coverage, server/webui/resource directory counts, exact clone resource manifests, SHA-256 content fingerprints, root resource file hashes, duplicate resource variants, recognized Web UI RPC channel coverage, and helper behavior profile coverage
- Headless Node HTTP server with JSON endpoints for runtime, domain, memory, knowledge, credentials, extension surfaces, permissions, automations, and sources, plus a Craft-compatible `craft-server` executable entrypoint with manifest/json startup output, Bun compile packaging command, and macOS `.app` bundle packager matching observed bundle id, executable name, URL schemes, server resources, webui resource layout, ad-hoc codesigning, and codesign verification
- Protocol event envelope and persisted lifecycle history for run start, steps, assistant messages, tool start/completion, max-step stop, completion, and failure; SSE broadcasts both generic `protocol.event` and concrete event names
- Queued follow-up message persistence with pending/acknowledged/replaying/applied/failed states, protocol acknowledgement/replay events, API/CLI listing, and automatic replay after the active run drains
- Cooperative run-control persistence for stop requests, stopped threads, provider `AbortSignal` cancellation, resume prompts, heartbeat emission, stale heartbeat watchdog diagnostics, API/CLI/tool surfaces, and Web UI visibility
- Keep-awake power management with lease-counted prevent/allow sleep state, macOS `caffeinate -dimsu` native assertion adapter, runtime integration behind `keepAwakeWhileRunning`, finalizer release on completion/stop/failure, protocol events, and API/CLI/tool surfaces
- Server-Sent Events and WebSocket streams for thread/session/automation/protocol events, with bidirectional WebSocket commands for run start, queued messages, stop requests, queue replay, ping/pong, alias command names, flexible `type`/`event`/`action` input envelopes, and dual `payload`/`data` response envelopes
- Static web UI served by the headless server for runs, sessions, projects, tasks, threads, citable memory, knowledge collections/search/report, terminal history, command resources, extensions, provider state, search, saved views, and live events
- Web UI terminal cockpit for command start/run, stdin input, resize, cancel, history selection, and replay frames
- Helper wrapper discovery/planning/execution/smoke-check layer for imported `resources/bin/*`, with linked script detection, PEP 723 dependency extraction, Craft-style `CRAFT_UV`, `CRAFT_SCRIPTS`, and `CRAFT_BUN` environment injection, execution diagnosis, plus CLI/API/tool surfaces
- Standard helper `help` smoke profile covering `doc-diff`, `docx-tool`, `ical-tool`, `img-tool`, `markitdown`, `pdf-tool`, `pptx-tool`, and `xlsx-tool`; all 8 passed real non-sandbox `--help` execution on this machine with `uv` access to the user cache
- Standard helper behavior smoke profiles: `ical-basic` covers real `ical-tool create/read/filter` file processing with JSON output validation; `xlsx-basic` covers real `xlsx-tool write/info/read/export/add-sheet` workbook processing with JSON and CSV output validation; `docx-basic` covers real `docx-tool create/extract/template/replace` document processing with extracted-text validation; `img-basic` covers real `img-tool info/resize/convert` processing; `markitdown-basic` covers real `markitdown` plain-text and generated-DOCX fallback conversion; `pdf-basic` covers real `pdf-tool from-image/sanitize`; `pptx-basic` covers real `pptx-tool create/info/extract`; `doc-diff-basic` covers real `doc-diff --format summary`
- Multi-step agent loop with tool-result feedback
- OpenAI-compatible provider selected through environment variables, with tool schema export and tool-call parsing
- Provider profile catalog for OpenAI-compatible backends including OpenAI, OpenRouter, Ollama, LM Studio, and Anthropic-compatible bridge profiles
- Native Anthropic Messages API provider with tool schema mapping, `tool_use` parsing, and SSE streaming for text/tool input deltas
- Package export compatibility modules for the remaining observed shared/server-core/worker surfaces, including branding, colors, desktop bridge/runtime-kind, i18n, icons, interceptor, mentions, prompts, telemetry, utils, version, worker, model-fetchers, and power helpers
- Behavior-backed compatibility for selected export modules: model fetchers plan/fetch provider-specific model lists for OpenAI-compatible, native Anthropic, and Ollama tag endpoints while normalizing model shapes and error payloads; telemetry supports nested redaction, subscribers, event construction, and flushing; worker helpers capture history, batch drain, and errors; desktop native/RPC bridges wrap unavailable, timeout, response matching, and request history states
- OpenAI-compatible provider streaming via chat-completions SSE, protocol persistence for assistant/token and tool-call deltas, streamed tool-call argument accumulation, and repair diagnostics for malformed/incomplete tool arguments
- Structured provider failure classification for auth, rate limit, transient, bad request, network, and abort cases surfaced through `run.failed`
- Provider retry orchestration for retryable transient/rate-limit/network failures with `provider.retry` protocol events, bounded exponential delays, `Retry-After` support, and stop-request interruption during retry delay
- CLI commands for run, threads, show, config, permissions, skills, and workflows
- CLI commands for statuses, labels, sessions, automations, sources, provider inspection, `yuumira server`, `craft-server` startup, `build-craft-server` Bun executable packaging, and `package-macos-app` bundle assembly/sign/verify
- CLI commands for memory list/remember/search/context/citations
- CLI commands for knowledge collection creation, indexing, search, and reports
- CLI commands for credential summaries/save and source auth-help/auth-state
- CLI commands for source test and API request execution
- CLI command for protocol event history filtering by thread or event type
- CLI commands and APIs for terminal history, persisted terminal sessions, real command execution, background process start/cancel/status, stdin input events, resize/dimensions events, stdout/stderr event capture, finish status, replay frames, Git status/log parsing, real workspace Git status/history/diff/branch/stash/worktree RPC behavior, and tool icon lookup

## Major Remaining Gaps

- Native Tauri desktop shell runtime and pixel-perfect Web UI parity beyond current static Web UI and macOS app bundle skeleton
- Pixel/interaction parity with the original bundled Web UI beyond current imported bundle serving, boot endpoint compatibility, and entrypoint asset integrity checks
- Exact original WebSocket channel semantics, Developer ID signing/notarization, native Tauri app bundle integration, real QMD engine execution, production Telegram/Lark/WhatsApp network worker lifecycles beyond the current local messaging gateway model, production agentic loop engine behavior beyond current persisted loop/goal state and session anchoring, native browser WebView ownership/rendering beyond the persisted browser-pane state model and optional HTML snapshot extraction, native menu/shell/dialog side effects beyond current safe acknowledgements, and deeper terminal semantics beyond the current Node HTTP/SSE/WebSocket transport, Craft RPC handshake/request envelope compatibility, persisted preferences/drafts/settings/LLM-connection/model/onboarding/workspace probes, project/task/source/knowledge/messaging/browser-pane CRUD and state RPC, workspace-confined filesystem watcher event streams, real Git status/history/diff/branch/stash/worktree RPC behavior, `craft-server` entrypoint, Bun compile packaging command, ad-hoc signed macOS `.app` skeleton, compatible command aliases, and dual response envelopes
- Deep behavior parity for package export compatibility modules beyond current foundation coverage, especially native Tauri bridge semantics, production telemetry sinks, real messaging worker lifecycles, production provider catalog edge cases, and exact Tauri/macOS power assertion lifecycle semantics beyond the current `caffeinate` adapter
- Full task/project/view UX parity, nested sidebar navigation, and original sorting/grouping semantics beyond current label/query/status/project filters
- Label UI parity and advanced value-type editing behavior
- Source auth prompt UI parity and OAuth MCP session lifecycle parity
- Polished production OAuth UX
- Permission UI parity, approval persistence, and any original edge-case rule semantics beyond current deny-first Bash/MCP/API/tool/write rules
- Automation history UI polish, richer linting, production scheduler parity, and durable multi-process rate-limit state beyond current history-backed scheduler execution and RPC-compatible list/history/replay surfaces
- Full memory sqlite state DB, consolidation agent loop, richer extraction model, and exact original retention heuristics beyond current per-run removal caps and optional user-home compatibility rendering
- Original QMD semantic engine execution, local embedding model downloads, richer vector index/cache parity beyond current deterministic clean-room local semantic index materialization, scheduled ingestion cleanup, and Obsidian-specific source UX
- Claude SDK/Pi Agent runtime parity beyond current OpenAI-compatible catalog plus native Anthropic Messages streaming provider
- Full original bidirectional streaming message-shape parity, broader provider-specific stream repair, production watchdog scheduling, and deeper production retry policy parity beyond current compatible WebSocket envelopes plus provider retry event/delay orchestration
- Broader edge-case coverage of each bundled helper's error paths beyond current help smoke and behavior profiles for `ical-tool`, `xlsx-tool`, `docx-tool`, `img-tool`, `markitdown`, `pdf-tool`, `pptx-tool`, and `doc-diff`
- Auth, credentials, and secure secret storage
- Original terminal database schema and true PTY-backed shell session management/replay beyond current persisted session metadata plus spawned-process stdin/stdout/stderr/resize event replay
- Original Git UI edge-case parity beyond current status/history/diff/branch/stash/worktree RPC behavior, especially submodules, sparse checkouts, unusual encodings, remote authentication prompts, conflict workflows, and multi-worktree destructive-operation confirmations
- Full smoke coverage of each bundled helper's real Python/UV dependency workflow and pixel-level terminal cockpit parity beyond current helper runner, imported shared resources, and Web UI controls
