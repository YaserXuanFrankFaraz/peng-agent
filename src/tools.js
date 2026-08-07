import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { lintAutomationConfig, runAutomations, runAutomationSchedulerTick, validateAutomationConfig } from "./automations.js";
import { mergeConfig } from "./config.js";
import { applyApiAuth, createCredentialRecord, credentialFromPromptInput, credentialPromptSpec, sourceAuthState } from "./credentials.js";
import { addSessionLabel, createProject, createSession, updateProject, updateSessionStatus } from "./domain.js";
import { gitLogPrettyFormat, parseGitLog, parseGitStatusPorcelain, summarizeGitStatus } from "./git.js";
import { createKnowledgeCollection, indexKnowledgeCollection, updateKnowledgeCollection } from "./knowledge.js";
import { createLabel, deleteLabel, filterLabels, flattenLabels, updateLabel, validateLabelConfig } from "./labels.js";
import { createMemoryRecord, extractMemoryCandidates, parseMemoryCitations, renderMemoryContext } from "./memory.js";
import { fetchProviderModels, planModelFetchRequest } from "./model-fetchers.js";
import { evaluatePermission } from "./permissions.js";
import { allowSleep, powerState, preventSleep } from "./power.js";
import { createQueuedMessage } from "./queue.js";
import { listToolIcons, resolveToolIcon, resourceManifest } from "./resources.js";
import { listHelpers, listHelperBehaviorProfiles, listHelperSmokeProfiles, planHelperCommand, runHelperCommand, runHelperBehaviorProfile, smokeHelpers } from "./helpers.js";
import { auditYuuMiraBundle } from "./bundle-audit.js";
import { searchWorkspace } from "./search.js";
import { discoverSkills } from "./skills.js";
import { cacheSourceIcon, callMcpSourceTool, createSourceOAuthAuthorizationRequest, discoverSources, exchangeSourceOAuthCode, exchangeSourceOAuthDeviceCode, executeApiSourceRequest, getSourceRuntimeSignature, listMcpSourceTools, pollSourceOAuthDeviceCode, refreshSourceOAuthCredential, startSourceOAuthDeviceFlow, testSource } from "./sources.js";
import { createStatus, deleteStatus, setDefaultStatus, updateStatus, validateStatusConfig } from "./statuses.js";
import { createTask, updateTask, updateTaskStatus } from "./tasks.js";
import { executeTerminalCommand, finishTerminalRecord, createTerminalRecord, createTerminalSession, recordTerminalChunk, replayTerminalRecord, TerminalProcessManager } from "./terminal.js";
import { createView, updateView } from "./views.js";
import { discoverWorkflows } from "./workflows.js";

export class ToolRegistry {
  constructor(tools = []) {
    this.tools = new Map();
    for (const tool of tools) this.register(tool);
  }

  register(tool) {
    if (!tool?.name || typeof tool.run !== "function") {
      throw new Error("Tool must include a name and run function.");
    }
    this.tools.set(tool.name, tool);
  }

  list() {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }));
  }

  async run(name, input, context) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.run(input ?? {}, context);
  }
}

export function createDefaultTools({ workspace }) {
  let terminalProcessManager = null;
  return new ToolRegistry([
    {
      name: "workspace.list",
      description: "List files and directories within the workspace.",
      inputSchema: { type: "object", properties: { dir: { type: "string" } } },
      async run(input) {
        const target = resolveInsideWorkspace(workspace, input.dir || ".");
        const entries = await readdir(target, { withFileTypes: true });
        return entries
          .filter((entry) => !entry.name.startsWith(".git"))
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file"
          }));
      }
    },
    {
      name: "workspace.read",
      description: "Read a UTF-8 text file within the workspace.",
      inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
      async run(input) {
        if (!input.file) throw new Error("workspace.read requires file.");
        const target = resolveInsideWorkspace(workspace, input.file);
        const info = await stat(target);
        if (!info.isFile()) throw new Error(`${input.file} is not a file.`);
        return readFile(target, "utf8");
      }
    },
    {
      name: "memory.remember",
      description: "Persist a short project memory fact.",
      inputSchema: { type: "object", required: ["fact"], properties: { fact: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
      async run(input, context) {
        if (!input.fact) throw new Error("memory.remember requires fact.");
        const workspaceRecord = await context.store.getWorkspace();
        const record = createMemoryRecord({
          text: input.fact,
          workspaceId: workspaceRecord.id,
          sessionId: context.thread?.id ?? null,
          tags: input.tags ?? []
        });
        await context.store.appendMemoryRecord(record);
        return { remembered: record.text, record };
      }
    },
    {
      name: "memory.search",
      description: "Search persisted memory facts by substring.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
      async run(input, context) {
        return context.store.searchMemoryRecords({ query: input.query, limit: input.limit });
      }
    },
    {
      name: "memory.context",
      description: "Render bounded memory context with citable memory ids.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, maxChars: { type: "number" } } },
      async run(input, context) {
        return renderMemoryContext(await context.store.listMemoryRecords(), input);
      }
    },
    {
      name: "memory.citations",
      description: "Extract cited memory ids from assistant text and optionally record usage.",
      inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" }, recordUsage: { type: "boolean" } } },
      async run(input, context) {
        const ids = parseMemoryCitations(input.text);
        const records = input.recordUsage === false ? [] : await context.store.recordMemoryCitations(ids);
        return { ids, records };
      }
    },
    {
      name: "memory.extract",
      description: "Extract memory candidates from retrospective text.",
      inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" }, source: { type: "string" }, sessionId: { type: "string" }, tags: { type: "array", items: { type: "string" } }, persist: { type: "boolean" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const candidates = extractMemoryCandidates({
          text: input.text,
          source: input.source ?? "RetrospectiveExtraction",
          workspaceId: workspaceRecord.id,
          sessionId: input.sessionId,
          tags: input.tags
        });
        if (input.persist === true) {
          for (const record of candidates) await context.store.appendMemoryRecord(record);
        }
        return { candidates, persisted: input.persist === true ? candidates.length : 0 };
      }
    },
    {
      name: "memory.maintain",
      description: "Consolidate, prune, and render memory records.",
      inputSchema: {
        type: "object",
        properties: {
          maxRecords: { type: "number" },
          maxAgeDays: { type: "number" },
          minUsageCount: { type: "number" },
          maxRemovedPerRun: { type: "number" },
          maxRemovedRatio: { type: "number" },
          title: { type: "string" },
          scanCitations: { type: "boolean" },
          compatibility: { type: "boolean" },
          userCompatibility: { type: "boolean" }
        }
      },
      async run(input, context) {
        return context.store.maintainMemory(input);
      }
    },
    {
      name: "config.get",
      description: "Read merged application defaults.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return mergeConfig();
      }
    },
    {
      name: "power.state",
      description: "Inspect current keep-awake leases.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return powerState();
      }
    },
    {
      name: "power.prevent_sleep",
      description: "Acquire a keep-awake lease for long-running agent work.",
      inputSchema: { type: "object", properties: { reason: { type: "string" }, metadata: { type: "object" } } },
      async run(input) {
        const token = preventSleep(input.reason ?? "manual", input.metadata ?? {});
        return { token, state: powerState() };
      }
    },
    {
      name: "power.allow_sleep",
      description: "Release a keep-awake lease by id or latest lease.",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      async run(input) {
        const released = allowSleep(input.id);
        return { released, state: powerState() };
      }
    },
    {
      name: "protocol.events",
      description: "List persisted protocol lifecycle events.",
      inputSchema: { type: "object", properties: { threadId: { type: "string" }, type: { type: "string" } } },
      async run(input, context) {
        return context.store.listProtocolEvents(input);
      }
    },
    {
      name: "thread.queue_message",
      description: "Queue a follow-up user message for a thread to replay after the active run.",
      inputSchema: {
        type: "object",
        required: ["content"],
        properties: {
          threadId: { type: "string" },
          content: { type: "string" },
          source: { type: "string" }
        }
      },
      async run(input, context) {
        const threadId = input.threadId ?? context.thread?.id;
        const message = createQueuedMessage({
          threadId,
          content: input.content,
          source: input.source ?? "tool",
          status: context.thread?.status === "running" ? "acknowledged" : "pending"
        });
        return context.store.saveQueuedMessage(message);
      }
    },
    {
      name: "thread.queue",
      description: "List queued follow-up messages for a thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          status: { type: "string" }
        }
      },
      async run(input, context) {
        return context.store.listQueuedMessages({
          threadId: input.threadId ?? context.thread?.id,
          status: input.status
        });
      }
    },
    {
      name: "run_control.stop",
      description: "Request that a running thread stop at the next safe point.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          reason: { type: "string" }
        }
      },
      async run(input, context) {
        const threadId = input.threadId ?? context.thread?.id;
        const current = await context.store.getRunControl(threadId);
        const now = new Date().toISOString();
        const control = {
          ...(current ?? { threadId, heartbeatAt: now }),
          status: "stop_requested",
          reason: input.reason ?? "tool_requested",
          updatedAt: now
        };
        return context.store.saveRunControl(control);
      }
    },
    {
      name: "run_control.list",
      description: "List persisted run-control records.",
      inputSchema: { type: "object", properties: { status: { type: "string" } } },
      async run(input, context) {
        return context.store.listRunControls(input);
      }
    },
    {
      name: "permission.evaluate",
      description: "Evaluate a command, API path, MCP tool, or tool name against permission rules.",
      inputSchema: {
        type: "object",
        required: ["kind", "value"],
        properties: {
          mode: { type: "string" },
          kind: { type: "string" },
          value: { type: "string" },
          method: { type: "string" },
          path: { type: "string" },
          rules: { type: "object" }
        }
      },
      async run(input) {
        return evaluatePermission(input);
      }
    },
    {
      name: "skills.list",
      description: "Discover workspace and global Craft-compatible skills.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return discoverSkills({ workspace });
      }
    },
    {
      name: "workflows.list",
      description: "Discover workflow markdown files.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return discoverWorkflows({ workspace });
      }
    },
    {
      name: "statuses.list",
      description: "List workspace session statuses.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return context.store.getStatusConfig();
      }
    },
    {
      name: "statuses.validate",
      description: "Validate workspace session statuses.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return validateStatusConfig(await context.store.getStatusConfig());
      }
    },
    {
      name: "statuses.create",
      description: "Create a custom workspace status.",
      inputSchema: { type: "object", required: ["id", "label"], properties: { id: { type: "string" }, label: { type: "string" }, category: { type: "string" }, color: { type: "string" }, isDefault: { type: "boolean" } } },
      async run(input, context) {
        const config = createStatus(await context.store.getStatusConfig(), input);
        await context.store.saveStatusConfig(config);
        return config;
      }
    },
    {
      name: "statuses.update",
      description: "Update a custom workspace status.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, nextId: { type: "string" }, label: { type: "string" }, category: { type: "string" }, color: { type: "string" }, isDefault: { type: "boolean" } } },
      async run(input, context) {
        const config = updateStatus(await context.store.getStatusConfig(), input.id, { ...input, id: input.nextId });
        await context.store.saveStatusConfig(config);
        return config;
      }
    },
    {
      name: "statuses.default",
      description: "Set the default workspace status.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      async run(input, context) {
        const config = setDefaultStatus(await context.store.getStatusConfig(), input.id);
        await context.store.saveStatusConfig(config);
        return config;
      }
    },
    {
      name: "statuses.delete",
      description: "Delete a custom workspace status and return the replacement status id.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, replacementStatusId: { type: "string" } } },
      async run(input, context) {
        const deleted = deleteStatus(await context.store.getStatusConfig(), input.id, { replacementStatusId: input.replacementStatusId });
        await context.store.saveStatusConfig(deleted.config);
        deleted.migrated = await migrateStatusReferences(context.store, input.id, deleted.replacementStatusId);
        return deleted;
      }
    },
    {
      name: "labels.list",
      description: "List flattened workspace labels.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, valueType: { type: "string" }, parentId: { type: "string" } } },
      async run(input, context) {
        return filterLabels(await context.store.getLabelConfig(), input);
      }
    },
    {
      name: "labels.validate",
      description: "Validate workspace labels.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return validateLabelConfig(await context.store.getLabelConfig());
      }
    },
    {
      name: "labels.create",
      description: "Create a workspace label, optionally under a parent label.",
      inputSchema: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" }, color: { type: "string" }, valueType: { type: "string" }, parentId: { type: "string" } } },
      async run(input, context) {
        const config = createLabel(await context.store.getLabelConfig(), input);
        await context.store.saveLabelConfig(config);
        return { config, labels: flattenLabels(config) };
      }
    },
    {
      name: "labels.update",
      description: "Update a workspace label and migrate references when the id changes.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, nextId: { type: "string" }, name: { type: "string" }, color: { type: "string" }, valueType: { type: "string" }, parentId: { type: "string" } } },
      async run(input, context) {
        const config = updateLabel(await context.store.getLabelConfig(), input.id, { ...input, id: input.nextId });
        await context.store.saveLabelConfig(config);
        const migrated = input.nextId && input.nextId !== input.id ? await renameLabelReferences(context.store, input.id, input.nextId) : { sessions: 0, tasks: 0 };
        return { config, labels: flattenLabels(config), migrated };
      }
    },
    {
      name: "labels.delete",
      description: "Delete a workspace label and remove matching session/task label references.",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      async run(input, context) {
        const deleted = deleteLabel(await context.store.getLabelConfig(), input.id);
        await context.store.saveLabelConfig(deleted.config);
        deleted.migrated = await removeLabelReferences(context.store, deleted.removed);
        return { ...deleted, labels: flattenLabels(deleted.config) };
      }
    },
    {
      name: "sessions.create",
      description: "Create a workspace session.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          name: { type: "string" },
          prompt: { type: "string" },
          permissionMode: { type: "string" },
          statusId: { type: "string" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const session = createSession({
          workspaceId: workspaceRecord.id,
          name: input.name,
          prompt: input.prompt,
          permissionMode: input.permissionMode,
          statusId: input.statusId,
          labelConfig: await context.store.getLabelConfig(),
          statusConfig: await context.store.getStatusConfig()
        });
        await context.store.saveSession(session);
        return session;
      }
    },
    {
      name: "sessions.list",
      description: "List workspace sessions.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return context.store.listSessions();
      }
    },
    {
      name: "sessions.set_status",
      description: "Change a session status and emit a domain event.",
      inputSchema: {
        type: "object",
        required: ["sessionId", "statusId"],
        properties: {
          sessionId: { type: "string" },
          statusId: { type: "string" }
        }
      },
      async run(input, context) {
        const current = await context.store.getSession(input.sessionId);
        const { session, event } = updateSessionStatus(current, input.statusId, await context.store.getStatusConfig());
        await context.store.saveSession(session);
        await context.store.appendDomainEvent(event);
        return { session, event };
      }
    },
    {
      name: "sessions.add_label",
      description: "Add a label to a session and emit a domain event.",
      inputSchema: {
        type: "object",
        required: ["sessionId", "label"],
        properties: {
          sessionId: { type: "string" },
          label: { type: "string" }
        }
      },
      async run(input, context) {
        const current = await context.store.getSession(input.sessionId);
        const { session, event } = addSessionLabel(current, input.label);
        await context.store.saveSession(session);
        if (event) await context.store.appendDomainEvent(event);
        return { session, event };
      }
    },
    {
      name: "automations.validate",
      description: "Validate workspace automation config.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return validateAutomationConfig(await context.store.getAutomationConfig());
      }
    },
    {
      name: "automations.lint",
      description: "Lint workspace automation config and return warnings.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return lintAutomationConfig(await context.store.getAutomationConfig());
      }
    },
    {
      name: "automations.run",
      description: "Run matching automation actions for an event.",
      inputSchema: {
        type: "object",
        required: ["event"],
        properties: {
          event: { type: "object" },
          executeWebhooks: { type: "boolean" }
        }
      },
      async run(input, context) {
        return runAutomations({
          config: await context.store.getAutomationConfig(),
          event: input.event,
          store: context.store,
          executeWebhooks: input.executeWebhooks === true
        });
      }
    },
    {
      name: "automations.tick",
      description: "Run SchedulerTick automations once and record history.",
      inputSchema: {
        type: "object",
        properties: {
          now: { type: "string" },
          executeWebhooks: { type: "boolean" }
        }
      },
      async run(input, context) {
        return runAutomationSchedulerTick({
          store: context.store,
          now: input.now ? new Date(input.now) : new Date(),
          executeWebhooks: input.executeWebhooks === true
        });
      }
    },
    {
      name: "sources.list",
      description: "Discover workspace source configurations.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        return discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store });
      }
    },
    {
      name: "credentials.list",
      description: "List saved credential summaries without secret values.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return context.store.listCredentialSummaries();
      }
    },
    {
      name: "credentials.storage",
      description: "Report the active credential secret storage backend.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return context.store.credentialStorageInfo();
      }
    },
    {
      name: "credentials.save",
      description: "Save a source credential without returning the secret.",
      inputSchema: {
        type: "object",
        required: ["sourceSlug", "mode", "value"],
        properties: {
          sourceSlug: { type: "string" },
          provider: { type: "string" },
          mode: { type: "string" },
          value: {},
          refreshToken: { type: "string" },
          expiresAt: { type: "string" }
        }
      },
      async run(input, context) {
        const record = await context.store.saveCredential(createCredentialRecord(input));
        return { saved: true, credential: await context.store.getCredential(record.sourceSlug).then((item) => item && { ...item, value: undefined, refreshToken: item.refreshToken ? "[REDACTED]" : null }) };
      }
    },
    {
      name: "source.auth_help",
      description: "Return the credential prompt shape for a source.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return credentialPromptSpec(source);
      }
    },
    {
      name: "source.credentials_save",
      description: "Save source credentials using the source auth prompt fields.",
      inputSchema: {
        type: "object",
        required: ["sourceSlug", "fields"],
        properties: {
          sourceSlug: { type: "string" },
          fields: { type: "object" },
          refreshToken: { type: "string" },
          expiresAt: { type: "string" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        const record = await context.store.saveCredential(credentialFromPromptInput(source, input));
        return { saved: true, credential: { ...record, value: undefined, refreshToken: record.refreshToken ? "[REDACTED]" : null } };
      }
    },
    {
      name: "source.auth_state",
      description: "Return source authentication state derived from config and credential presence.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return sourceAuthState(source, await context.store.getCredential(source.slug));
      }
    },
    {
      name: "source.runtime_signature",
      description: "Return the restart signature for a source runtime without exposing credential secrets.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return getSourceRuntimeSignature({ source, store: context.store });
      }
    },
    {
      name: "source.apply_api_auth",
      description: "Apply saved API credentials to a URL and headers without exposing the secret itself.",
      inputSchema: { type: "object", required: ["sourceSlug", "url"], properties: { sourceSlug: { type: "string" }, url: { type: "string" }, headers: { type: "object" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return applyApiAuth({ url: input.url, headers: input.headers, source, credential: await context.store.getCredential(source.slug) });
      }
    },
    {
      name: "source.test",
      description: "Validate and test a source connection, persisting connectionStatus and lastTestedAt.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return testSource({ source, store: context.store });
      }
    },
    {
      name: "source.icon_cache",
      description: "Download and cache a source icon into its source folder.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return cacheSourceIcon({ source });
      }
    },
    {
      name: "source.api_request",
      description: "Execute an authenticated API source request and return a redacted response summary.",
      inputSchema: {
        type: "object",
        required: ["sourceSlug", "path"],
        properties: {
          sourceSlug: { type: "string" },
          path: { type: "string" },
          method: { type: "string" },
          body: { type: "object" },
          headers: { type: "object" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return executeApiSourceRequest({
          source,
          endpointPath: input.path,
          method: input.method,
          body: input.body,
          headers: input.headers,
          store: context.store
        });
      }
    },
    {
      name: "source.mcp_tools",
      description: "Initialize a stdio MCP source and list its tools.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" }, timeoutMs: { type: "number" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return listMcpSourceTools({ source, store: context.store, timeoutMs: input.timeoutMs });
      }
    },
    {
      name: "source.mcp_call",
      description: "Call a tool exposed by a stdio MCP source.",
      inputSchema: {
        type: "object",
        required: ["sourceSlug", "name"],
        properties: {
          sourceSlug: { type: "string" },
          name: { type: "string" },
          arguments: { type: "object" },
          timeoutMs: { type: "number" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return callMcpSourceTool({ source, name: input.name, arguments: input.arguments, store: context.store, timeoutMs: input.timeoutMs });
      }
    },
    {
      name: "source.oauth_authorize",
      description: "Build an OAuth authorization URL for a source.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" }, state: { type: "string" }, generateState: { type: "boolean" }, pkce: { type: "boolean" }, codeChallenge: { type: "string" }, codeVerifier: { type: "string" }, redirectUri: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return createSourceOAuthAuthorizationRequest({
          source,
          state: input.state,
          generateState: input.generateState,
          pkce: input.pkce,
          codeChallenge: input.codeChallenge,
          codeVerifier: input.codeVerifier,
          redirectUri: input.redirectUri
        });
      }
    },
    {
      name: "source.oauth_device",
      description: "Start an OAuth device authorization flow for a source.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        return startSourceOAuthDeviceFlow({ source });
      }
    },
    {
      name: "source.oauth_exchange",
      description: "Exchange an OAuth authorization code or device code and save the credential.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" }, code: { type: "string" }, deviceCode: { type: "string" }, codeVerifier: { type: "string" }, redirectUri: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        const credential = input.deviceCode
          ? await exchangeSourceOAuthDeviceCode({ source, deviceCode: input.deviceCode, store: context.store })
          : await exchangeSourceOAuthCode({ source, code: input.code, codeVerifier: input.codeVerifier, redirectUri: input.redirectUri, store: context.store });
        return { saved: true, credential: { ...credential, value: undefined, refreshToken: credential.refreshToken ? "[REDACTED]" : null } };
      }
    },
    {
      name: "source.oauth_poll_device",
      description: "Poll an OAuth device code until authorization completes and save the credential.",
      inputSchema: {
        type: "object",
        required: ["sourceSlug", "deviceCode"],
        properties: {
          sourceSlug: { type: "string" },
          deviceCode: { type: "string" },
          intervalSecs: { type: "number" },
          expiresIn: { type: "number" },
          maxAttempts: { type: "number" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        const credential = await pollSourceOAuthDeviceCode({
          source,
          deviceCode: input.deviceCode,
          intervalSecs: input.intervalSecs,
          expiresIn: input.expiresIn,
          maxAttempts: input.maxAttempts,
          store: context.store
        });
        return { saved: true, credential: { ...credential, value: undefined, refreshToken: credential.refreshToken ? "[REDACTED]" : null } };
      }
    },
    {
      name: "source.oauth_refresh",
      description: "Refresh a saved OAuth source credential.",
      inputSchema: { type: "object", required: ["sourceSlug"], properties: { sourceSlug: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: context.store })).find((item) => item.slug === input.sourceSlug);
        if (!source) throw new Error(`Unknown source: ${input.sourceSlug}`);
        const credential = await refreshSourceOAuthCredential({ source, store: context.store });
        return { refreshed: true, credential: { ...credential, value: undefined, refreshToken: credential.refreshToken ? "[REDACTED]" : null } };
      }
    },
    {
      name: "projects.list",
      description: "List workspace projects.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return context.store.listProjects();
      }
    },
    {
      name: "projects.create",
      description: "Create a workspace project.",
      inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, root: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const project = createProject({ workspaceId: workspaceRecord.id, name: input.name, root: input.root ?? workspace });
        await context.store.saveProject(project);
        return project;
      }
    },
    {
      name: "projects.update",
      description: "Update a workspace project.",
      inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" }, name: { type: "string" }, root: { type: "string" } } },
      async run(input, context) {
        const project = updateProject(await context.store.getProject(input.projectId), input);
        await context.store.saveProject(project);
        return project;
      }
    },
    {
      name: "projects.delete",
      description: "Delete a workspace project and detach session/task references.",
      inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
      async run(input, context) {
        const project = await context.store.getProject(input.projectId);
        await context.store.deleteProject(input.projectId);
        const detached = await detachProjectReferences(context.store, input.projectId);
        return { project, detached };
      }
    },
    {
      name: "tasks.list",
      description: "List workspace tasks.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, sessionId: { type: "string" }, statusId: { type: "string" }, label: { type: "string" }, query: { type: "string" }, sort: { type: "string" } } },
      async run(input, context) {
        return context.store.listTasks(input);
      }
    },
    {
      name: "tasks.create",
      description: "Create a workspace task.",
      inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, projectId: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const task = createTask({
          workspaceId: workspaceRecord.id,
          title: input.title,
          description: input.description,
          projectId: input.projectId,
          statusConfig: await context.store.getStatusConfig()
        });
        await context.store.saveTask(task);
        return task;
      }
    },
    {
      name: "tasks.update",
      description: "Update a workspace task.",
      inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, projectId: { type: "string" }, sessionId: { type: "string" }, labels: { type: "array", items: { type: "string" } }, assignee: { type: "string" }, dueDate: { type: "string" }, statusId: { type: "string" } } },
      async run(input, context) {
        const task = updateTask(await context.store.getTask(input.taskId), input, await context.store.getStatusConfig());
        await context.store.saveTask(task);
        return task;
      }
    },
    {
      name: "tasks.set_status",
      description: "Change a task status.",
      inputSchema: { type: "object", required: ["taskId", "statusId"], properties: { taskId: { type: "string" }, statusId: { type: "string" } } },
      async run(input, context) {
        const task = updateTaskStatus(await context.store.getTask(input.taskId), input.statusId, await context.store.getStatusConfig());
        await context.store.saveTask(task);
        return task;
      }
    },
    {
      name: "tasks.delete",
      description: "Delete a workspace task.",
      inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } },
      async run(input, context) {
        const task = await context.store.getTask(input.taskId);
        await context.store.deleteTask(input.taskId);
        return task;
      }
    },
    {
      name: "views.list",
      description: "List saved views.",
      inputSchema: { type: "object", properties: { entity: { type: "string" } } },
      async run(input, context) {
        return context.store.listViews(input);
      }
    },
    {
      name: "views.create",
      description: "Create a saved view.",
      inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, entity: { type: "string" }, filters: { type: "object" }, sort: { type: "string" } } },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const view = createView({ workspaceId: workspaceRecord.id, name: input.name, entity: input.entity, filters: input.filters, sort: input.sort });
        await context.store.saveView(view);
        return view;
      }
    },
    {
      name: "views.update",
      description: "Update a saved view.",
      inputSchema: { type: "object", required: ["viewId"], properties: { viewId: { type: "string" }, name: { type: "string" }, entity: { type: "string" }, filters: { type: "object" }, sort: { type: "string" } } },
      async run(input, context) {
        const view = updateView(await context.store.getView(input.viewId), input);
        await context.store.saveView(view);
        return view;
      }
    },
    {
      name: "views.delete",
      description: "Delete a saved view.",
      inputSchema: { type: "object", required: ["viewId"], properties: { viewId: { type: "string" } } },
      async run(input, context) {
        const view = await context.store.getView(input.viewId);
        await context.store.deleteView(input.viewId);
        return view;
      }
    },
    {
      name: "search.query",
      description: "Search sessions, projects, tasks, and threads.",
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
      async run(input, context) {
        return searchWorkspace({ store: context.store, query: input.query });
      }
    },
    {
      name: "knowledge.collections",
      description: "List knowledge collections registered for the workspace.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return context.store.listKnowledgeCollections();
      }
    },
    {
      name: "knowledge.create_collection",
      description: "Register a local knowledge collection such as an Obsidian vault.",
      inputSchema: {
        type: "object",
        required: ["name", "root"],
        properties: {
          name: { type: "string" },
          root: { type: "string" },
          type: { type: "string" },
          semanticEnabled: { type: "boolean" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const collection = createKnowledgeCollection({
          workspaceId: workspaceRecord.id,
          name: input.name,
          root: input.root,
          type: input.type,
          semanticEnabled: input.semanticEnabled
        });
        await context.store.saveKnowledgeCollection(collection);
        return collection;
      }
    },
    {
      name: "knowledge.index",
      description: "Index markdown/text documents from a registered knowledge collection.",
      inputSchema: { type: "object", required: ["collectionId"], properties: { collectionId: { type: "string" } } },
      async run(input, context) {
        const collections = await context.store.listKnowledgeCollections();
        const collection = collections.find((item) => item.id === input.collectionId);
        if (!collection) throw new Error(`Unknown knowledge collection: ${input.collectionId}`);
        const workspaceRecord = await context.store.getWorkspace();
        const result = await indexKnowledgeCollection({ collection, workspaceId: workspaceRecord.id });
        await context.store.saveKnowledgeDocuments(collection.id, result.documents);
        return result.report;
      }
    },
    {
      name: "knowledge.update_collection",
      description: "Update a registered knowledge collection.",
      inputSchema: { type: "object", required: ["collectionId"], properties: { collectionId: { type: "string" }, name: { type: "string" }, root: { type: "string" }, type: { type: "string" }, enabled: { type: "boolean" }, semanticEnabled: { type: "boolean" } } },
      async run(input, context) {
        const collection = updateKnowledgeCollection(await context.store.getKnowledgeCollection(input.collectionId), input);
        await context.store.saveKnowledgeCollection(collection);
        return collection;
      }
    },
    {
      name: "knowledge.delete_collection",
      description: "Delete a registered knowledge collection and its indexed documents.",
      inputSchema: { type: "object", required: ["collectionId"], properties: { collectionId: { type: "string" } } },
      async run(input, context) {
        const collection = await context.store.getKnowledgeCollection(input.collectionId);
        await context.store.deleteKnowledgeCollection(input.collectionId);
        return collection;
      }
    },
    {
      name: "knowledge.inspect",
      description: "Inspect knowledge collections for stale or missing indexed documents.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return context.store.inspectKnowledge();
      }
    },
    {
      name: "knowledge.repair",
      description: "Reindex enabled knowledge collections and rebuild maintenance report.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        return context.store.repairKnowledge({ workspaceId: workspaceRecord.id });
      }
    },
    {
      name: "knowledge.search",
      description: "Search indexed knowledge documents literally or through the local semantic index.",
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, collectionId: { type: "string" }, limit: { type: "number" }, semantic: { type: "boolean" } } },
      async run(input, context) {
        return input.semantic === true ? context.store.searchKnowledgeSemantic(input) : context.store.searchKnowledge(input);
      }
    },
    {
      name: "knowledge.report",
      description: "Return the knowledge cockpit index report.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return context.store.getKnowledgeReport();
      }
    },
    {
      name: "knowledge.semantic_status",
      description: "Return persisted semantic engine model/cache/job status.",
      inputSchema: { type: "object", properties: {} },
      async run(input, context) {
        return { state: await context.store.getKnowledgeSemanticState(), semanticEngine: (await context.store.getKnowledgeReport()).semanticEngine };
      }
    },
    {
      name: "knowledge.semantic_configure",
      description: "Update semantic engine model/cache readiness metadata.",
      inputSchema: {
        type: "object",
        properties: {
          model: { type: "string" },
          cacheDir: { type: "string" },
          installed: { type: "boolean" },
          status: { type: "string" },
          reason: { type: "string" }
        }
      },
      async run(input, context) {
        const state = await context.store.configureKnowledgeSemanticState(input);
        return { state, semanticEngine: (await context.store.getKnowledgeReport()).semanticEngine };
      }
    },
    {
      name: "knowledge.semantic_job",
      description: "Create a semantic index job record for tracked knowledge documents.",
      inputSchema: {
        type: "object",
        properties: {
          collectionId: { type: "string" },
          model: { type: "string" },
          cacheDir: { type: "string" }
        }
      },
      async run(input, context) {
        return context.store.createKnowledgeSemanticJob(input);
      }
    },
    {
      name: "git.parse_status",
      description: "Parse git status porcelain or short output into structured file changes.",
      inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      async run(input) {
        const entries = parseGitStatusPorcelain(input.text);
        return { entries, summary: summarizeGitStatus(entries) };
      }
    },
    {
      name: "git.parse_log",
      description: "Parse git log records produced by the YuuMira-compatible pretty format.",
      inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      async run(input) {
        return { commits: parseGitLog(input.text), prettyFormat: gitLogPrettyFormat() };
      }
    },
    {
      name: "terminal.history",
      description: "List recorded terminal command history.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, exitCode: { type: "number" } } },
      async run(input, context) {
        return context.store.listTerminalHistory(input);
      }
    },
    {
      name: "terminal.sessions",
      description: "List persisted terminal sessions.",
      inputSchema: { type: "object", properties: { status: { type: "string" } } },
      async run(input, context) {
        return context.store.listTerminalSessions(input);
      }
    },
    {
      name: "terminal.create_session",
      description: "Create a persistent terminal session metadata record.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          cwd: { type: "string" },
          shell: { type: "string" },
          dimensions: { type: "object" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const session = createTerminalSession({
          workspaceId: workspaceRecord.id,
          name: input.name,
          cwd: input.cwd ?? workspace,
          shell: input.shell ?? process.env.SHELL ?? null,
          dimensions: input.dimensions
        });
        return context.store.saveTerminalSession(session);
      }
    },
    {
      name: "terminal.attach_session",
      description: "Attach an existing terminal record to a terminal session.",
      inputSchema: { type: "object", required: ["sessionId", "recordId"], properties: { sessionId: { type: "string" }, recordId: { type: "string" } } },
      async run(input, context) {
        return context.store.attachTerminalRecordToSession(input.sessionId, input.recordId);
      }
    },
    {
      name: "terminal.close_session",
      description: "Close a persisted terminal session.",
      inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } },
      async run(input, context) {
        return context.store.closeTerminalSession(input.sessionId);
      }
    },
    {
      name: "terminal.record",
      description: "Record a terminal command execution summary.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          sessionId: { type: "string" },
          cwd: { type: "string" },
          exitCode: { type: "number" },
          output: { type: "string" },
          startedAt: { type: "string" },
          endedAt: { type: "string" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const record = createTerminalRecord({
          workspaceId: workspaceRecord.id,
          sessionId: input.sessionId,
          command: input.command,
          cwd: input.cwd ?? workspace,
          exitCode: input.exitCode,
          output: input.output,
          startedAt: input.startedAt,
          endedAt: input.endedAt
        });
        await context.store.saveTerminalRecord(record);
        if (input.sessionId) await context.store.attachTerminalRecordToSession(input.sessionId, record.id);
        return record;
      }
    },
    {
      name: "terminal.run",
      description: "Run a terminal command and persist stdout/stderr event frames.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          sessionId: { type: "string" },
          cwd: { type: "string" },
          shell: { type: "string" },
          env: { type: "object" },
          timeoutMs: { type: "number" },
          dimensions: { type: "object" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const record = await executeTerminalCommand({
          workspaceId: workspaceRecord.id,
          sessionId: input.sessionId,
          command: input.command,
          cwd: input.cwd ?? workspace,
          shell: input.shell ?? process.env.SHELL ?? true,
          env: input.env,
          timeoutMs: input.timeoutMs,
          dimensions: input.dimensions,
          saveRecord: (record) => context.store.saveTerminalRecord(record)
        });
        if (input.sessionId) await context.store.attachTerminalRecordToSession(input.sessionId, record.id);
        return record;
      }
    },
    {
      name: "terminal.start",
      description: "Start a terminal command in the background and persist output event frames.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          sessionId: { type: "string" },
          cwd: { type: "string" },
          shell: { type: "string" },
          env: { type: "object" },
          timeoutMs: { type: "number" },
          dimensions: { type: "object" }
        }
      },
      async run(input, context) {
        const workspaceRecord = await context.store.getWorkspace();
        const record = await terminalManager(context).start({
          workspaceId: workspaceRecord.id,
          sessionId: input.sessionId,
          command: input.command,
          cwd: input.cwd ?? workspace,
          shell: input.shell ?? process.env.SHELL ?? true,
          env: input.env,
          timeoutMs: input.timeoutMs,
          dimensions: input.dimensions
        });
        if (input.sessionId) await context.store.attachTerminalRecordToSession(input.sessionId, record.id);
        return record;
      }
    },
    {
      name: "terminal.cancel",
      description: "Cancel a running terminal command.",
      inputSchema: { type: "object", required: ["recordId"], properties: { recordId: { type: "string" }, signal: { type: "string" } } },
      async run(input, context) {
        return terminalManager(context).cancel(input.recordId, { signal: input.signal });
      }
    },
    {
      name: "terminal.write",
      description: "Write text to a running terminal process stdin.",
      inputSchema: { type: "object", required: ["recordId", "data"], properties: { recordId: { type: "string" }, data: { type: "string" } } },
      async run(input, context) {
        return terminalManager(context).write(input.recordId, { data: input.data });
      }
    },
    {
      name: "terminal.resize",
      description: "Record a terminal resize event for a running terminal process.",
      inputSchema: { type: "object", required: ["recordId", "cols", "rows"], properties: { recordId: { type: "string" }, cols: { type: "number" }, rows: { type: "number" } } },
      async run(input, context) {
        return terminalManager(context).resize(input.recordId, { cols: input.cols, rows: input.rows });
      }
    },
    {
      name: "terminal.process",
      description: "Inspect whether a terminal record has a live process in this runtime.",
      inputSchema: { type: "object", required: ["recordId"], properties: { recordId: { type: "string" } } },
      async run(input, context) {
        return terminalManager(context).status(input.recordId);
      }
    },
    {
      name: "terminal.append_event",
      description: "Append a stdout or stderr chunk to a terminal record.",
      inputSchema: {
        type: "object",
        required: ["recordId", "data"],
        properties: {
          recordId: { type: "string" },
          stream: { type: "string" },
          data: { type: "string" },
          createdAt: { type: "string" }
        }
      },
      async run(input, context) {
        const record = recordTerminalChunk(await context.store.getTerminalRecord(input.recordId), {
          stream: input.stream,
          data: input.data,
          createdAt: input.createdAt
        });
        return context.store.saveTerminalRecord(record);
      }
    },
    {
      name: "terminal.finish",
      description: "Mark a terminal record complete with an exit code.",
      inputSchema: {
        type: "object",
        required: ["recordId"],
        properties: {
          recordId: { type: "string" },
          exitCode: { type: "number" },
          endedAt: { type: "string" }
        }
      },
      async run(input, context) {
        const record = finishTerminalRecord(await context.store.getTerminalRecord(input.recordId), {
          exitCode: input.exitCode,
          endedAt: input.endedAt
        });
        return context.store.saveTerminalRecord(record);
      }
    },
    {
      name: "terminal.replay",
      description: "Replay a terminal record as ordered output frames.",
      inputSchema: { type: "object", required: ["recordId"], properties: { recordId: { type: "string" } } },
      async run(input, context) {
        return replayTerminalRecord(await context.store.getTerminalRecord(input.recordId));
      }
    },
    {
      name: "provider.model_request",
      description: "Plan the provider-specific model list request without fetching it.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "object" },
          apiKey: { type: "string" },
          useOllamaTags: { type: "boolean" }
        }
      },
      async run(input) {
        return planModelFetchRequest(input);
      }
    },
    {
      name: "provider.models",
      description: "Fetch and normalize model list entries for a provider profile.",
      inputSchema: {
        type: "object",
        required: ["provider"],
        properties: {
          provider: { type: "object" },
          apiKey: { type: "string" },
          useOllamaTags: { type: "boolean" },
          timeoutMs: { type: "number" }
        }
      },
      async run(input) {
        return fetchProviderModels(input);
      }
    },
    {
      name: "resources.manifest",
      description: "List YuuMira-compatible static resource roots, themes, and tool icon assets.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return resourceManifest();
      }
    },
    {
      name: "audit.bundle",
      description: "Compare the authorized installed YuuMira bundle structure with this clean-room clone.",
      inputSchema: {
        type: "object",
        properties: {
          appPath: { type: "string" },
          resourceDir: { type: "string" }
        }
      },
      async run(input, context) {
        return auditYuuMiraBundle({
          appPath: input.appPath,
          workspace: context.workspace ?? workspace,
          resourceDir: input.resourceDir
        });
      }
    },
    {
      name: "tool_icons.list",
      description: "List YuuMira-compatible command icon resources.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return listToolIcons();
      }
    },
    {
      name: "tool_icons.resolve",
      description: "Resolve a command line to a known tool icon resource.",
      inputSchema: { type: "object", required: ["command"], properties: { command: { type: "string" } } },
      async run(input) {
        return resolveToolIcon(input.command);
      }
    },
    {
      name: "helpers.list",
      description: "List imported YuuMira helper bin wrappers and scripts.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return listHelpers();
      }
    },
    {
      name: "helpers.plan",
      description: "Plan a YuuMira helper wrapper invocation without executing it.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" }
        }
      },
      async run(input, context) {
        return planHelperCommand({ name: input.name, args: input.args, cwd: input.cwd ?? context.workspace ?? workspace });
      }
    },
    {
      name: "helpers.run",
      description: "Execute an imported YuuMira helper wrapper and return stdout, stderr, and exit code.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          timeoutMs: { type: "number" }
        }
      },
      async run(input, context) {
        return runHelperCommand({
          name: input.name,
          args: input.args,
          cwd: input.cwd ?? context.workspace ?? workspace,
          timeoutMs: input.timeoutMs ?? 30000
        });
      }
    },
    {
      name: "helpers.smoke",
      description: "Run lightweight smoke checks against imported YuuMira helper wrappers.",
      inputSchema: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
          args: { type: "array", items: { type: "string" } },
          profile: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" }
        }
      },
      async run(input, context) {
        return smokeHelpers({
          names: input.names,
          args: input.args,
          profile: input.profile,
          cwd: input.cwd ?? context.workspace ?? workspace,
          timeoutMs: input.timeoutMs ?? 30000
        });
      }
    },
    {
      name: "helpers.smoke_profiles",
      description: "List standard YuuMira helper smoke profiles.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return listHelperSmokeProfiles();
      }
    },
    {
      name: "helpers.behavior_profiles",
      description: "List standard YuuMira helper behavior smoke profiles.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return listHelperBehaviorProfiles();
      }
    },
    {
      name: "helpers.behavior_smoke",
      description: "Run a standard YuuMira helper behavior smoke profile.",
      inputSchema: {
        type: "object",
        properties: {
          profile: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
          keepTemp: { type: "boolean" }
        }
      },
      async run(input, context) {
        return runHelperBehaviorProfile({
          profile: input.profile ?? "ical-basic",
          cwd: input.cwd ?? context.workspace ?? workspace,
          timeoutMs: input.timeoutMs ?? 60000,
          keepTemp: input.keepTemp === true
        });
      }
    }
  ]);

  function terminalManager(context) {
    terminalProcessManager ??= new TerminalProcessManager({
      saveRecord: (record) => context.store.saveTerminalRecord(record)
    });
    return terminalProcessManager;
  }
}

function resolveInsideWorkspace(workspace, requestedPath) {
  const target = path.resolve(workspace, requestedPath);
  const root = path.resolve(workspace);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  return target;
}

async function migrateStatusReferences(store, fromStatusId, toStatusId) {
  let sessions = 0;
  for (const session of await store.listSessions()) {
    if (session.statusId === fromStatusId) {
      await store.saveSession({ ...session, statusId: toStatusId, updatedAt: new Date().toISOString() });
      sessions += 1;
    }
  }
  let tasks = 0;
  for (const task of await store.listTasks()) {
    if (task.statusId === fromStatusId) {
      await store.saveTask({ ...task, statusId: toStatusId, updatedAt: new Date().toISOString() });
      tasks += 1;
    }
  }
  return { sessions, tasks };
}

async function detachProjectReferences(store, projectId) {
  let sessions = 0;
  for (const session of await store.listSessions()) {
    if (session.projectId === projectId) {
      await store.saveSession({ ...session, projectId: null, updatedAt: new Date().toISOString() });
      sessions += 1;
    }
  }
  let tasks = 0;
  for (const task of await store.listTasks()) {
    if (task.projectId === projectId) {
      await store.saveTask({ ...task, projectId: null, updatedAt: new Date().toISOString() });
      tasks += 1;
    }
  }
  return { sessions, tasks };
}

async function renameLabelReferences(store, fromLabelId, toLabelId) {
  let sessions = 0;
  for (const session of await store.listSessions()) {
    const labels = renameLabels(session.labels ?? [], fromLabelId, toLabelId);
    if (labels.changed) {
      await store.saveSession({ ...session, labels: labels.values, updatedAt: new Date().toISOString() });
      sessions += 1;
    }
  }
  let tasks = 0;
  for (const task of await store.listTasks()) {
    const labels = renameLabels(task.labels ?? [], fromLabelId, toLabelId);
    if (labels.changed) {
      await store.saveTask({ ...task, labels: labels.values, updatedAt: new Date().toISOString() });
      tasks += 1;
    }
  }
  return { sessions, tasks };
}

async function removeLabelReferences(store, removedLabelIds) {
  const removed = new Set(removedLabelIds);
  let sessions = 0;
  for (const session of await store.listSessions()) {
    const next = (session.labels ?? []).filter((label) => !removed.has(labelBaseId(label)));
    if (next.length !== (session.labels ?? []).length) {
      await store.saveSession({ ...session, labels: next, updatedAt: new Date().toISOString() });
      sessions += 1;
    }
  }
  let tasks = 0;
  for (const task of await store.listTasks()) {
    const next = (task.labels ?? []).filter((label) => !removed.has(labelBaseId(label)));
    if (next.length !== (task.labels ?? []).length) {
      await store.saveTask({ ...task, labels: next, updatedAt: new Date().toISOString() });
      tasks += 1;
    }
  }
  return { sessions, tasks };
}

function renameLabels(labels, fromLabelId, toLabelId) {
  let changed = false;
  const values = labels.map((label) => {
    const [id, value] = splitLabelValue(label);
    if (id !== fromLabelId) return label;
    changed = true;
    return value === null ? toLabelId : `${toLabelId}::${value}`;
  });
  return { values, changed };
}

function labelBaseId(label) {
  return splitLabelValue(label)[0];
}

function splitLabelValue(label) {
  const text = String(label);
  const index = text.indexOf("::");
  if (index === -1) return [text, null];
  return [text.slice(0, index), text.slice(index + 2)];
}
