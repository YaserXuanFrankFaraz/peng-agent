# Headless Server Protocol

This repository exposes a local JSON API for the clean-room runtime. The protocol is intentionally small and stable so a desktop shell, web UI, or external client can be built on top of it.

Start the server:

```bash
node ./bin/yuumira.mjs server --port 4721
node ./bin/craft-server.mjs --port 4721 --json
```

The `craft-server` entrypoint mirrors the headless server executable boundary observed in the installed app. It accepts `--host`, `--port`, `--workspace`, `--json`, and `--manifest`; environment overrides are `YUUMIRA_HOST`, `YUUMIRA_PORT`, and `YUUMIRA_WORKSPACE`.

For app-style distribution, `node ./bin/build-craft-server.mjs --outfile dist/craft-server` runs `bun build --compile` against the `craft-server` entrypoint. Use `--dry-run` to print the exact compile command, `--target` to pass a Bun compile target, `--verify` to run the built executable's manifest check, or `BUN_BINARY` to choose a Bun executable.

`node ./bin/package-macos-app.mjs --out dist/YuuMira.app` creates a YuuMira-style macOS bundle with `CFBundleIdentifier=app.yuuone.yuumira`, executable name `craft-agents-tauri`, URL schemes `yuumira` and `craftagents`, `Contents/Resources/server/`, web UI assets under `Contents/Resources/server/resources/webui/`, and an optional `--server-binary` copy of the Bun-compiled `craft-server`. When imported assets exist, packaging defaults to `resources/webui` for the bundled web UI and `resources/` for shared resources; `--webui` and `--resources` can still override those inputs. Add `--sign --verify` for ad-hoc codesigning plus `codesign --verify --deep --strict`; use `--identity <name>` or `YUUMIRA_CODESIGN_IDENTITY` for a real signing identity.

The static web UI is served at `/`.

## Core Endpoints

- `GET /`
- `GET /app.js`
- `GET /styles.css`
- `GET /health`
- `GET /events`
- `GET /ws`
- `GET /api/workspace`
- `GET /api/config`
- `GET /api/config/workspaces`
- `POST /api/auth`
- `POST /api/auth/logout`
- `GET /api/push/vapid-public-key`
- `POST /api/push/subscribe`
- `DELETE /api/push/subscribe`
- `GET /api/push/subscriptions`
- `GET /api/power`
- `POST /api/power/prevent-sleep`
- `POST /api/power/allow-sleep`
- `GET /api/provider`
- `GET /api/provider/model-request`
- `POST /api/provider/models`
- `GET /api/workspace/watchers`
- `POST /api/workspace/watchers` with `{ "paths": ["."] }`
- `DELETE /api/workspace/watchers` with `{ "paths": ["."] }`
- `GET /api/workspace/file-events`
- `GET /api/tools`
- `GET /api/protocol/events`
- `GET /api/protocol/events?threadId=...`
- `GET /api/protocol/events?type=tool.completed`
- `POST /api/run` with `{ "prompt": "...", "includeMemory": false }`
- `GET /api/threads`
- `GET /api/threads/:id`
- `GET /api/queued-messages`
- `GET /api/queued-messages?threadId=...`
- `GET /api/queued-messages?status=pending`
- `GET /api/run-control`
- `GET /api/run-control?status=running`
- `POST /api/run-control/watchdog` with `{ "staleAfterMs": 30000 }`
- `POST /api/threads/:id/messages` with `{ "content": "...", "source": "client" }`
- `POST /api/threads/:id/replay-queue`
- `POST /api/threads/:id/stop` with `{ "reason": "user_requested" }`
- `POST /api/threads/:id/resume` with `{ "prompt": "Continue..." }`

## Domain Endpoints

- `GET /api/statuses`
- `GET /api/statuses/validate`
- `POST /api/statuses`
- `PATCH /api/statuses/:id`
- `PATCH /api/statuses/default`
- `DELETE /api/statuses/:id`
- `GET /api/labels`
- `GET /api/labels?q=...`
- `GET /api/labels?valueType=number`
- `GET /api/labels?parentId=...`
- `GET /api/labels/validate`
- `POST /api/labels` with `{ "id": "priority", "name": "Priority", "valueType": "number", "parentId": "meta" }`
- `PATCH /api/labels/:id` with `{ "id": "area", "name": "Area" }`
- `DELETE /api/labels/:id`
- `GET /api/sessions`
- `POST /api/sessions` with `{ "prompt": "...", "labels": ["..."] }`
- `GET /api/sessions/:id`
- `PATCH /api/sessions/:id/status` with `{ "statusId": "needs-review" }`
- `POST /api/sessions/:id/labels` with `{ "label": "bug" }`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/tasks`
- `GET /api/tasks?projectId=...&sessionId=...&statusId=...&label=...&q=...&sort=createdAt:desc`
- `POST /api/tasks`
- `GET /api/tasks/:id`
- `PATCH /api/tasks/:id`
- `PATCH /api/tasks/:id/status`
- `DELETE /api/tasks/:id`
- `GET /api/views`
- `GET /api/views?entity=tasks`
- `POST /api/views`
- `GET /api/views/:id`
- `PATCH /api/views/:id`
- `DELETE /api/views/:id`
- `GET /api/search?q=...`
- `GET /api/memory`
- `POST /api/memory` with `{ "text": "...", "tags": ["..."] }`
- `GET /api/memory/search?q=...`
- `POST /api/memory/context` with `{ "query": "...", "limit": 8, "maxChars": 4000 }`
- `POST /api/memory/citations` with `{ "text": "Uses [memory:memory_id]" }`
- `POST /api/memory/extract` with `{ "text": "...", "persist": true }`
- `POST /api/memory/maintain` with `{ "maxRecords": 500, "maxAgeDays": 365, "maxRemovedPerRun": 25, "maxRemovedRatio": 0.2, "scanCitations": true, "compatibility": true, "userCompatibility": false }`
- `GET /api/knowledge/collections`
- `POST /api/knowledge/collections` with `{ "name": "Notes", "root": "/path/to/vault" }`
- `PATCH /api/knowledge/collections/:id`
- `DELETE /api/knowledge/collections/:id`
- `GET /api/knowledge/documents`
- `POST /api/knowledge/index` with `{ "collectionId": "..." }`
- `GET /api/knowledge/search?q=...`
- `GET /api/knowledge/report`
- `GET /api/knowledge/inspect`
- `POST /api/knowledge/repair`
- `GET /api/knowledge/semantic`
- `PATCH /api/knowledge/semantic` with `{ "model": "local-embed", "cacheDir": ".yumira/knowledge/semantic-cache", "installed": false }`
- `POST /api/knowledge/semantic/jobs` with `{ "collectionId": "...", "model": "local-embed" }`
- `POST /api/git/status/parse` with `{ "text": " M src/app.js\n?? notes.md" }`
- `POST /api/git/log/parse` with records from `git log --pretty=format:%H%x1f%an%x1f%ai%x1f%s%x1e`
- `GET /api/terminal/history`
- `GET /api/terminal/sessions`
- `GET /api/terminal/sessions?status=open`
- `POST /api/terminal/sessions` with `{ "name": "Build", "cwd": "/workspace", "shell": "/bin/zsh", "dimensions": { "cols": 120, "rows": 40 } }`
- `POST /api/terminal/run` with `{ "command": "npm test", "timeoutMs": 30000 }`
- `POST /api/terminal/start` with `{ "command": "npm test", "timeoutMs": 30000 }`
- `POST /api/terminal/history` with `{ "command": "npm test", "exitCode": 0, "output": "..." }`
- `GET /api/terminal/sessions/:id`
- `POST /api/terminal/sessions/:id/attach` with `{ "recordId": "terminal_..." }`
- `POST /api/terminal/sessions/:id/close`
- `GET /api/terminal/history/:id`
- `POST /api/terminal/history/:id/events` with `{ "stream": "stdout", "data": "..." }`
- `POST /api/terminal/history/:id/finish` with `{ "exitCode": 0 }`
- `POST /api/terminal/history/:id/input` with `{ "data": "echo ok\n" }`
- `POST /api/terminal/history/:id/resize` with `{ "cols": 120, "rows": 40 }`
- `POST /api/terminal/history/:id/cancel`
- `GET /api/terminal/history/:id/process`
- `GET /api/terminal/history/:id/replay`
- `GET /api/tool-icons`
- `GET /api/tool-icons?command=npm%20test`
- `GET /api/resources`
- `GET /api/audit/bundle?appPath=/Applications/YuuMira.app`
- `GET /api/helpers`
- `POST /api/helpers/smoke` with `{ "names": ["docx-tool"], "args": ["--help"], "timeoutMs": 30000 }`
- `GET /api/helpers/smoke-profiles`
- `GET /api/helpers/behavior-profiles`
- `POST /api/helpers/behavior-smoke` with `{ "profile": "ical-basic", "timeoutMs": 60000 }`, `{ "profile": "xlsx-basic", "timeoutMs": 60000 }`, `{ "profile": "docx-basic", "timeoutMs": 60000 }`, `{ "profile": "img-basic", "timeoutMs": 60000 }`, `{ "profile": "markitdown-basic", "timeoutMs": 60000 }`, `{ "profile": "pdf-basic", "timeoutMs": 60000 }`, `{ "profile": "pptx-basic", "timeoutMs": 60000 }`, or `{ "profile": "doc-diff-basic", "timeoutMs": 60000 }`
- `POST /api/helpers/:name/plan` with `{ "args": ["--help"] }`
- `POST /api/helpers/:name/run` with `{ "args": ["--help"], "timeoutMs": 30000 }`
- `GET /resources/manifest.json`
- `GET /resources/tool-icons/tool-icons.json`
- `GET /resources/tool-icons/:file`
- `GET /resources/themes/default.json`
- `GET /resources/webui/index.html`
- `GET /resources/webui/assets/:file`

## Extension Surfaces

- `GET /api/skills`
- `GET /api/workflows`
- `GET /api/sources`
- `GET /api/sources/validate`
- `GET /api/sources/:slug/auth-help`
- `GET /api/sources/:slug/auth-state`
- `POST /api/sources/:slug/credentials` with `{ "fields": { "token": "..." } }`
- `GET /api/sources/:slug/runtime-signature`
- `POST /api/sources/:slug/apply-api-auth` with `{ "url": "https://api.example.com/v1/me" }`
- `POST /api/sources/:slug/test`
- `POST /api/sources/:slug/icon`
- `POST /api/sources/:slug/request` with `{ "path": "models", "method": "GET" }`
- `GET /api/sources/:slug/mcp-tools`
- `POST /api/sources/:slug/mcp-call` with `{ "name": "tool_name", "arguments": {} }`
- `POST /api/sources/:slug/oauth/authorize` with `{ "state": "...", "generateState": true, "pkce": true, "codeChallenge": "...", "redirectUri": "http://127.0.0.1:1234/callback" }`
- `POST /api/sources/:slug/oauth/device`
- `POST /api/sources/:slug/oauth/exchange` with `{ "code": "...", "codeVerifier": "..." }` or `{ "deviceCode": "..." }`
- `POST /api/sources/:slug/oauth/poll-device` with `{ "deviceCode": "...", "intervalSecs": 5, "expiresIn": 600 }`
- `POST /api/sources/:slug/oauth/refresh`
- `GET /api/credentials`
- `GET /api/credentials/storage`
- `POST /api/credentials` with `{ "sourceSlug": "...", "mode": "bearer", "value": "..." }`
- `GET /api/automations/validate`
- `GET /api/automations/lint`
- `POST /api/automations/test` with an event object or `{ "event": { ... } }`
- `POST /api/automations/run` with `{ "event": { ... }, "executeWebhooks": true }`
- `GET /api/automations/history`
- `GET /api/automations/scheduler`
- `POST /api/automations/scheduler/tick` with `{ "now": "2026-08-07T09:30:00.000Z", "executeWebhooks": false }`
- `POST /api/automations/scheduler/start` with `{ "intervalMs": 60000, "immediate": false, "executeWebhooks": false }`
- `POST /api/automations/scheduler/stop`
- `POST /api/permissions/evaluate`
- `GET /api/permissions/validate`

Permission evaluation accepts `{ "mode": "safe", "kind": "bash|api|mcp|tool|write", "value": "...", "method": "GET", "rules": { ... } }`. Rules support allow and deny regexes for Bash/MCP, allow and deny API endpoint regexes, allowed and denied tool names, and allowed/denied write-path globs. Deny rules take precedence over allow rules.

Resource endpoints expose a Craft-compatible static resource surface for clients that expect bundled assets below `resources/`. Tool icons are listed through both `/api/tool-icons` and `/resources/tool-icons/tool-icons.json`; imported bitmap/vector icon files, theme JSON files, docs, release notes, permissions, logos, helper bin wrappers, scripts, server web UI assets, `config-defaults.json`, and `source.png` under `resources/` are served directly, while deterministic SVG placeholders remain available when an icon entry exists but its asset file has not been imported. The default theme is available at `/resources/themes/default.json`; imported YuuMira server web UI assets are available under `/resources/webui/`.

The headless HTTP server also uses imported `resources/webui` as its default static app root when present, so `/`, `/login`, `/manifest.json`, icon files, and `/assets/...` mirror the YuuMira server web UI distribution. Set `YUUMIRA_WEBUI_DIR` to force a different static root.

`GET /api/config` includes the clone defaults plus original Web UI boot fields: `wsUrl`, `httpUrl`, `webSocketPath`, `workspaceId`, `defaultWorkspaceId`, and `workspace`. `GET /api/config/workspaces` returns `defaultWorkspaceId`, `activeWorkspace`, `currentWorkspace`, and `workspaces`. `POST /api/auth` and `POST /api/auth/logout` are accepted for imported login/logout flows; the clean-room server currently reports `mode: "none"` because no token gate is enabled by default. Push notification endpoints expose a local compatibility layer: `GET /api/push/vapid-public-key` returns a deterministic browser application-server key, `POST /api/push/subscribe` persists a PushManager-style subscription by endpoint, `DELETE /api/push/subscribe` removes it, and `GET /api/push/subscriptions` lists current local subscriptions. Delivery to a production push service remains a future integration boundary.

`GET /api/audit/bundle` returns a machine-readable parity audit comparing the authorized installed YuuMira bundle against the current clone. It reads bundle identity, server package manifest summaries and fingerprints, package export coverage against local clone modules, server/webui/resource directories, exact clone resource manifests, SHA-256 content fingerprints, root resource file hashes, duplicate resource variants, Web UI RPC channel constants extracted from imported JS/HTML assets and matched against `src/server.js`, and helper behavior profile coverage, then emits `comparisons.checks` and `comparisons.gaps`. This is an evidence-gathering surface for tracking remaining parity work; it is not a completion claim.

The resource manifest includes `webuiEntrypoints`, which validates local references from imported `resources/webui/index.html` and `resources/webui/login.html`. The bundle audit includes `resources.webui.entrypoints`; it fails when entrypoint HTML references a missing script, stylesheet, icon, or manifest asset even if raw webui file counts still match.
The package export coverage is intentionally a module-surface map: it shows whether an observed export has a local clone module candidate, while deeper function signatures and runtime semantics are tracked through separate behavior tests as they are added.

Helper endpoints expose imported YuuMira-style wrapper commands from `resources/bin`. `plan` returns the resolved executable, linked script, parsed PEP 723 dependencies, arguments, working directory, and `CRAFT_UV`/`CRAFT_SCRIPTS` environment without running it. `run` executes only a known imported wrapper name and returns `exitCode`, `stdout`, `stderr`, timeout state, timing metadata, and a diagnosis such as `ok`, `timeout`, `uv-cache-permission`, `missing-command`, or `dependency-resolution`. `smoke` runs a selected set of wrappers, defaulting to `--help` and skipping `craft-agent`, then returns aggregate pass/fail counts plus per-helper results. `profile: "help"` runs `--help` against all eight imported document/media helpers.
Behavior smoke profiles run multi-step file operations. `ical-basic` creates a temporary calendar with `ical-tool create`, reads it back as JSON, filters it by date range, and validates the resulting event count and summary. `xlsx-basic` writes a temporary workbook with `xlsx-tool write`, inspects it with `info`, reads rows as JSON, exports CSV, and adds a sheet. `docx-basic` creates a report document, extracts its text, fills a templated document, replaces text, and validates the extracted output. `img-basic` inspects a PNG image, resizes it, and converts it to JPG. `markitdown-basic` validates plain-text passthrough and DOCX fallback conversion using a generated document fixture. `pdf-basic` creates a PDF from an image fixture and sanitizes it. `pptx-basic` creates, inspects, and extracts a small deck. `doc-diff-basic` compares two text files and validates the summary.

## Events

`GET /events` opens a Server-Sent Events stream. `GET /ws` upgrades to a WebSocket transport that receives the same event envelopes as JSON messages and accepts bidirectional JSON commands. WebSocket messages accept `type`, `event`, `kind`, `action`, or `command` as the command name and accept `payload`, `data`, `params`, `arguments`, or top-level command fields as the payload. Responses include both `type`/`payload` and `event`/`data`, plus `ok`, `requestId`, and `createdAt`, so clients can use either compact event-style or request/response-style envelopes.

`GET /ws` also accepts the original Craft RPC envelope family observed in the imported YuuMira Web UI: `handshake`, `handshake_ack`, `request`, `response`, `event`, `error`, and `sequence_ack`. The imported browser client sends `type: "handshake"` immediately after open with protocol version `1.0`; the clone answers with `type: "handshake_ack"` and supports foundational `request` channels for workspace/session bootstrapping, including `workspaces:get`, `server:getWorkspaces`, `window:getWorkspace`, `sessions:get`, `sessions:create`, `sessions:getMessages`, `sessions:sendMessage`, `sessions:getUnreadSummary`, `sessions:markAllRead`, `statuses:list`, `labels:list`, `views:list`, `projects:get`, `tasks:list`, `skills:get`, `sources:get`, and `toolIcons:getMappings`. It also implements project/task/label/status/view/source RPC CRUD channels observed in the original Web UI, including `projects:create/update/delete/getOne/listAssets/uploadAsset/deleteAsset`, `tasks:create/get/list/validate/run/pause/resume/stop/getOutput/getResults`, `labels:create/delete`, `statuses:reorder`, `views:save`, `sources:create/delete/getPermissions/getMcpTools/saveCredentials/startOAuth`, and `workspaces:checkSlug/create/updateRemote/delete` with active-workspace delete guarded. Automation RPCs expose flattened workspace automation config, enable toggles, duplication, deletion, test execution, history, last-executed lookup, and replay through the same scheduler/history machinery as the HTTP and CLI surfaces. The `knowledge:*` RPC family maps vaults to knowledge collections, raw documents to indexed knowledge documents, search/graph/report calls to the local knowledge store, and QMD-related calls to persisted semantic-engine state with a default unavailable status plus completed local semantic indexing when the clean-room engine is enabled. Messaging RPCs persist Telegram/Lark configuration summaries, binding codes, supergroup state, bindings, platform status, disconnect/forget actions, WhatsApp connect-phone state, access-control state, and event acknowledgements without contacting external services. ChatGPT/Copilot/xAI auth RPCs expose local pending/signed-out/cancelled state; Copilot and xAI device-code RPCs now create persisted local device-code flows with verification URLs, expiry, polling interval, and provider auth pending state until real credential exchange is wired. `LLM_Connection:*` RPCs persist model connection lists, redacted API-key status, default/workspace-default selections, deletes, and provider test results with redacted persisted history while preserving the legacy `llmConnection` setting. `goal:*` and `loop:*` RPCs persist the active goal, loop designs, loop runs, loop actions/events, and create a backing session when a loop starts. Browser-pane RPCs persist a local tab/window state model with create/list/navigate/back/forward/reload/stop/focus/destroy/interacted semantics; native WebView ownership is reported through state rather than launched by the Node server. Update RPCs persist a local updater state machine for check, download progress, dismissal, and install-complete state while leaving real native updater execution to future app-shell integration; Pilot, RTK, remote, and computer-use RPCs expose deterministic local status/unavailable responses without contacting external services. Menu, shell, notification, auth-dialog, folder-dialog, deeplink, and debug-log RPCs return safe acknowledgements, persisted local intent/event records, and a replayable RPC sync-event log without invoking native UI or system shell side effects. It persists original settings-style RPC state for `preferences:*`, `drafts:*`, `theme:*`, `input:*`, `power:*`, `appearance:*`, `tools:*`, `settings:*`, `notification:*`, including show/navigate local events, `memory:*`, `caching:*`, `observability:*`, `session:getModel`, `session:setModel`, `session:event`, `sessions:command`, `workspaceSettings:*`, and conservative `onboarding:*`/`pi:*` model setup probes. Release-note, logo, and resources export/import channels resolve, write, and import authorized workspace resources. The clone exposes safe workspace-confined `file:*`/`fs:*` reads plus `workspace:*` file listing, image read/write, permission summaries, real workspace-confined file watcher registration, manual and native file-change event recording, terminal command recording, frequent-command hiding, and button probes, and real workspace-confined Git RPCs for status, branch, history, diff, stage, unstage, discard, commit, branch switching/creation/deletion, merge, fetch/pull/push, stash, and worktree listing/changes through fixed `git -C <workspace>` argument arrays. The current clean-room bridge handles all 430 recognized original Web UI RPC channel constants extracted from the imported bundle, including nested channel names; unknown channels still return a Craft-style `response.error` with `CHANNEL_NOT_FOUND`.

Workspace watcher RPCs and HTTP endpoints are confined to the active workspace. `workspace:watchFiles`, `sessions:watchFiles`, `POST /api/workspace/watchers`, and their unwatch counterparts share one local watcher manager. Native `fs.watch` changes are persisted as recent `workspace.files.changed` records, broadcast through SSE/WebSocket as both `workspace.files.changed` and `workspace:filesChanged`, and exposed at `GET /api/workspace/file-events`. Internal `.yuumira/` state writes are filtered so watcher bookkeeping does not recursively trigger itself.

`remote:testConnection` performs a real HTTP connectivity probe through the configured runtime fetch implementation. Responses include `status` (`connected`, `http_error`, `timeout`, `failed`, or `unavailable`), HTTP status code/text when a response exists, latency, target URL, method, and check timestamp. This gives the Web UI a real connection-test result without requiring an external remote bridge service.

`computerUse:getStatus`, `computerUse:requestPermissions`, and `computerUse:openPermissionPane` maintain a local permission state machine. The clone persists `prompt`, `requested`, `opened`, `granted`, and `denied` states so the Web UI can complete permission flows and recover them after reload; actual macOS accessibility/screen-control execution remains a native app-shell integration boundary.

`pilot:getStatus`, `pilot:install`, `pilot:start`, `pilot:stop`, and `pilot:openDashboard` maintain a local Pilot runtime state. The clone records local-state installation version, running/stopped status, and dashboard-open route/timestamps so Pilot UI flows can complete without bundling the production Pilot runtime.

`rtk:getEnabled`, `rtk:setEnabled`, `rtk:getStatus`, and `rtk:getGain` maintain local RTK state. `setEnabled` preserves the original boolean response while persisting enabled/disabled timestamps, source, status, and local gain for the richer status probe.

`file:openDialog` and `dialog:openFolder` use deterministic workspace-local picker semantics when no native dialog host is present. The file picker resolves `defaultPath`, applies extension filters, returns matching file entries plus `selected`/`path`, and reports `cancelled:false` when a candidate exists. The folder picker resolves a workspace-confined directory and returns folder entries plus the selected directory.

Additional `file:*` RPCs are workspace confined. `file:write`, `file:writeText`, and `file:writeDataUrl` create parent directories and return a normalized file info envelope; `file:stat`/`file:getInfo` return file metadata; `file:exists` returns an existence flag without throwing on missing paths; and `file:delete`/`file:unlink`/`file:remove` delete files only, rejecting directories. These complement `file:read`, data-URL/binary reads, attachment storage, and thumbnail generation.

`skills:openEditor` and `skills:openFinder` record workspace-local open intents instead of launching native apps. The response includes the resolved workspace path, optional skill metadata, file existence/type details, and a persisted intent entry so settings flows can confirm which skill target would be opened by a native shell.

`skills:delete` performs a workspace-confined soft delete for skills under `.craft-agent/skills` or `.agents/skills`. The skill directory or file is moved to `.yuumira/deleted-skills/`, and the response includes the original target, archive path, discovered skill metadata when available, and a persisted delete intent. Paths outside the workspace-local skill roots are rejected.

`gitbash:browse` uses deterministic local candidate selection instead of a native Windows file picker. It records browse intents, selects the configured or default Git Bash path candidate, and preserves `gitbash:check`/`gitbash:setPath` status semantics.

`badge:setIcon`, `badge:draw`, `badge:draw-windows`, and `badge:refresh` update a persisted local badge state instead of requiring a native app-shell badge API. Responses include the current icon/count/text/platform state, a badge event history entry, `mode:"local-state"`, and `nativeApplied:false` so the Web UI can treat the command as locally applied while still distinguishing it from an OS-level dock/taskbar badge update.

`onboarding:startClaudeOAuth`, `onboarding:startMcpOAuth`, and `onboarding:exchangeClaudeCode` maintain a persisted local onboarding OAuth state machine. Start calls create pending sessions with state, authorization URL, code verifier, redirect URI, and `mode:"local-state"`; Claude exchange marks the matching session `exchanged` with a redacted code. `onboarding:getAuthState`, `onboarding:hasClaudeOAuthState`, and `onboarding:clearClaudeOAuthState` expose and clear the local state without contacting provider networks.

`chatgpt:startOAuth`, `copilot:startOAuth`, and `xai:startOAuth` create persisted local provider OAuth pending sessions with generated state, provider authorization URL, timestamps, and `mode:"local-state"`. `*:getAuthStatus` exposes the pending session, while `*:cancelOAuth` and `*:logout` update the provider auth state without contacting external networks.

`shell:openUrl`, `shell:openFile`, and `shell:showInFolder` register persisted local shell intents instead of launching the system shell from the Node server. URL intents preserve the requested URL; file/folder intents are normalized through the active workspace boundary. Responses use `status:"registered"`, `mode:"local-intent"`, and `nativeExecuted:false` so a future app shell can execute the intent while the server remains side-effect safe.

Menu edit commands (`menu:copy`, `menu:cut`, `menu:paste`, `menu:selectAll`, `menu:undo`, `menu:redo`) and app/window commands (`menu:newWindow`, `menu:openSettings`, `menu:keyboardShortcuts`, `menu:about`, `menu:minimize`, `menu:maximize`, `menu:quit`) register persisted local menu intents. Responses use the same `status:"registered"`, `mode:"local-intent"`, and `nativeExecuted:false` envelope while preserving command kind (`edit` or `window`) for a future native shell.

Messaging compatibility now includes a local gateway lifecycle model. Saving Telegram or Lark settings starts a clean-room local worker state when the platform is enabled and configured; WhatsApp connect-phone RPCs (`messaging:wa:startConnect`, `messaging:wa:submitPhone`, `messaging:wa:uiEvent`) persist the connect session, phone submission state, UI events, and local WhatsApp worker state; disconnect stops the relevant worker; binding-code events can be converted into durable bindings; and inbound messages can be recorded through `POST /api/messaging/inbound`, creating a session with `metadata.kind="messaging"` unless `createSession:false` is supplied. `GET /api/messaging/status` returns gateway/worker status, and `GET /api/messaging/events` returns the recent local gateway event log. The `messaging:access:*` RPC family persists owner-mode access settings, owner lists, pending access requests, pending allow/dismiss decisions, and per-binding access flags. The implementation deliberately does not connect to Telegram, Lark, or WhatsApp networks without explicit future integration.

Browser-pane compatibility persists the original tab/window state model and can optionally capture a clean-room page snapshot. Pass `snapshot:true` to `browser-pane:create`, `browser-pane:navigate`, or `browser-pane:reload` to fetch the URL through the runtime fetch implementation, store response status/content type, extract the HTML `<title>`, and save a text excerpt under `pane.snapshot`. Normal navigation remains side-effect-free unless snapshot capture is requested. This gives the Agent app an inspectable page summary while native WebView ownership remains a future Tauri integration item.

Window RPC compatibility persists the desktop shell state behind the observed `window:*` channels. `window:focusState` and `window:getFocusState` maintain focus state, `window:closeRequested`/`window:cancelClose`/`window:confirmClose`/`window:close` maintain close-request lifecycle state, `window:openSessionInNewWindow` records a session-window open request, and `window:openWorkspace`/`window:switchWorkspace` record workspace switch/open requests. Each call appends a local `windowEvents` entry with `nativeWindow:false` and `mode:"local-window-state"` so the imported Web UI can replay the desktop intent without the Node server directly controlling native windows.

Observability RPCs are backed by the same persisted protocol event log exposed at `GET /api/protocol/events`. `observability:getSessionTrace` returns local spans/events for a session, `observability:getSessionUsage` estimates input/output/tool token usage from stored session messages, and `usageQuota:get` aggregates estimated local usage across threads while reporting unlimited local quota.

WebSocket client commands:

- `{ "id": "...", "type": "ping" }` returns `pong`
- `{ "id": "...", "type": "run.start", "payload": { "prompt": "...", "threadId": "...", "includeMemory": false } }` starts or resumes a run and returns `run.result`
- `{ "id": "...", "type": "thread.message", "payload": { "threadId": "...", "content": "..." } }` queues a follow-up message and returns `thread.message.result`
- `{ "id": "...", "type": "thread.stop", "payload": { "threadId": "...", "reason": "user_requested" } }` requests cooperative stop and returns `thread.stop.result`
- `{ "id": "...", "type": "thread.replayQueue", "payload": { "threadId": "..." } }` replays queued messages and returns `thread.replayQueue.result`

Accepted command aliases include:

- `run`, `start_run`, `run:start`, `runStart` -> `run.start`
- `message`, `queue_message`, `message.queue` -> `thread.message`
- `stop`, `stop_run`, `run.stop` -> `thread.stop`
- `replay_queue`, `queue.replay` -> `thread.replayQueue`

Current event names:

- `ready`
- `thread.completed`
- `thread.message.queued`
- `thread.queue.replayed`
- `thread.stop.requested`
- `thread.resumed`
- `protocol.event`
- `run.started`
- `run.step.started`
- `run.heartbeat`
- `run.stop_requested`
- `run.stopping`
- `run.stopped`
- `run.resume_requested`
- `run.watchdog.stale`
- `assistant.delta`
- `assistant.message`
- `tool.delta`
- `tool.repaired`
- `provider.diagnostic`
- `provider.retry`
- `tool.started`
- `tool.completed`
- `run.max_steps`
- `run.completed`
- `run.failed`
- `message.queued`
- `message.acknowledged`
- `message.replay.started`
- `message.replay.completed`
- `message.replay.failed`
- `session.created`
- `session.status.changed`
- `session.label.added`
- `project.created`
- `task.created`
- `task.status.changed`
- `memory.recorded`
- `knowledge.collection.created`
- `knowledge.indexed`
- `knowledge.semantic.job`
- `credential.saved`
- `source.tested`
- `terminal.recorded`
- `terminal.session.created`
- `terminal.session.attached`
- `terminal.session.closed`
- `terminal.event`
- `terminal.input`
- `terminal.resize`
- `terminal.finished`
- `terminal.cancelled`
- `automation.ran`
- `automation.scheduler.tick`
- `automation.scheduler.started`
- `automation.scheduler.stopped`

Protocol lifecycle events are also persisted under `.yumira/protocol-events/` and exposed through `GET /api/protocol/events`. Each event uses:

```json
{
  "version": 1,
  "type": "tool.completed",
  "threadId": "thread_...",
  "step": 0,
  "sequence": 5,
  "payload": {},
  "createdAt": "..."
}
```

Queued messages are persisted under `.yumira/queued-messages/`. Messages posted while a thread is `running` are acknowledged for replay after the active run completes; messages posted to an idle/completed thread remain `pending` until `POST /api/threads/:id/replay-queue` or a later runtime drain applies them.

Run-control records are persisted under `.yumira/run-control/`. A stop request is cooperative: the runtime observes it at safe points before steps and tools, passes an `AbortSignal` into provider fetch calls during provider work, persists `stopped`, and skips queued replay. Resume appends a new user prompt to the same thread and emits a fresh run lifecycle. Heartbeat events are persisted during provider/tool phases, and the watchdog endpoint reports running controls whose heartbeat age exceeds the configured threshold.

Power state is process-local and exposed through `GET /api/power`, `POST /api/power/prevent-sleep`, `POST /api/power/allow-sleep`, CLI `yuumira power`, and tools `power.state`, `power.prevent_sleep`, and `power.allow_sleep`. When `defaults.keepAwakeWhileRunning` is enabled, runtime runs acquire a keep-awake lease and release it in a finalizer after completion, stop, or failure. On macOS, the default native adapter starts `caffeinate -dimsu` while at least one lease is active; other platforms report the native assertion as unavailable while still tracking leases. The protocol records `power.prevent_sleep` and `power.allow_sleep` events for configured runs, including native assertion status in the state payload.

Providers may implement either `complete()` or `streamComplete()`. When streaming is available, the runtime persists assistant token deltas as `assistant.delta`, streamed tool-call fragments as `tool.delta`, and malformed or incomplete tool argument recovery as `tool.repaired` before executing the repaired tool call.

Source folders may include `permissions.json`. For MCP sources, `allowedTools`, `deniedTools`, or `allowedMcpPatterns` scope which `tools/call` requests can execute in safe mode. Stdio MCP sources can also define `mcp.credentialEnv` or `mcp.tokenEnv`; saved source credentials are injected into that environment variable only for the spawned MCP process. HTTP MCP sources use JSON-RPC over `POST mcp.url`; bearer/oauth credentials are sent as `Authorization`, and header credentials use `mcp.headerName`.

Source config may include `iconUrl`, `icon.url`, `api.iconUrl`, or `mcp.iconUrl`. `source.test` attempts to cache remote icons after a successful or `needs_auth` connection result, and `POST /api/sources/:slug/icon` can refresh the cache directly. Cached metadata is written back as `icon.cachedPath`, `icon.contentType`, `icon.bytes`, and `icon.fetchedAt`; the image file is stored inside the source folder.

OAuth sources can define an `oauth` block at the source root or under `api`/`mcp` with `authorizationUrl`, `deviceAuthorizationUrl`, `tokenUrl`, `clientId`, `redirectUri`, and `scope`. The runtime can build authorization URLs with a dynamic desktop redirect URI, generate state and PKCE verifier/challenge pairs, capture localhost callback codes from the CLI, optionally open the system browser, start and poll device authorization, exchange authorization/device codes, save token credentials, and refresh saved OAuth credentials. The authorize endpoint returns `{ url, state, codeChallenge, codeVerifier, redirectUri }`.

Credential storage defaults to portable `.yumira/credentials.json`. When `YUUMIRA_CREDENTIAL_STORE=macos-keychain` is set, secret values are written to macOS Keychain and the JSON file stores only metadata plus `secretRef`/`refreshTokenRef` handles. `GET /api/credentials/storage` reports the active backend.

Source runtime signatures combine restart-relevant source config with a one-way credential signature. Clients can compare `GET /api/sources/:slug/runtime-signature` results to decide whether a long-lived source/MCP runtime needs to be rebuilt after source config or credential changes. Secret values are never returned.

Credential prompt specs from `auth-help` are executable: `POST /api/sources/:slug/credentials` accepts the returned field names under `fields` and validates required fields before storing the resulting credential. Multi-header sources store a header-name object, basic auth stores `{ username, password }`, and bearer/query/oauth-like prompts store the single token field.

Memory maintenance consolidates and prunes `.yumira/memory/memories.jsonl`, renders `.yumira/memory/MEMORIES.md`, and by default mirrors both `MEMORIES.md` and `memories.jsonl` into workspace `.craft-agent/memories/` for Craft-compatible consumers. Passing `userCompatibility: true` also writes the same compatibility products to `~/.craft-agent/memories/`; set `YUUMIRA_CRAFT_USER_MEMORIES_DIR` to redirect that user-home target. Passing `scanCitations: true` first scans historical assistant thread messages and persisted protocol assistant/completion payloads for `[memory:...]` citations, then updates usage counters before pruning. `maxRemovedPerRun` and `maxRemovedRatio` rate-limit retention pruning; when a maintenance pass would remove more than the cap, lower-priority removals are deferred and reported as `deferredRemovals`.

Knowledge semantic state is persisted under `.yumira/knowledge/semantic-state.json`. By default the runtime reports the original QMD engine as unavailable, but `PATCH /api/knowledge/semantic` or `knowledge:installQmd` can enable the clean-room local semantic engine with `installed: true`. When enabled, semantic jobs materialize `.yumira/knowledge/semantic-cache/index.json` using deterministic local term vectors, mark jobs `completed`, and expose semantic search through `GET /api/knowledge/search?semantic=true`, `knowledge.search` with `semantic: true`, and RPC `knowledge:searchVault` with `semantic: true`. Reports expose `semanticEngine.latestJob`, `model`, `indexPath`, and `status`; this is a replaceable compatibility layer, not a claim that the original QMD model downloader has been cloned.

Terminal sessions are persisted under `.yumira/terminal-sessions/`. A session records workspace, name, cwd, shell, dimensions, status, timestamps, and associated terminal record IDs. Terminal run/start/history creation endpoints and tools accept an optional `sessionId`; attaching a record updates both the session `recordIds` list and the record `sessionId`. Closing a session marks metadata as `closed`; it does not cancel already-running process records.

## Provider Selection

The active provider is process-level configuration:

- Default: deterministic local provider
- `YUUMIRA_PROVIDER=openai|openai-compatible|openrouter|anthropic|ollama|lmstudio|anthropic-compatible`
- Profile-specific variables: `<PREFIX>_API_KEY`, `<PREFIX>_BASE_URL`, `<PREFIX>_MODEL`
- OpenAI-compatible fallback variables: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`

`GET /api/provider` returns the active provider name, model, and base URL where applicable.
`GET /api/provider/profiles` returns built-in provider profile metadata.
`GET /api/provider/model-request?profile=anthropic&apiKey=...` returns the provider-specific model-list request plan without fetching. `POST /api/provider/models` accepts `{ "profile": "ollama", "useOllamaTags": true }` or an inline `provider` object, executes the request, and returns a normalized model list.

Provider failures use structured `run.failed` payload fields where available: `code`, `retryable`, `status`, and `provider`. Built-in provider codes include `provider_auth_failed`, `provider_rate_limited`, `provider_transient`, `provider_bad_request`, `provider_network_error`, and `provider_aborted`.

Retryable provider failures are retried by the runtime before the run is marked failed. Each retry emits `provider.retry` with `attempt`, `nextAttempt`, `maxAttempts`, `delayMs`, `code`, `status`, `provider`, and `message`. HTTP `Retry-After` values are honored when providers expose them, bounded by the runtime retry policy. Stop requests during provider work or retry delay still win and produce `run.stopped` instead of retrying indefinitely.
