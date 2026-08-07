# Craft Agents OSS Comparison

Generated: 2026-08-07T17:32:09Z

This note compares the local Peng clean-room clone with the public Craft Agents OSS repository at:

https://github.com/craft-ai-agents/craft-agents-oss

The public repository is useful because Peng is an authorized fork/derivative of Craft Agents, while the current local clone was primarily built from installed-bundle observation and Web UI compatibility testing.

## Snapshot

| Area | Local Peng Observation | Craft Agents OSS |
| --- | --- | --- |
| Observed app version | 0.11.12 | 0.11.4 |
| Server package set | 8 packages | Same 8 packages plus OSS apps/extra packages |
| Web UI RPC coverage | 430/430 implemented | 332 Electron IPC channel constants in the OSS stability test |
| Installed package export coverage | 93/93 matched | 84 package exports across OSS packages/apps |
| Implementation shape | Single-package Node clean-room clone | Bun/TypeScript monorepo |
| Main UI shell | Imported authorized built webui assets | Source Electron, WebUI, UI, Viewer apps |

## Package Relationship

The installed Peng server package map and OSS overlap exactly on these packages:

- `@craft-agent/core`
- `@craft-agent/messaging-gateway`
- `@craft-agent/messaging-whatsapp-worker`
- `@craft-agent/pi-agent-server`
- `@craft-agent/server`
- `@craft-agent/server-core`
- `@craft-agent/session-tools-core`
- `@craft-agent/shared`

Packages present in OSS but not exposed by the installed Peng server distribution:

- `@craft-agent/cli`
- `@craft-agent/electron`
- `@craft-agent/session-mcp-server`
- `@craft-agent/ui`
- `@craft-agent/viewer`
- `@craft-agent/webui`

This strongly suggests that the installed Peng bundle is a packaged server/runtime distribution derived from the same monorepo family, with desktop UI and source packages compiled or omitted from the server package manifest snapshot.

## Export Differences

Peng 0.11.12 exposes server-side exports that are not present in the OSS 0.11.4 snapshot:

- `@craft-agent/server-core`: `./loop`, `./power`
- `@craft-agent/shared`: `./agent/docs-mcp-policy`, `./desktop`, `./desktop/native-bridge`, `./desktop/rpc-bridge`, `./desktop/runtime-kind`, `./git/history-parse`, `./git/status-parse`, `./goals`, `./knowledge`, `./loop`, `./loop/db`, `./memory`, `./memory/citation-block`, `./scheduler`, `./sources/obsidian`, `./telemetry`, `./terminal/db`, `./terminal/types`, `./utils/file-filters`

OSS 0.11.4 has exports not seen in the installed Peng package map:

- `@craft-agent/server-core`: `./tasks`
- `@craft-agent/shared`: `./projects/types`

Interpretation: most of the local clone's later reverse-engineered modules are consistent with post-0.11.4 evolution rather than pure invention. The OSS repo validates the monorepo boundaries, while the installed Peng 0.11.12 audit remains the better source of truth for exact target exports.

## RPC/IPCs

OSS contains a generated stability test at `apps/electron/src/shared/__tests__/ipc-channels.test.ts` with 332 exact channel strings. It includes major channel families that were also extracted from the installed Peng Web UI:

- `sessions:*`
- `tasks:*`
- `messaging:*`
- `messaging:wa:*`
- `messaging:access:*`
- `window:*`
- `browser-pane:*`
- `LLM_Connection:*`
- `sources:*`
- `automations:*`
- `theme:*`
- `update:*`

The local clone currently handles 430 recognized Web UI RPC constants from the installed Peng assets. The extra channels are expected because:

- Peng is newer than the public OSS snapshot.
- The audit extracts strings from compiled Web UI assets, not only the Electron shared channel map.
- The local clone includes safe compatibility handlers for resource, knowledge, observability, local-state, and native-boundary flows that are not all represented in the OSS 0.11.4 channel stability file.

Notably, OSS 0.11.4 does not list `observability:*` or `usageQuota:*` IPC channels, while the installed Peng Web UI does. That makes the local `observability:getSessionTrace`, `observability:getSessionUsage`, and `usageQuota:get` compatibility implementations Peng-version-specific rather than OSS-baseline features.

## Structural Gap

The local clone is functionally broad but structurally compressed:

- Local clone source/test/webui line count: about 23k lines.
- OSS source line count: about 341k lines.
- OSS `packages/shared/src`: 425 TypeScript files, about 111k lines.
- OSS `packages/server-core/src`: 109 TypeScript files, about 28k lines.
- OSS `packages/messaging-gateway/src`: 47 TypeScript files, about 14k lines.

That means the current clone is best understood as a compatibility-oriented implementation, not yet a structural replica of the original engineering layout.

## High-Value OSS References

These OSS areas are directly useful for future convergence:

- `packages/shared/src/protocol/channels.ts`: canonical `RPC_CHANNELS` object and naming structure.
- `apps/electron/src/shared/__tests__/ipc-channels.test.ts`: generated channel inventory and exact wire-format stability guard.
- `apps/electron/src/transport/channel-map.ts`: method-to-channel mapping for the desktop/Web API surface.
- `packages/server-core/src/transport/server.ts`: WebSocket RPC handshake, heartbeat, event replay, auth, and push routing.
- `packages/server-core/src/handlers/rpc/*`: modular handler families matching the local clone's currently centralized RPC switch.
- `packages/server-core/src/bootstrap/headless-start.ts`: reusable server bootstrap, lock handling, TLS, token validation, HTTP/WebSocket co-hosting.
- `packages/messaging-gateway/src/*`: real Telegram/Lark/WhatsApp binding, access-control, and gateway behavior that can replace local-state compatibility stubs over time.
- `apps/webui/src/*`: source Web UI adapter shape that can explain assumptions hidden by the compiled imported Web UI.
- `apps/electron/src/main/handlers/*`: native boundary behavior for shell, system, update, notification, badge, window, browser, and workspace actions.

## Recommended Next Steps

1. Keep the installed Peng 0.11.12 audit as the exact compatibility oracle.
2. Use Craft Agents OSS as the architecture oracle.
3. Add an OSS comparison command to `bin/peng.mjs audit` or a new script that compares:
   - package names
   - package exports
   - channel constants
   - handler family coverage
   - resource/script families
4. Refactor `src/server.js` gradually into modules that mirror `packages/server-core/src/handlers/rpc/*`.
5. Add `src/protocol.js` channel constants generated from both:
   - imported Peng Web UI constants
   - OSS `RPC_CHANNELS`
6. Prioritize replacing compatibility stubs with OSS-informed implementations in:
   - transport handshake/event replay
   - messaging gateway access control and WhatsApp lifecycle
   - session manager lifecycle
   - source/credential/OAuth flows
   - Electron/native boundary adapters
7. Consider a second-stage repository re-layout into a Bun/TypeScript monorepo only after the current single-package clone is committed and tagged as the proven compatibility baseline.

## Bottom Line

The public OSS repo confirms the core package identity and most protocol families used by Peng. It also shows that the current clone's behavior coverage is ahead of its architecture: the clone matches the installed Peng Web UI surface, but it does not yet mirror the original Craft Agents monorepo structure. The best path is to preserve the passing 0.11.12 compatibility baseline, then use OSS as a guide for incremental structural convergence.
