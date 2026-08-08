import http from "node:http";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, watch } from "node:fs";
import pathModule from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { AutomationScheduler, lintAutomationConfig, runAutomations, runAutomationSchedulerTick, validateAutomationConfig } from "./automations.js";
import { applyApiAuth, createCredentialRecord, credentialFromPromptInput, credentialPromptSpec, sourceAuthState, summarizeCredential } from "./credentials.js";
import { addSessionLabel, createProject, createSession, createWorkspace, updateProject, updateSessionStatus } from "./domain.js";
import { gitAddWorktree, gitApplyStash, gitBranches, gitCommit, gitCreateBranch, gitCurrentBranch, gitDeleteBranch, gitDiff, gitDiscard, gitDropStash, gitFetch, gitGenerateCommitMessage, gitHistory, gitLogPrettyFormat, gitMerge, gitPull, gitPush, gitSaveStash, gitStage, gitStashes, gitStatus, gitSwitchBranch, gitUnstage, gitWorktrees, parseGitLog, parseGitStatusPorcelain, summarizeGitStatus } from "./git.js";
import { createKnowledgeCollection, createKnowledgeDocument, indexKnowledgeCollection, updateKnowledgeCollection } from "./knowledge.js";
import { mergeConfig } from "./config.js";
import { createMemoryRecord, extractMemoryCandidates, parseMemoryCitations, renderMemoryContext } from "./memory.js";
import { evaluatePermission, validatePermissionRules, DEFAULT_PERMISSION_RULES } from "./permissions.js";
import { discoverSkills } from "./skills.js";
import { cacheSourceIcon, callMcpSourceTool, createSourceOAuthAuthorizationRequest, discoverSources, exchangeSourceOAuthCode, exchangeSourceOAuthDeviceCode, executeApiSourceRequest, getSourceRuntimeSignature, listMcpSourceTools, pollSourceOAuthDeviceCode, refreshSourceOAuthCredential, startSourceOAuthDeviceFlow, testSource } from "./sources.js";
import { createStatus, deleteStatus, setDefaultStatus, updateStatus, validateStatusConfig } from "./statuses.js";
import { discoverWorkflows } from "./workflows.js";
import { createLabel, deleteLabel, filterLabels, flattenLabels, updateLabel, validateLabelConfig } from "./labels.js";
import { searchWorkspace } from "./search.js";
import { createTask, updateTask, updateTaskStatus } from "./tasks.js";
import { executeTerminalCommand, finishTerminalRecord, createTerminalRecord, createTerminalSession, recordTerminalChunk, replayTerminalRecord, TerminalProcessManager } from "./terminal.js";
import { applyView, createView, updateView } from "./views.js";
import { listToolIcons, resolveResource, resolveToolIcon, resourceManifest } from "./resources.js";
import { listHelpers, listHelperBehaviorProfiles, listHelperSmokeProfiles, planHelperCommand, runHelperCommand, runHelperBehaviorProfile, smokeHelpers } from "./helpers.js";
import { describeProvider, listProviderProfiles } from "./provider.js";
import { fetchProviderModels, planModelFetchRequest } from "./model-fetchers.js";
import { auditPengBundle } from "./app-audit.js";
import { allowSleep, powerState, preventSleep } from "./power.js";
import { createProtocolEvent } from "./protocol.js";
import { VERSION } from "./version.js";
import { importPengResources } from "./resource-import.js";

const moduleDir = pathModule.dirname(fileURLToPath(import.meta.url));
const projectRoot = pathModule.dirname(moduleDir);

export function createServer({ runtime, workspace }) {
  const events = new EventHub();
  const automationScheduler = new AutomationScheduler({
    store: runtime.store,
    onTick: async (result) => events.emit("automation.scheduler.tick", result.history)
  });
  const terminalProcesses = new TerminalProcessManager({
    saveRecord: (record) => runtime.store.saveTerminalRecord(record),
    onEvent: (event, record) => events.emit("terminal.event", { record, event }),
    onFinish: (record) => events.emit("terminal.finished", { record })
  });
  const workspaceWatchers = new WorkspaceWatchManager({ workspace, store: runtime.store, events });

  const server = http.createServer(async (request, response) => {
    try {
      await routeRequest({ request, response, runtime, workspace, events, terminalProcesses, automationScheduler, workspaceWatchers });
    } catch (error) {
      sendJson(response, statusFromError(error), {
        error: {
          message: error.message,
          code: error.code ?? "internal_error"
        }
      });
    }
  });
  server.on("upgrade", (request, socket) => {
    handleWebSocketUpgrade({ request, socket, runtime, events, automationScheduler, workspaceWatchers });
  });

  return {
    server,
    events,
    listen(options = {}) {
      return new Promise((resolve) => {
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        events.closeWebSockets();
        workspaceWatchers.close();
        automationScheduler.stop();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

async function routeRequest({ request, response, runtime, workspace, events, terminalProcesses, automationScheduler, workspaceWatchers }) {
  const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
  const method = request.method ?? "GET";
  const path = stripTrailingSlash(url.pathname);

  if (method === "OPTIONS") return sendEmpty(response, 204);
  if (method === "GET" && isStaticPath(path)) return serveStatic(response, path);
  if (method === "GET" && path.startsWith("/resources/")) return serveResource(response, path);
  if (method === "GET" && path === "/health") return sendJson(response, 200, { ok: true });
  if (method === "GET" && path === "/events") return events.connect(response);
  if (method === "GET" && path === "/api/config") return sendJson(response, 200, await frontendConfig({ request, runtime }));
  if (method === "GET" && path === "/api/config/workspaces") return sendJson(response, 200, await frontendWorkspaceConfig(runtime.store));
  if (method === "POST" && path === "/api/auth") return sendJson(response, 200, { ok: true, authenticated: true, mode: "none" });
  if (method === "POST" && path === "/api/auth/logout") return sendJson(response, 200, { ok: true });
  if (method === "GET" && path === "/api/push/vapid-public-key") return sendJson(response, 200, pushVapidPublicKey());
  if (method === "GET" && path === "/api/push/subscriptions") return sendJson(response, 200, (await rpcPreferences(await runtime.store.readPreferences())).pushSubscriptions);
  if (method === "POST" && path === "/api/push/subscribe") {
    const subscription = await savePushSubscription(runtime.store, await readJson(request));
    events.emit("push.subscription.saved", subscription);
    return sendJson(response, 201, subscription);
  }
  if (method === "DELETE" && path === "/api/push/subscribe") {
    const result = await deletePushSubscription(runtime.store, await readJson(request));
    events.emit("push.subscription.deleted", result);
    return sendJson(response, 200, result);
  }
  if (method === "GET" && path === "/api/power") return sendJson(response, 200, powerState());
  if (method === "POST" && path === "/api/power/prevent-sleep") {
    const body = await readJson(request);
    const token = preventSleep(body.reason ?? "manual", body.metadata ?? {});
    events.emit("power.prevent_sleep", { token, state: powerState() });
    return sendJson(response, 201, { token, state: powerState() });
  }
  if (method === "POST" && path === "/api/power/allow-sleep") {
    const body = await readJson(request);
    const released = allowSleep(body.id);
    events.emit("power.allow_sleep", { released, state: powerState() });
    return sendJson(response, 200, { released, state: powerState() });
  }
  if (method === "GET" && path === "/api/provider") {
    return sendJson(response, 200, describeProvider(runtime.provider));
  }
  if (method === "GET" && path === "/api/provider/profiles") return sendJson(response, 200, listProviderProfiles());
  if (method === "GET" && path === "/api/provider/model-request") {
    return sendJson(response, 200, planModelFetchRequest({
      provider: providerProfileFromQuery(url),
      apiKey: url.searchParams.get("apiKey") ?? undefined,
      useOllamaTags: url.searchParams.get("ollamaTags") === "true"
    }));
  }
  if (method === "POST" && path === "/api/provider/models") {
    const body = await readJson(request);
    return sendJson(response, 200, await fetchProviderModels({
      provider: body.provider ?? providerProfileFromId(body.profile),
      apiKey: body.apiKey,
      useOllamaTags: body.useOllamaTags === true,
      timeoutMs: body.timeoutMs
    }));
  }
  if (method === "GET" && path === "/api/workspace") return sendJson(response, 200, await runtime.store.getWorkspace());
  if (method === "GET" && path === "/api/workspace/watchers") return sendJson(response, 200, workspaceWatchers.snapshot());
  if (method === "POST" && path === "/api/workspace/watchers") return sendJson(response, 201, await workspaceWatchers.watch(await readJson(request)));
  if (method === "DELETE" && path === "/api/workspace/watchers") return sendJson(response, 200, await workspaceWatchers.unwatch(await readJson(request)));
  if (method === "GET" && path === "/api/workspace/file-events") return sendJson(response, 200, workspaceWatchers.recentEvents());
  if (method === "GET" && path === "/api/tools") return sendJson(response, 200, runtime.tools.list());
  if (method === "GET" && path === "/api/protocol/events") {
    return sendJson(response, 200, await runtime.store.listProtocolEvents({
      threadId: url.searchParams.get("threadId"),
      type: url.searchParams.get("type")
    }));
  }
  if (method === "GET" && path === "/api/search") {
    return sendJson(response, 200, await searchWorkspace({ store: runtime.store, query: url.searchParams.get("q") ?? "" }));
  }
  if (method === "GET" && path === "/api/memory") {
    return sendJson(response, 200, await runtime.store.listMemoryRecords());
  }
  if (method === "POST" && path === "/api/memory") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const record = createMemoryRecord({
      text: required(body.text ?? body.fact, "text"),
      source: body.source ?? "UserPromptSubmit",
      workspaceId: workspaceRecord.id,
      sessionId: body.sessionId,
      tags: body.tags
    });
    await runtime.store.appendMemoryRecord(record);
    events.emit("memory.recorded", { record });
    return sendJson(response, 201, record);
  }
  if (method === "GET" && path === "/api/memory/search") {
    return sendJson(response, 200, await runtime.store.searchMemoryRecords({
      query: url.searchParams.get("q") ?? "",
      limit: Number(url.searchParams.get("limit") ?? 10)
    }));
  }
  if (method === "POST" && path === "/api/memory/context") {
    const body = await readJson(request);
    return sendJson(response, 200, {
      context: renderMemoryContext(await runtime.store.listMemoryRecords(), {
        query: body.query,
        limit: body.limit,
        maxChars: body.maxChars
      })
    });
  }
  if (method === "POST" && path === "/api/memory/citations") {
    const body = await readJson(request);
    const ids = parseMemoryCitations(required(body.text, "text"));
    const records = body.recordUsage === false ? [] : await runtime.store.recordMemoryCitations(ids);
    return sendJson(response, 200, { ids, records });
  }
  if (method === "POST" && path === "/api/memory/extract") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const candidates = extractMemoryCandidates({
      text: required(body.text, "text"),
      source: body.source ?? "RetrospectiveExtraction",
      workspaceId: workspaceRecord.id,
      sessionId: body.sessionId,
      tags: body.tags
    });
    if (body.persist === true) {
      for (const record of candidates) await runtime.store.appendMemoryRecord(record);
    }
    return sendJson(response, 200, { candidates, persisted: body.persist === true ? candidates.length : 0 });
  }
  if (method === "POST" && path === "/api/memory/maintain") {
    const result = await runtime.store.maintainMemory(await readJson(request));
    return sendJson(response, 200, result);
  }
  if (method === "GET" && path === "/api/messaging/status") {
    const preferences = rpcPreferences(await runtime.store.readPreferences());
    return sendJson(response, 200, messagingPlatformStatus(preferences, url.searchParams.get("platform")));
  }
  if (method === "GET" && path === "/api/messaging/events") {
    const preferences = rpcPreferences(await runtime.store.readPreferences());
    return sendJson(response, 200, preferences.messagingEvents ?? []);
  }
  if (method === "POST" && path === "/api/messaging/inbound") {
    return sendJson(response, 202, await recordMessagingInbound({ store: runtime.store, runtime, input: await readJson(request) }));
  }
  if (method === "GET" && path === "/api/knowledge/collections") {
    return sendJson(response, 200, await runtime.store.listKnowledgeCollections());
  }
  if (method === "POST" && path === "/api/knowledge/collections") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const collection = createKnowledgeCollection({
      workspaceId: workspaceRecord.id,
      name: required(body.name, "name"),
      root: required(body.root, "root"),
      type: body.type,
      semanticEnabled: body.semanticEnabled
    });
    await runtime.store.saveKnowledgeCollection(collection);
    events.emit("knowledge.collection.created", { collection });
    return sendJson(response, 201, collection);
  }
  if (method === "PATCH" && path.startsWith("/api/knowledge/collections/")) {
    const collectionId = path.slice("/api/knowledge/collections/".length);
    const collection = updateKnowledgeCollection(await runtime.store.getKnowledgeCollection(collectionId), await readJson(request));
    await runtime.store.saveKnowledgeCollection(collection);
    return sendJson(response, 200, collection);
  }
  if (method === "DELETE" && path.startsWith("/api/knowledge/collections/")) {
    const collectionId = path.slice("/api/knowledge/collections/".length);
    const collection = await runtime.store.getKnowledgeCollection(collectionId);
    await runtime.store.deleteKnowledgeCollection(collectionId);
    return sendJson(response, 200, collection);
  }
  if (method === "GET" && path === "/api/knowledge/documents") {
    return sendJson(response, 200, await runtime.store.listKnowledgeDocuments({ collectionId: url.searchParams.get("collectionId") }));
  }
  if (method === "POST" && path === "/api/knowledge/index") {
    const body = await readJson(request);
    const collections = await runtime.store.listKnowledgeCollections();
    const collection = collections.find((item) => item.id === required(body.collectionId, "collectionId"));
    if (!collection) return sendJson(response, 404, { error: { message: "Knowledge collection not found", code: "not_found" } });
    const workspaceRecord = await runtime.store.getWorkspace();
    const result = await indexKnowledgeCollection({ collection, workspaceId: workspaceRecord.id });
    await runtime.store.saveKnowledgeDocuments(collection.id, result.documents);
    if (collection.semanticEnabled === true || body.semantic === true) {
      result.report.semanticJob = await runtime.store.createKnowledgeSemanticJob({
        collectionId: collection.id,
        model: body.model,
        cacheDir: body.cacheDir
      });
    }
    events.emit("knowledge.indexed", { collection, report: result.report });
    return sendJson(response, 200, result.report);
  }
  if (method === "GET" && path === "/api/knowledge/search") {
    const filter = {
      query: url.searchParams.get("q") ?? "",
      collectionId: url.searchParams.get("collectionId"),
      limit: Number(url.searchParams.get("limit") ?? 10)
    };
    return sendJson(response, 200, url.searchParams.get("semantic") === "true"
      ? await runtime.store.searchKnowledgeSemantic(filter)
      : await runtime.store.searchKnowledge(filter));
  }
  if (method === "GET" && path === "/api/knowledge/report") {
    return sendJson(response, 200, await runtime.store.getKnowledgeReport());
  }
  if (method === "GET" && path === "/api/knowledge/inspect") {
    return sendJson(response, 200, await runtime.store.inspectKnowledge());
  }
  if (method === "POST" && path === "/api/knowledge/repair") {
    const workspaceRecord = await runtime.store.getWorkspace();
    return sendJson(response, 200, await runtime.store.repairKnowledge({ workspaceId: workspaceRecord.id }));
  }
  if (method === "GET" && path === "/api/knowledge/semantic") {
    return sendJson(response, 200, {
      state: await runtime.store.getKnowledgeSemanticState(),
      semanticEngine: (await runtime.store.getKnowledgeReport()).semanticEngine
    });
  }
  if (method === "PATCH" && path === "/api/knowledge/semantic") {
    const state = await runtime.store.configureKnowledgeSemanticState(await readJson(request));
    return sendJson(response, 200, { state, semanticEngine: (await runtime.store.getKnowledgeReport()).semanticEngine });
  }
  if (method === "POST" && path === "/api/knowledge/semantic/jobs") {
    const body = await readJson(request);
    const result = await runtime.store.createKnowledgeSemanticJob({
      collectionId: body.collectionId,
      model: body.model,
      cacheDir: body.cacheDir
    });
    events.emit("knowledge.semantic.job", result);
    return sendJson(response, 202, result);
  }
  if (method === "POST" && path === "/api/git/status/parse") {
    const body = await readJson(request);
    const entries = parseGitStatusPorcelain(required(body.text, "text"));
    return sendJson(response, 200, { entries, summary: summarizeGitStatus(entries) });
  }
  if (method === "POST" && path === "/api/git/log/parse") {
    const body = await readJson(request);
    return sendJson(response, 200, { commits: parseGitLog(required(body.text, "text")), prettyFormat: gitLogPrettyFormat() });
  }
  if (method === "GET" && path === "/api/terminal/history") {
    return sendJson(response, 200, await runtime.store.listTerminalHistory({
      query: url.searchParams.get("q"),
      exitCode: url.searchParams.get("exitCode")
    }));
  }
  if (method === "GET" && path === "/api/terminal/sessions") {
    return sendJson(response, 200, await runtime.store.listTerminalSessions({ status: url.searchParams.get("status") }));
  }
  if (method === "POST" && path === "/api/terminal/sessions") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const session = createTerminalSession({
      workspaceId: workspaceRecord.id,
      name: body.name,
      cwd: body.cwd ?? workspace,
      shell: body.shell ?? process.env.SHELL ?? null,
      dimensions: body.dimensions
    });
    await runtime.store.saveTerminalSession(session);
    events.emit("terminal.session.created", { session });
    return sendJson(response, 201, session);
  }
  if (method === "POST" && path === "/api/terminal/run") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const record = await executeTerminalCommand({
      workspaceId: workspaceRecord.id,
      sessionId: body.sessionId,
      command: required(body.command, "command"),
      cwd: body.cwd ?? workspace,
      shell: body.shell ?? process.env.SHELL ?? true,
      env: body.env,
      timeoutMs: body.timeoutMs,
      dimensions: body.dimensions,
      saveRecord: (recordToSave) => runtime.store.saveTerminalRecord(recordToSave),
      onEvent: (event, recordToEmit) => events.emit("terminal.event", { record: recordToEmit, event })
    });
    if (body.sessionId) await runtime.store.attachTerminalRecordToSession(body.sessionId, record.id);
    events.emit("terminal.finished", { record });
    return sendJson(response, 201, record);
  }
  if (method === "POST" && path === "/api/terminal/start") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const record = await terminalProcesses.start({
      workspaceId: workspaceRecord.id,
      sessionId: body.sessionId,
      command: required(body.command, "command"),
      cwd: body.cwd ?? workspace,
      shell: body.shell ?? process.env.SHELL ?? true,
      env: body.env,
      timeoutMs: body.timeoutMs,
      dimensions: body.dimensions
    });
    if (body.sessionId) await runtime.store.attachTerminalRecordToSession(body.sessionId, record.id);
    events.emit("terminal.recorded", { record });
    return sendJson(response, 201, record);
  }
  if (method === "GET" && path.startsWith("/api/terminal/sessions/")) {
    return sendJson(response, 200, await runtime.store.getTerminalSession(path.slice("/api/terminal/sessions/".length)));
  }
  if (method === "POST" && path.startsWith("/api/terminal/sessions/") && path.endsWith("/attach")) {
    const sessionId = path.slice("/api/terminal/sessions/".length, -"/attach".length);
    const body = await readJson(request);
    const result = await runtime.store.attachTerminalRecordToSession(sessionId, required(body.recordId, "recordId"));
    events.emit("terminal.session.attached", result);
    return sendJson(response, 200, result);
  }
  if (method === "POST" && path.startsWith("/api/terminal/sessions/") && path.endsWith("/close")) {
    const sessionId = path.slice("/api/terminal/sessions/".length, -"/close".length);
    const session = await runtime.store.closeTerminalSession(sessionId);
    events.emit("terminal.session.closed", { session });
    return sendJson(response, 200, session);
  }
  if (method === "POST" && path.startsWith("/api/terminal/history/") && path.endsWith("/cancel")) {
    const recordId = path.slice("/api/terminal/history/".length, -"/cancel".length);
    const record = await terminalProcesses.cancel(recordId, await readJson(request));
    events.emit("terminal.cancelled", { record });
    return sendJson(response, 200, record);
  }
  if (method === "POST" && path.startsWith("/api/terminal/history/") && path.endsWith("/input")) {
    const recordId = path.slice("/api/terminal/history/".length, -"/input".length);
    const record = await terminalProcesses.write(recordId, await readJson(request));
    events.emit("terminal.input", { record, event: record.events.at(-1) });
    return sendJson(response, 200, record);
  }
  if (method === "POST" && path.startsWith("/api/terminal/history/") && path.endsWith("/resize")) {
    const recordId = path.slice("/api/terminal/history/".length, -"/resize".length);
    const record = await terminalProcesses.resize(recordId, await readJson(request));
    events.emit("terminal.resize", { record, event: record.events.at(-1) });
    return sendJson(response, 200, record);
  }
  if (method === "GET" && path.startsWith("/api/terminal/history/") && path.endsWith("/process")) {
    const recordId = path.slice("/api/terminal/history/".length, -"/process".length);
    return sendJson(response, 200, terminalProcesses.status(recordId));
  }
  if (method === "GET" && path.startsWith("/api/terminal/history/") && path.endsWith("/replay")) {
    const recordId = path.slice("/api/terminal/history/".length, -"/replay".length);
    return sendJson(response, 200, replayTerminalRecord(await runtime.store.getTerminalRecord(recordId)));
  }
  if (method === "GET" && path.startsWith("/api/terminal/history/")) {
    const recordId = path.slice("/api/terminal/history/".length);
    return sendJson(response, 200, await runtime.store.getTerminalRecord(recordId));
  }
  if (method === "POST" && path === "/api/terminal/history") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const record = createTerminalRecord({
      workspaceId: workspaceRecord.id,
      sessionId: body.sessionId,
      command: required(body.command, "command"),
      cwd: body.cwd ?? workspace,
      exitCode: body.exitCode,
      output: body.output,
      startedAt: body.startedAt,
      endedAt: body.endedAt
    });
    await runtime.store.saveTerminalRecord(record);
    if (body.sessionId) await runtime.store.attachTerminalRecordToSession(body.sessionId, record.id);
    events.emit("terminal.recorded", { record });
    return sendJson(response, 201, record);
  }
  if (method === "POST" && path.startsWith("/api/terminal/history/") && path.endsWith("/events")) {
    const recordId = path.slice("/api/terminal/history/".length, -"/events".length);
    const body = await readJson(request);
    const record = recordTerminalChunk(await runtime.store.getTerminalRecord(recordId), {
      stream: body.stream,
      data: required(body.data, "data"),
      createdAt: body.createdAt
    });
    await runtime.store.saveTerminalRecord(record);
    events.emit("terminal.event", { record, event: record.events.at(-1) });
    return sendJson(response, 200, record);
  }
  if (method === "POST" && path.startsWith("/api/terminal/history/") && path.endsWith("/finish")) {
    const recordId = path.slice("/api/terminal/history/".length, -"/finish".length);
    const body = await readJson(request);
    const record = finishTerminalRecord(await runtime.store.getTerminalRecord(recordId), {
      exitCode: body.exitCode,
      endedAt: body.endedAt
    });
    await runtime.store.saveTerminalRecord(record);
    events.emit("terminal.finished", { record });
    return sendJson(response, 200, record);
  }
  if (method === "GET" && path === "/api/tool-icons") {
    const command = url.searchParams.get("command");
    return sendJson(response, 200, command ? resolveToolIcon(command) : listToolIcons());
  }
  if (method === "GET" && path === "/api/resources") return sendJson(response, 200, resourceManifest());
  if (method === "GET" && path === "/api/audit/bundle") {
    return sendJson(response, 200, auditPengBundle({
      appPath: url.searchParams.get("appPath") ?? undefined,
      workspace,
      resourceDir: url.searchParams.get("resourceDir") ?? undefined
    }));
  }
  if (method === "GET" && path === "/api/helpers") return sendJson(response, 200, listHelpers());
  if (method === "GET" && path === "/api/helpers/smoke-profiles") return sendJson(response, 200, listHelperSmokeProfiles());
  if (method === "GET" && path === "/api/helpers/behavior-profiles") return sendJson(response, 200, listHelperBehaviorProfiles());
  if (method === "POST" && path === "/api/helpers/behavior-smoke") {
    const body = await readJson(request);
    return sendJson(response, 200, await runHelperBehaviorProfile({
      profile: body.profile ?? "ical-basic",
      cwd: body.cwd ?? workspace,
      resourceDir: body.resourceDir,
      timeoutMs: body.timeoutMs ?? 60000,
      env: body.env,
      keepTemp: body.keepTemp === true
    }));
  }
  if (method === "POST" && path === "/api/helpers/smoke") {
    const body = await readJson(request);
    return sendJson(response, 200, await smokeHelpers({
      names: body.names,
      args: body.args,
      profile: body.profile,
      cwd: body.cwd ?? workspace,
      resourceDir: body.resourceDir,
      timeoutMs: body.timeoutMs ?? 30000,
      skip: body.skip ?? ["craft-agent"],
      env: body.env
    }));
  }
  if (method === "POST" && path.startsWith("/api/helpers/") && path.endsWith("/plan")) {
    const name = decodeURIComponent(path.slice("/api/helpers/".length, -"/plan".length));
    const body = await readJson(request);
    return sendJson(response, 200, planHelperCommand({
      name,
      args: body.args,
      cwd: body.cwd ?? workspace,
      resourceDir: body.resourceDir
    }));
  }
  if (method === "POST" && path.startsWith("/api/helpers/") && path.endsWith("/run")) {
    const name = decodeURIComponent(path.slice("/api/helpers/".length, -"/run".length));
    const body = await readJson(request);
    return sendJson(response, 200, await runHelperCommand({
      name,
      args: body.args,
      cwd: body.cwd ?? workspace,
      resourceDir: body.resourceDir,
      timeoutMs: body.timeoutMs ?? 30000,
      env: body.env
    }));
  }

  if (method === "POST" && path === "/api/run") {
    const body = await readJson(request);
    const result = await runtime.runTask({
      prompt: required(body.prompt, "prompt"),
      threadId: body.threadId,
      memoryContext: body.memoryContext,
      includeMemory: body.includeMemory === true,
      onEvent: (event) => emitProtocol(events, event)
    });
    events.emit("thread.completed", { thread: result.thread, output: result.output });
    return sendJson(response, 201, result);
  }

  if (method === "GET" && path === "/api/threads") return sendJson(response, 200, await runtime.listThreads());
  if (method === "GET" && path === "/api/queued-messages") {
    return sendJson(response, 200, await runtime.store.listQueuedMessages({
      threadId: url.searchParams.get("threadId"),
      status: url.searchParams.get("status")
    }));
  }
  if (method === "GET" && path === "/api/run-control") {
    return sendJson(response, 200, await runtime.listRunControls({
      status: url.searchParams.get("status")
    }));
  }
  if (method === "POST" && path === "/api/run-control/watchdog") {
    const body = await readJson(request);
    return sendJson(response, 200, await runtime.inspectWatchdog({
      staleAfterMs: Number(body.staleAfterMs ?? 30000),
      onEvent: (event) => emitProtocol(events, event)
    }));
  }
  const queueMessageMatch = path.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (method === "POST" && queueMessageMatch) {
    const threadId = decodeURIComponent(queueMessageMatch[1]);
    const body = await readJson(request);
    const message = await runtime.queueThreadMessage({
      threadId,
      content: required(body.content ?? body.prompt, "content"),
      source: body.source ?? "client",
      onEvent: (event) => emitProtocol(events, event)
    });
    events.emit("thread.message.queued", { message });
    return sendJson(response, 202, message);
  }
  const replayQueueMatch = path.match(/^\/api\/threads\/([^/]+)\/replay-queue$/);
  if (method === "POST" && replayQueueMatch) {
    const threadId = decodeURIComponent(replayQueueMatch[1]);
    const replayed = await runtime.replayQueuedMessages({
      threadId,
      onEvent: (event) => emitProtocol(events, event)
    });
    events.emit("thread.queue.replayed", { threadId, replayed });
    return sendJson(response, 200, { threadId, replayed });
  }
  const stopRunMatch = path.match(/^\/api\/threads\/([^/]+)\/stop$/);
  if (method === "POST" && stopRunMatch) {
    const threadId = decodeURIComponent(stopRunMatch[1]);
    const body = await readJson(request);
    const control = await runtime.requestStop({
      threadId,
      reason: body.reason ?? "user_requested",
      onEvent: (event) => emitProtocol(events, event)
    });
    events.emit("thread.stop.requested", { threadId, control });
    return sendJson(response, 202, control);
  }
  const resumeRunMatch = path.match(/^\/api\/threads\/([^/]+)\/resume$/);
  if (method === "POST" && resumeRunMatch) {
    const threadId = decodeURIComponent(resumeRunMatch[1]);
    const body = await readJson(request);
    const result = await runtime.resumeThread({
      threadId,
      prompt: body.prompt,
      onEvent: (event) => emitProtocol(events, event)
    });
    events.emit("thread.resumed", { thread: result.thread, output: result.output });
    return sendJson(response, 201, result);
  }
  if (method === "GET" && path.startsWith("/api/threads/")) {
    return sendJson(response, 200, await runtime.getThread(path.slice("/api/threads/".length)));
  }

  if (method === "GET" && path === "/api/statuses") return sendJson(response, 200, await runtime.store.getStatusConfig());
  if (method === "GET" && path === "/api/statuses/validate") {
    return sendJson(response, 200, validateStatusConfig(await runtime.store.getStatusConfig()));
  }
  if (method === "POST" && path === "/api/statuses") {
    const body = await readJson(request);
    const config = createStatus(await runtime.store.getStatusConfig(), body);
    await runtime.store.saveStatusConfig(config);
    events.emit("status.created", { status: config.statuses.find((status) => status.id === body.id || status.label === body.label), config });
    return sendJson(response, 201, config);
  }
  if (method === "PATCH" && path === "/api/statuses/default") {
    const body = await readJson(request);
    const config = setDefaultStatus(await runtime.store.getStatusConfig(), required(body.statusId, "statusId"));
    await runtime.store.saveStatusConfig(config);
    events.emit("status.default.changed", { statusId: config.defaultStatusId, config });
    return sendJson(response, 200, config);
  }
  if (method === "PATCH" && path.startsWith("/api/statuses/")) {
    const statusId = path.slice("/api/statuses/".length);
    const body = await readJson(request);
    const config = updateStatus(await runtime.store.getStatusConfig(), statusId, body);
    await runtime.store.saveStatusConfig(config);
    events.emit("status.updated", { statusId, config });
    return sendJson(response, 200, config);
  }
  if (method === "DELETE" && path.startsWith("/api/statuses/")) {
    const statusId = path.slice("/api/statuses/".length);
    const body = await readJson(request);
    const deleted = deleteStatus(await runtime.store.getStatusConfig(), statusId, { replacementStatusId: body.replacementStatusId });
    await runtime.store.saveStatusConfig(deleted.config);
    const migrated = await migrateStatusReferences(runtime.store, statusId, deleted.replacementStatusId);
    events.emit("status.deleted", { statusId, replacementStatusId: deleted.replacementStatusId, migrated });
    return sendJson(response, 200, { config: deleted.config, replacementStatusId: deleted.replacementStatusId, migrated });
  }
  if (method === "GET" && path === "/api/labels") {
    const config = await runtime.store.getLabelConfig();
    const filter = {
      query: url.searchParams.get("q"),
      valueType: url.searchParams.get("valueType"),
      parentId: url.searchParams.has("parentId") ? url.searchParams.get("parentId") || null : undefined
    };
    return sendJson(response, 200, { config, labels: filterLabels(config, filter) });
  }
  if (method === "GET" && path === "/api/labels/validate") {
    return sendJson(response, 200, validateLabelConfig(await runtime.store.getLabelConfig()));
  }
  if (method === "POST" && path === "/api/labels") {
    const body = await readJson(request);
    const config = createLabel(await runtime.store.getLabelConfig(), body);
    await runtime.store.saveLabelConfig(config);
    events.emit("label.created", { labelId: body.id, config });
    return sendJson(response, 201, { config, labels: flattenLabels(config) });
  }
  if (method === "PATCH" && path.startsWith("/api/labels/")) {
    const labelId = path.slice("/api/labels/".length);
    const body = await readJson(request);
    const config = updateLabel(await runtime.store.getLabelConfig(), labelId, body);
    await runtime.store.saveLabelConfig(config);
    const migrated = body.id && body.id !== labelId ? await renameLabelReferences(runtime.store, labelId, body.id) : { sessions: 0, tasks: 0 };
    events.emit("label.updated", { labelId, nextId: body.id ?? labelId, migrated, config });
    return sendJson(response, 200, { config, labels: flattenLabels(config), migrated });
  }
  if (method === "DELETE" && path.startsWith("/api/labels/")) {
    const labelId = path.slice("/api/labels/".length);
    const deleted = deleteLabel(await runtime.store.getLabelConfig(), labelId);
    await runtime.store.saveLabelConfig(deleted.config);
    const migrated = await removeLabelReferences(runtime.store, deleted.removed);
    events.emit("label.deleted", { labelId, removed: deleted.removed, migrated });
    return sendJson(response, 200, { ...deleted, labels: flattenLabels(deleted.config), migrated });
  }

  if (method === "GET" && path === "/api/sessions") return sendJson(response, 200, await runtime.store.listSessions());
  if (method === "POST" && path === "/api/sessions") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const session = createSession({
      workspaceId: workspaceRecord.id,
      projectId: body.projectId,
      name: body.name,
      prompt: required(body.prompt, "prompt"),
      permissionMode: body.permissionMode,
      statusId: body.statusId,
      labels: body.labels,
      labelConfig: await runtime.store.getLabelConfig(),
      statusConfig: await runtime.store.getStatusConfig()
    });
    await runtime.store.saveSession(session);
    events.emit("session.created", { session });
    return sendJson(response, 201, session);
  }
  if (method === "GET" && path.startsWith("/api/sessions/")) {
    return sendJson(response, 200, await runtime.store.getSession(path.slice("/api/sessions/".length)));
  }
  if (method === "PATCH" && path.endsWith("/status") && path.startsWith("/api/sessions/")) {
    const sessionId = path.slice("/api/sessions/".length, -"/status".length);
    const body = await readJson(request);
    const current = await runtime.store.getSession(sessionId);
    const { session, event } = updateSessionStatus(current, required(body.statusId, "statusId"), await runtime.store.getStatusConfig());
    await runtime.store.saveSession(session);
    await runtime.store.appendDomainEvent(event);
    events.emit("session.status.changed", { session, event });
    return sendJson(response, 200, { session, event });
  }

  if (method === "GET" && path === "/api/projects") return sendJson(response, 200, await runtime.store.listProjects());
  if (method === "POST" && path === "/api/projects") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const project = createProject({
      workspaceId: workspaceRecord.id,
      name: required(body.name, "name"),
      root: body.root ?? workspace
    });
    await runtime.store.saveProject(project);
    events.emit("project.created", { project });
    return sendJson(response, 201, project);
  }
  if (method === "GET" && path.startsWith("/api/projects/")) {
    return sendJson(response, 200, await runtime.store.getProject(path.slice("/api/projects/".length)));
  }
  if (method === "PATCH" && path.startsWith("/api/projects/")) {
    const projectId = path.slice("/api/projects/".length);
    const project = updateProject(await runtime.store.getProject(projectId), await readJson(request));
    await runtime.store.saveProject(project);
    events.emit("project.updated", { project });
    return sendJson(response, 200, project);
  }
  if (method === "DELETE" && path.startsWith("/api/projects/")) {
    const projectId = path.slice("/api/projects/".length);
    const project = await runtime.store.getProject(projectId);
    await runtime.store.deleteProject(projectId);
    const detached = await detachProjectReferences(runtime.store, projectId);
    events.emit("project.deleted", { projectId, detached });
    return sendJson(response, 200, { project, detached });
  }

  if (method === "GET" && path === "/api/tasks") {
    const tasks = await runtime.store.listTasks({
      projectId: url.searchParams.get("projectId"),
      sessionId: url.searchParams.get("sessionId"),
      statusId: url.searchParams.get("statusId"),
      label: url.searchParams.get("label"),
      query: url.searchParams.get("q"),
      sort: url.searchParams.get("sort")
    });
    return sendJson(response, 200, tasks);
  }
  if (method === "POST" && path === "/api/tasks") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const task = createTask({
      workspaceId: workspaceRecord.id,
      projectId: body.projectId,
      sessionId: body.sessionId,
      title: required(body.title, "title"),
      description: body.description,
      labels: body.labels,
      dueDate: body.dueDate,
      statusId: body.statusId,
      statusConfig: await runtime.store.getStatusConfig()
    });
    await runtime.store.saveTask(task);
    events.emit("task.created", { task });
    return sendJson(response, 201, task);
  }
  if (method === "GET" && path.startsWith("/api/tasks/")) {
    return sendJson(response, 200, await runtime.store.getTask(path.slice("/api/tasks/".length)));
  }
  if (method === "PATCH" && path.endsWith("/status") && path.startsWith("/api/tasks/")) {
    const taskId = path.slice("/api/tasks/".length, -"/status".length);
    const body = await readJson(request);
    const task = updateTaskStatus(await runtime.store.getTask(taskId), required(body.statusId, "statusId"), await runtime.store.getStatusConfig());
    await runtime.store.saveTask(task);
    events.emit("task.status.changed", { task });
    return sendJson(response, 200, task);
  }
  if (method === "PATCH" && path.startsWith("/api/tasks/")) {
    const taskId = path.slice("/api/tasks/".length);
    const body = await readJson(request);
    const task = updateTask(await runtime.store.getTask(taskId), body, await runtime.store.getStatusConfig());
    await runtime.store.saveTask(task);
    events.emit("task.updated", { task });
    return sendJson(response, 200, task);
  }
  if (method === "DELETE" && path.startsWith("/api/tasks/")) {
    const taskId = path.slice("/api/tasks/".length);
    const task = await runtime.store.getTask(taskId);
    await runtime.store.deleteTask(taskId);
    events.emit("task.deleted", { taskId });
    return sendJson(response, 200, task);
  }

  if (method === "GET" && path === "/api/views") return sendJson(response, 200, await runtime.store.listViews({ entity: url.searchParams.get("entity") }));
  if (method === "POST" && path === "/api/views") {
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const view = createView({
      workspaceId: workspaceRecord.id,
      name: required(body.name, "name"),
      entity: body.entity,
      filters: body.filters,
      sort: body.sort
    });
    await runtime.store.saveView(view);
    return sendJson(response, 201, view);
  }
  if (method === "GET" && path.startsWith("/api/views/")) {
    const view = await runtime.store.getView(path.slice("/api/views/".length));
    const source = await viewSource(runtime.store, view.entity);
    return sendJson(response, 200, { view, items: applyView(source, view) });
  }
  if (method === "PATCH" && path.startsWith("/api/views/")) {
    const viewId = path.slice("/api/views/".length);
    const view = updateView(await runtime.store.getView(viewId), await readJson(request));
    await runtime.store.saveView(view);
    return sendJson(response, 200, view);
  }
  if (method === "DELETE" && path.startsWith("/api/views/")) {
    const viewId = path.slice("/api/views/".length);
    const view = await runtime.store.getView(viewId);
    await runtime.store.deleteView(viewId);
    return sendJson(response, 200, view);
  }
  if (method === "POST" && path.endsWith("/labels") && path.startsWith("/api/sessions/")) {
    const sessionId = path.slice("/api/sessions/".length, -"/labels".length);
    const body = await readJson(request);
    const current = await runtime.store.getSession(sessionId);
    const { session, event } = addSessionLabel(current, required(body.label, "label"));
    await runtime.store.saveSession(session);
    if (event) await runtime.store.appendDomainEvent(event);
    events.emit("session.label.added", { session, event });
    return sendJson(response, 200, { session, event });
  }

  if (method === "GET" && path === "/api/skills") return sendJson(response, 200, await discoverSkills({ workspace }));
  if (method === "GET" && path === "/api/workflows") return sendJson(response, 200, await discoverWorkflows({ workspace }));
  if (method === "GET" && path === "/api/sources") {
    const workspaceRecord = await runtime.store.getWorkspace();
    return sendJson(response, 200, await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store }));
  }
  if (method === "GET" && path === "/api/sources/validate") {
    const workspaceRecord = await runtime.store.getWorkspace();
    const sources = await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store });
    const issues = sources.flatMap((source) => source.validation.issues.map((issue) => `${source.slug}: ${issue}`));
    return sendJson(response, 200, { ok: issues.length === 0, issues });
  }
  if (method === "GET" && path.startsWith("/api/sources/") && path.endsWith("/auth-help")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/auth-help".length);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, credentialPromptSpec(source));
  }
  if (method === "GET" && path.startsWith("/api/sources/") && path.endsWith("/auth-state")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/auth-state".length);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, sourceAuthState(source, await runtime.store.getCredential(source.slug)));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/credentials")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/credentials".length);
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    const record = await runtime.store.saveCredential(credentialFromPromptInput(source, body));
    events.emit("credential.saved", { credential: summarizeCredential(record) });
    return sendJson(response, 201, summarizeCredential(record));
  }
  if (method === "GET" && path.startsWith("/api/sources/") && path.endsWith("/runtime-signature")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/runtime-signature".length);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, await getSourceRuntimeSignature({ source, store: runtime.store }));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/apply-api-auth")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/apply-api-auth".length);
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, applyApiAuth({ url: required(body.url, "url"), headers: body.headers, source, credential: await runtime.store.getCredential(source.slug) }));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/test")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/test".length);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    const result = await testSource({ source, store: runtime.store });
    events.emit("source.tested", result);
    return sendJson(response, 200, result);
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/icon")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/icon".length);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    const result = await cacheSourceIcon({ source });
    events.emit("source.icon.cached", { sourceSlug, ...result });
    return sendJson(response, 200, result);
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/request")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/request".length);
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, await executeApiSourceRequest({
      source,
      endpointPath: required(body.path, "path"),
      method: body.method,
      body: body.body,
      headers: body.headers,
      store: runtime.store
    }));
  }
  if (method === "GET" && path.startsWith("/api/sources/") && path.endsWith("/mcp-tools")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/mcp-tools".length);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, await listMcpSourceTools({ source, store: runtime.store }));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/mcp-call")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/mcp-call".length);
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, await callMcpSourceTool({
      source,
      name: required(body.name, "name"),
      arguments: body.arguments,
      store: runtime.store
    }));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/oauth/authorize")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/oauth/authorize".length);
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, createSourceOAuthAuthorizationRequest({
      source,
      state: body.state,
      generateState: body.generateState,
      pkce: body.pkce,
      codeChallenge: body.codeChallenge,
      codeVerifier: body.codeVerifier,
      redirectUri: body.redirectUri
    }));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/oauth/device")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/oauth/device".length);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, await startSourceOAuthDeviceFlow({ source }));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/oauth/exchange")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/oauth/exchange".length);
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    const credential = body.deviceCode
      ? await exchangeSourceOAuthDeviceCode({ source, deviceCode: body.deviceCode, store: runtime.store })
      : await exchangeSourceOAuthCode({ source, code: required(body.code, "code"), codeVerifier: body.codeVerifier, redirectUri: body.redirectUri, store: runtime.store });
    return sendJson(response, 200, summarizeCredential(credential));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/oauth/poll-device")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/oauth/poll-device".length);
    const body = await readJson(request);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, summarizeCredential(await pollSourceOAuthDeviceCode({
      source,
      deviceCode: required(body.deviceCode, "deviceCode"),
      intervalSecs: body.intervalSecs,
      expiresIn: body.expiresIn,
      maxAttempts: body.maxAttempts,
      store: runtime.store
    })));
  }
  if (method === "POST" && path.startsWith("/api/sources/") && path.endsWith("/oauth/refresh")) {
    const sourceSlug = path.slice("/api/sources/".length, -"/oauth/refresh".length);
    const workspaceRecord = await runtime.store.getWorkspace();
    const source = (await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store })).find((item) => item.slug === sourceSlug);
    if (!source) return sendJson(response, 404, { error: { message: "Source not found", code: "not_found" } });
    return sendJson(response, 200, summarizeCredential(await refreshSourceOAuthCredential({ source, store: runtime.store })));
  }
  if (method === "GET" && path === "/api/credentials") {
    return sendJson(response, 200, await runtime.store.listCredentialSummaries());
  }
  if (method === "GET" && path === "/api/credentials/storage") {
    return sendJson(response, 200, runtime.store.credentialStorageInfo());
  }
  if (method === "POST" && path === "/api/credentials") {
    const body = await readJson(request);
    const record = await runtime.store.saveCredential(createCredentialRecord({
      sourceSlug: required(body.sourceSlug, "sourceSlug"),
      provider: body.provider,
      mode: required(body.mode, "mode"),
      value: required(body.value, "value"),
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt
    }));
    events.emit("credential.saved", { credential: summarizeCredential(record) });
    return sendJson(response, 201, summarizeCredential(record));
  }

  if (method === "GET" && path === "/api/automations/validate") {
    return sendJson(response, 200, validateAutomationConfig(await runtime.store.getAutomationConfig()));
  }
  if (method === "GET" && path === "/api/automations/lint") {
    return sendJson(response, 200, lintAutomationConfig(await runtime.store.getAutomationConfig()));
  }
  if (method === "POST" && path === "/api/automations/test") {
    const body = await readJson(request);
    const result = await runAutomations({ config: await runtime.store.getAutomationConfig(), event: body.event ?? body, store: runtime.store });
    events.emit("automation.ran", result.history);
    return sendJson(response, 200, result);
  }
  if (method === "POST" && path === "/api/automations/run") {
    const body = await readJson(request);
    const result = await runAutomations({
      config: await runtime.store.getAutomationConfig(),
      event: body.event ?? body,
      store: runtime.store,
      executeWebhooks: body.executeWebhooks === true
    });
    events.emit("automation.ran", result.history);
    return sendJson(response, 200, result);
  }
  if (method === "GET" && path === "/api/automations/history") {
    return sendJson(response, 200, await runtime.store.listAutomationHistory());
  }
  if (method === "GET" && path === "/api/automations/scheduler") {
    return sendJson(response, 200, automationScheduler.status());
  }
  if (method === "POST" && path === "/api/automations/scheduler/tick") {
    const body = await readJson(request);
    const now = body.now ? new Date(body.now) : new Date();
    const result = body.useBackgroundScheduler === true
      ? await automationScheduler.tick({ now })
      : await runAutomationSchedulerTick({
        store: runtime.store,
        now,
        executeWebhooks: body.executeWebhooks === true
      });
    events.emit("automation.scheduler.tick", result.history);
    events.emit("automation.ran", result.history);
    return sendJson(response, 200, result);
  }
  if (method === "POST" && path === "/api/automations/scheduler/start") {
    const body = await readJson(request);
    if (body.intervalMs) {
      const intervalMs = Math.trunc(Number(body.intervalMs));
      if (Number.isFinite(intervalMs)) automationScheduler.intervalMs = Math.max(1000, intervalMs);
    }
    if (body.executeWebhooks !== undefined) automationScheduler.executeWebhooks = body.executeWebhooks === true;
    const status = automationScheduler.start({ immediate: body.immediate === true });
    events.emit("automation.scheduler.started", status);
    return sendJson(response, 202, status);
  }
  if (method === "POST" && path === "/api/automations/scheduler/stop") {
    const status = automationScheduler.stop();
    events.emit("automation.scheduler.stopped", status);
    return sendJson(response, 200, status);
  }

  if (method === "POST" && path === "/api/permissions/evaluate") {
    return sendJson(response, 200, evaluatePermission(await readJson(request)));
  }
  if (method === "GET" && path === "/api/permissions/validate") {
    return sendJson(response, 200, validatePermissionRules(DEFAULT_PERMISSION_RULES));
  }

  sendJson(response, 404, { error: { message: `No route for ${method} ${path}`, code: "not_found" } });
}

function emitProtocol(events, event) {
  events.emit("protocol.event", event);
  events.emit(event.type, event);
}

async function serveStatic(response, requestPath) {
  const webRoot = staticWebRoot();
  const relativePath = requestPath === "/" ? "index.html" : requestPath === "/login" ? "login.html" : requestPath.slice(1);
  const filePath = pathModule.resolve(webRoot, relativePath);
  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${pathModule.sep}`)) {
    return sendJson(response, 403, { error: { message: "Static path escapes web root", code: "forbidden" } });
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      ...corsHeaders()
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: { message: "Static file not found", code: "not_found" } });
      return;
    }
    throw error;
  }
}

async function serveResource(response, requestPath) {
  const resource = resolveResource(requestPath);
  if (!resource) return sendJson(response, 404, { error: { message: "Resource not found", code: "not_found" } });
  response.writeHead(200, {
    "content-type": resource.contentType,
    etag: resource.etag,
    ...corsHeaders()
  });
  response.end(resource.body);
}

function isStaticPath(path) {
  return path === "/" ||
    path === "/login" ||
    path === "/index.html" ||
    path === "/login.html" ||
    path === "/manifest.json" ||
    path === "/favicon.ico" ||
    path === "/apple-touch-icon.png" ||
    path === "/icon-192.png" ||
    path === "/app.js" ||
    path === "/styles.css" ||
    path.startsWith("/assets/");
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".woff")) return "font/woff";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

function staticWebRoot() {
  if (process.env.PENG_WEBUI_DIR) return pathModule.resolve(process.env.PENG_WEBUI_DIR);
  const importedWebui = pathModule.join(projectRoot, "resources", "webui");
  return existsSync(pathModule.join(importedWebui, "index.html")) ? importedWebui : pathModule.join(projectRoot, "webui");
}

async function frontendConfig({ request, runtime }) {
  const workspaceRecord = await runtime.store.getWorkspace();
  const urls = requestBaseUrls(request);
  return {
    ...mergeConfig(),
    wsUrl: `${urls.ws}/ws`,
    httpUrl: urls.http,
    webSocketPath: "/ws",
    workspaceId: workspaceRecord.id,
    defaultWorkspaceId: workspaceRecord.id,
    workspace: workspaceClientRecord(workspaceRecord)
  };
}

async function frontendWorkspaceConfig(store) {
  const workspaceRecord = workspaceClientRecord(await store.getWorkspace());
  return {
    defaultWorkspaceId: workspaceRecord.id,
    activeWorkspace: workspaceRecord,
    currentWorkspace: workspaceRecord,
    workspaces: [workspaceRecord]
  };
}

function workspaceClientRecord(workspaceRecord) {
  return {
    ...workspaceRecord,
    path: workspaceRecord.root,
    label: workspaceRecord.name ?? workspaceRecord.id
  };
}

function requestBaseUrls(request) {
  const host = request.headers.host ?? "127.0.0.1";
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  const httpProtocol = forwardedProto === "https" ? "https" : "http";
  return {
    http: `${httpProtocol}://${host}`,
    ws: `${httpProtocol === "https" ? "wss" : "ws"}://${host}`
  };
}

export class EventHub {
  constructor() {
    this.clients = new Set();
    this.webSocketClients = new Set();
  }

  connect(response) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...corsHeaders()
    });
    response.write("event: ready\n");
    response.write(`data: ${JSON.stringify({ ok: true })}\n\n`);
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  connectWebSocket(client) {
    this.webSocketClients.add(client);
    client.send(webSocketEvent("ready", { ok: true }));
    client.onClose = () => this.webSocketClients.delete(client);
  }

  closeWebSockets() {
    for (const client of this.webSocketClients) client.close();
    this.webSocketClients.clear();
  }

  emit(type, payload) {
    for (const client of this.clients) {
      client.write(`event: ${type}\n`);
      client.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    for (const client of this.webSocketClients) {
      client.send(webSocketEvent(type, payload));
    }
  }
}

class WorkspaceWatchManager {
  constructor({ workspace, store, events }) {
    this.workspace = workspace;
    this.store = store;
    this.events = events;
    this.watchers = new Map();
    this.eventsLog = [];
  }

  async watch(input = {}) {
    const paths = this.normalizePaths(input);
    const started = [];
    const failed = [];
    for (const requestedPath of paths) {
      try {
        const absolutePath = resolveInsideWorkspace(this.workspace, requestedPath);
        await stat(absolutePath);
        const key = this.relativePath(absolutePath);
        if (!this.watchers.has(key)) this.watchers.set(key, this.createWatcher(key, absolutePath));
        started.push(key);
      } catch (error) {
        failed.push({ path: requestedPath, code: error.code ?? "watch_failed", message: error.message });
      }
    }
    await this.persistWatchers();
    return {
      ok: failed.length === 0,
      watched: true,
      paths: started,
      failed,
      watchers: this.watchedPaths()
    };
  }

  async unwatch(input = {}) {
    const paths = this.normalizePaths(input, { emptyMeansAll: true });
    for (const requestedPath of paths) {
      const key = requestedPath === "*" ? requestedPath : this.relativePath(resolveInsideWorkspace(this.workspace, requestedPath));
      if (key === "*") {
        for (const watcher of this.watchers.values()) watcher.close();
        this.watchers.clear();
        break;
      }
      const watcher = this.watchers.get(key);
      if (watcher) watcher.close();
      this.watchers.delete(key);
    }
    await this.persistWatchers();
    return {
      ok: true,
      watched: false,
      paths: paths.includes("*") ? [] : paths,
      watchers: this.watchedPaths()
    };
  }

  async recordManualChange(input = {}) {
    const rawPath = input.path ?? input.filePath ?? input.paths?.[0] ?? ".";
    const event = await this.recordChange({
      path: rawPath,
      watchedPath: input.watchedPath ?? null,
      eventType: input.eventType ?? input.type ?? "manual",
      source: "manual"
    });
    return { ok: true, event, events: this.recentEvents() };
  }

  snapshot() {
    return {
      ok: true,
      watched: this.watchers.size > 0,
      watchers: this.watchedPaths(),
      recentEvents: this.recentEvents()
    };
  }

  recentEvents() {
    return [...this.eventsLog];
  }

  close() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  createWatcher(key, absolutePath) {
    const onChange = (eventType, fileName) => {
      const changedPath = fileName ? pathModule.join(key, String(fileName)) : key;
      void this.recordChange({
        path: changedPath,
        watchedPath: key,
        eventType: eventType || "change",
        source: "fs.watch"
      });
    };
    try {
      return watch(absolutePath, { recursive: false }, onChange);
    } catch (error) {
      if (error.code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw error;
      return watch(absolutePath, onChange);
    }
  }

  async recordChange({ path, watchedPath, eventType, source }) {
    const absolutePath = resolveInsideWorkspace(this.workspace, path ?? ".");
    const relativePath = this.relativePath(absolutePath);
    if (relativePath === ".peng" || relativePath.startsWith(`.peng${pathModule.sep}`)) return null;
    const event = {
      id: crypto.randomUUID(),
      type: "workspace.files.changed",
      eventType,
      path: relativePath,
      watchedPath,
      source,
      createdAt: new Date().toISOString()
    };
    this.eventsLog.push(event);
    this.eventsLog = this.eventsLog.slice(-200);
    await this.store.writePreferences({ workspaceFileEvents: this.eventsLog });
    this.events.emit("workspace.files.changed", event);
    this.events.emit("workspace:filesChanged", event);
    return event;
  }

  normalizePaths(input = {}, { emptyMeansAll = false } = {}) {
    if (input == null) return emptyMeansAll ? ["*"] : ["."];
    if (Array.isArray(input)) return input.length ? input.map(String) : (emptyMeansAll ? ["*"] : ["."]);
    if (typeof input !== "object") return [String(input)];
    const rawPaths = input.paths ?? input.filePaths;
    if (Array.isArray(rawPaths)) return rawPaths.length ? rawPaths.map(String) : (emptyMeansAll ? ["*"] : ["."]);
    const single = input.path ?? input.filePath ?? input.root;
    if (single == null) return emptyMeansAll ? ["*"] : ["."];
    return [String(single)];
  }

  relativePath(absolutePath) {
    return pathModule.relative(this.workspace, absolutePath) || ".";
  }

  watchedPaths() {
    return [...this.watchers.keys()].sort();
  }

  async persistWatchers() {
    await this.store.writePreferences({ workspaceFileWatchers: this.watchedPaths() });
  }
}

function handleWebSocketUpgrade({ request, socket, runtime, events, automationScheduler, workspaceWatchers }) {
  const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
  if (stripTrailingSlash(url.pathname) !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (!key || request.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));

  const client = createWebSocketClient({ socket, runtime, events, automationScheduler, workspaceWatchers });
  events.connectWebSocket(client);
}

function createWebSocketClient({ socket, runtime, events, automationScheduler, workspaceWatchers }) {
  let buffer = Buffer.alloc(0);
  const client = {
    rpcClientId: `client_${crypto.randomUUID()}`,
    rpcSeq: 0,
    onClose: null,
    send(message) {
      if (socket.destroyed || !socket.writable) return;
      socket.write(encodeWebSocketFrame(JSON.stringify(message)));
    },
    close() {
      if (!socket.destroyed) socket.destroy();
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeWebSocketFrame(buffer);
      if (!frame) return;
      buffer = buffer.subarray(frame.bytes);
      if (frame.opcode === 0x8) {
        socket.end(encodeWebSocketCloseFrame());
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeWebSocketFrame(frame.payload, { opcode: 0xA }));
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      handleWebSocketMessage({ text: frame.payload.toString("utf8"), client, runtime, events, automationScheduler, workspaceWatchers });
    }
  });
  socket.on("close", () => client.onClose?.());
  socket.on("error", () => client.onClose?.());
  return client;
}

async function handleWebSocketMessage({ text, client, runtime, events, automationScheduler, workspaceWatchers }) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    client.send(webSocketError({ message: "Invalid JSON message.", code: "bad_request" }));
    return;
  }
  if (isCraftRpcEnvelope(raw)) {
    await handleCraftRpcEnvelope({ envelope: raw, client, runtime, events, automationScheduler, workspaceWatchers });
    return;
  }
  let message;
  try {
    message = normalizeWebSocketMessage(raw);
  } catch (error) {
    client.send(webSocketError({ message: error.message, code: error.code ?? "bad_request" }));
    return;
  }
  const id = message.id;
  try {
    if (message.type === "ping") {
      client.send(webSocketResponse({ id, type: "pong", payload: { ok: true } }));
      return;
    }
    if (message.type === "run.start") {
      const payload = message.payload;
      const result = await runtime.runTask({
        prompt: required(payload.prompt, "prompt"),
        threadId: payload.threadId,
        memoryContext: payload.memoryContext,
        includeMemory: payload.includeMemory === true,
        onEvent: (event) => emitProtocol(events, event)
      });
      events.emit("thread.completed", { thread: result.thread, output: result.output });
      client.send(webSocketResponse({ id, type: "run.result", payload: result }));
      return;
    }
    if (message.type === "thread.message") {
      const payload = message.payload;
      const queued = await runtime.queueThreadMessage({
        threadId: required(payload.threadId, "threadId"),
        content: required(payload.content ?? payload.prompt, "content"),
        source: payload.source ?? "websocket",
        onEvent: (event) => emitProtocol(events, event)
      });
      events.emit("thread.message.queued", { message: queued });
      client.send(webSocketResponse({ id, type: "thread.message.result", payload: queued }));
      return;
    }
    if (message.type === "thread.stop") {
      const payload = message.payload;
      const control = await runtime.requestStop({
        threadId: required(payload.threadId, "threadId"),
        reason: payload.reason ?? "websocket_requested",
        onEvent: (event) => emitProtocol(events, event)
      });
      events.emit("thread.stop.requested", { threadId: payload.threadId, control });
      client.send(webSocketResponse({ id, type: "thread.stop.result", payload: control }));
      return;
    }
    if (message.type === "thread.replayQueue") {
      const payload = message.payload;
      const replayed = await runtime.replayQueuedMessages({
        threadId: required(payload.threadId, "threadId"),
        onEvent: (event) => emitProtocol(events, event)
      });
      events.emit("thread.queue.replayed", { threadId: payload.threadId, replayed });
      client.send(webSocketResponse({ id, type: "thread.replayQueue.result", payload: { threadId: payload.threadId, replayed } }));
      return;
    }
    client.send(webSocketError({ id, message: `Unknown WebSocket message type: ${message.type}`, code: "not_found" }));
  } catch (error) {
    client.send(webSocketError({ id, message: error.message, code: error.code ?? "internal_error" }));
  }
}

async function handleCraftRpcEnvelope({ envelope, client, runtime, events, automationScheduler, workspaceWatchers }) {
  try {
    if (envelope.type === "handshake") {
      client.rpcClientId = envelope.reconnectClientId || client.rpcClientId;
      client.send(craftRpcHandshakeAck({ id: envelope.id, client }));
      return;
    }
    if (envelope.type === "sequence_ack" || envelope.type === "response" || envelope.type === "event") return;
    if (envelope.type !== "request") {
      client.send(craftRpcError({ id: envelope.id, code: "BAD_ENVELOPE", message: `Unsupported RPC envelope type: ${envelope.type}` }));
      return;
    }
    const channel = required(envelope.channel, "channel");
    const result = await handleCraftRpcRequest({ channel, args: envelope.args ?? [], runtime, events, automationScheduler, workspaceWatchers });
    client.send(craftRpcResponse({ id: envelope.id, channel, result }));
  } catch (error) {
    client.send(craftRpcResponse({
      id: envelope.id,
      channel: envelope.channel ?? "unknown",
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.message,
        data: error.data
      }
    }));
  }
}

async function handleCraftRpcRequest({ channel, args, runtime, events, automationScheduler, workspaceWatchers }) {
  const store = runtime.store;
  const preferences = async () => rpcPreferences(await store.readPreferences());
	  if (channel === "workspaces:get" || channel === "server:getWorkspaces") {
	    const workspaceRecord = workspaceClientRecord(await store.getWorkspace());
	    return [workspaceRecord];
	  }
  if (channel === "server:createWorkspace") {
    const created = await handleCraftRpcRequest({ channel: "workspaces:create", args, runtime, events, automationScheduler, workspaceWatchers });
    return created;
  }
  if (channel === "server:shuttingDown") return { ok: true, shuttingDown: false };
  if (channel === "workspaces:checkSlug") return checkWorkspaceSlug(args[0]?.slug ?? args[0]?.name ?? args[0]);
  if (channel === "workspaces:create") {
    const input = args[0] ?? {};
    const workspaceRecord = createWorkspace({
      root: input.root ?? runtime.workspace,
      id: input.slug ?? input.id,
      name: input.name
    });
    await store.saveWorkspace(workspaceRecord);
    events.emit("workspace.created", { workspace: workspaceRecord });
    return workspaceClientRecord(workspaceRecord);
  }
  if (channel === "workspaces:updateRemote") {
    const workspaceRecord = await store.getWorkspace();
    const input = args[0] ?? {};
    const next = { ...workspaceRecord, remote: input.remote ?? input, updatedAt: new Date().toISOString() };
    await store.saveWorkspace(next);
    return workspaceClientRecord(next);
  }
  if (channel === "workspaces:delete") return { ok: false, reason: "cannot_delete_active_workspace" };
  if (channel === "window:getWorkspace") return workspaceClientRecord(await store.getWorkspace());
  if (channel === "window:getMode") return "remote";
  if (channel.startsWith("window:")) return windowRpc({ store, runtime, channel, input: args[0] ?? {} });
  if (channel === "sessions:get") return (await store.listSessions()).map(sessionForRpc);
  if (channel === "sessions:getUnreadSummary") {
    const workspaceId = (await store.getWorkspace()).id;
    return {
      unreadCount: 0,
      sessionIds: [],
      hasUnreadByWorkspace: { [workspaceId]: false }
    };
  }
  if (channel === "sessions:markAllRead") return recordRpcEvent(store, channel, args[0] ?? {}, { event: "markAllRead" });
  if (channel === "sessions:getMessages") {
    const sessionId = required(args[0]?.sessionId ?? args[0], "sessionId");
    return sessionMessagesForRpc(await store.getSession(sessionId));
  }
  if (channel === "sessions:create") {
    const input = normalizeSessionCreateInput(args);
    const workspaceRecord = await store.getWorkspace();
    const session = createSession({
      workspaceId: workspaceRecord.id,
      prompt: input.prompt,
      name: input.name ?? input.title,
      labels: input.labels
    });
    await store.saveSession(session);
    events.emit("session.created", { session });
    return sessionForRpc(session);
  }
  if (channel === "sessions:sendMessage") {
    const input = normalizeSessionMessageInput(args);
    const session = await store.getSession(required(input.sessionId, "sessionId"));
    const prompt = required(input.content ?? input.prompt ?? input.message, "content");
    const now = new Date().toISOString();
    const next = {
      ...session,
      events: [...(session.events ?? []), { type: "UserPromptSubmit", prompt, createdAt: now }],
      updatedAt: now
    };
	    await store.saveSession(next);
	    await store.appendProtocolEvent(createProtocolEvent({
	      type: "session.message.created",
	      threadId: next.id,
	      payload: { prompt, sessionId: next.id, messageCount: next.events.length }
	    }));
	    events.emit("session.message.created", { session: next, prompt });
    return sessionMessagesForRpc(next);
  }
  if (channel === "sessions:cancel" || channel === "sessions:killShell") return recordRpcEvent(store, channel, args[0] ?? {}, { event: channel.split(":")[1] });
  if (channel.startsWith("sessions:")) return sessionFallbackRpc({ store, runtime, channel, input: args[0] ?? {}, workspaceWatchers });
	  if (channel === "projects:get") return store.listProjects();
  if (channel === "projects:getOne") return store.getProject(required(args[0]?.projectId ?? args[0]?.id ?? args[0], "projectId"));
  if (channel === "projects:create") {
    const input = args[0] ?? {};
    const workspaceRecord = await store.getWorkspace();
    const project = createProject({
      workspaceId: workspaceRecord.id,
      name: required(input.name ?? input.title, "name"),
      root: input.root ?? runtime.workspace
    });
    await store.saveProject(project);
    events.emit("project.created", { project });
    return project;
  }
  if (channel === "projects:update") {
    const input = args[0] ?? {};
    const projectId = required(input.projectId ?? input.id ?? args[1], "projectId");
    const project = updateProject(await store.getProject(projectId), input.patch ?? input);
    await store.saveProject(project);
    events.emit("project.updated", { project });
    return project;
  }
  if (channel === "projects:delete") {
    const projectId = required(args[0]?.projectId ?? args[0]?.id ?? args[0], "projectId");
    const project = await store.getProject(projectId);
    await store.deleteProject(projectId);
    const detached = await detachProjectReferences(store, projectId);
    events.emit("project.deleted", { projectId, detached });
    return { project, detached };
  }
  if (channel === "projects:listAssets") return listProjectAssets(runtime.workspace, args[0]?.projectId ?? args[0]?.id ?? args[0]);
  if (channel === "projects:uploadAsset") return saveProjectAsset(runtime.workspace, args[0] ?? {});
  if (channel === "projects:deleteAsset") return deleteProjectAsset(runtime.workspace, args[0] ?? {});
  if (channel === "projects:changed") return recordRpcEvent(store, channel, args[0] ?? {});
  if (channel === "automations:get") return automationRpcList(await store.getAutomationConfig());
  if (channel === "automations:test") return testAutomationRpc({ store, runtime, events, input: args[0] ?? {} });
  if (channel === "automations:setEnabled") return setAutomationEnabledRpc(store, args[0] ?? {});
  if (channel === "automations:duplicate") return duplicateAutomationRpc(store, args[0] ?? {});
  if (channel === "automations:delete") return deleteAutomationRpc(store, args[0] ?? {});
  if (channel === "automations:getHistory") return store.listAutomationHistory();
  if (channel === "automations:getLastExecuted") return getLastExecutedAutomationRpc(store, args[0] ?? {});
  if (channel === "automations:replay") return replayAutomationRpc({ store, runtime, events, automationScheduler, input: args[0] ?? {} });
  if (channel === "automations:changed") return recordRpcEvent(store, channel, args[0] ?? {});
	  if (channel === "tasks:list") return store.listTasks(args[0] ?? {});
  if (channel === "tasks:get") return store.getTask(required(args[0]?.taskId ?? args[0]?.id ?? args[0], "taskId"));
  if (channel === "tasks:create") {
    const input = args[0] ?? {};
    const workspaceRecord = await store.getWorkspace();
    const task = createTask({
      workspaceId: workspaceRecord.id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      title: required(input.title ?? input.name, "title"),
      description: input.description,
      labels: input.labels,
      dueDate: input.dueDate,
      statusId: input.statusId,
      statusConfig: await store.getStatusConfig()
    });
    await store.saveTask(task);
    events.emit("task.created", { task });
    return task;
  }
  if (channel === "tasks:validate") {
    try {
      createTask({ workspaceId: (await store.getWorkspace()).id, ...(args[0] ?? {}), title: args[0]?.title ?? args[0]?.name, statusConfig: await store.getStatusConfig() });
      return { ok: true, issues: [] };
    } catch (error) {
      return { ok: false, issues: [error.message] };
    }
  }
  if (channel === "tasks:run" || channel === "tasks:pause" || channel === "tasks:resume" || channel === "tasks:stop") return taskRunRpc(store, channel, args[0] ?? {});
  if (channel === "tasks:getOutput") return taskOutputRpc(store, args[0] ?? {});
  if (channel === "tasks:getResults") return taskResultsRpc(store, args[0] ?? {});
  if (channel === "tasks:generate") return taskGenerateRpc(store, args[0] ?? {});
  if (channel === "tasks:generated") return recordRpcEvent(store, channel, args[0] ?? {});
	  if (channel === "views:list") return store.listViews(args[0] ?? {});
  if (channel === "views:save") return saveViewFromRpc(store, args[0] ?? {});
	  if (channel === "statuses:list") return (await store.getStatusConfig()).statuses;
  if (channel === "statuses:reorder") {
    const config = await store.getStatusConfig();
    const order = args[0]?.order ?? args[0]?.statusIds ?? args[0] ?? [];
    const positions = new Map((Array.isArray(order) ? order : []).map((id, index) => [id, index]));
    const next = {
      ...config,
      statuses: config.statuses
        .map((status) => ({ ...status, order: positions.has(status.id) ? positions.get(status.id) : status.order }))
        .sort((a, b) => a.order - b.order)
    };
    await store.saveStatusConfig(next);
    events.emit("status.reordered", { config: next });
    return next;
  }
  if (channel === "statuses:changed") return recordRpcEvent(store, channel, args[0] ?? {});
	  if (channel === "labels:list") return flattenLabels(await store.getLabelConfig());
  if (channel === "labels:create") {
    const config = createLabel(await store.getLabelConfig(), args[0] ?? {});
    await store.saveLabelConfig(config);
    events.emit("label.created", { config });
    return { config, labels: flattenLabels(config) };
  }
  if (channel === "labels:delete") {
    const labelId = required(args[0]?.labelId ?? args[0]?.id ?? args[0], "labelId");
    const deleted = deleteLabel(await store.getLabelConfig(), labelId);
    await store.saveLabelConfig(deleted.config);
    const migrated = await removeLabelReferences(store, deleted.removed);
    events.emit("label.deleted", { labelId, removed: deleted.removed, migrated });
    return { ...deleted, labels: flattenLabels(deleted.config), migrated };
  }
  if (channel === "labels:changed") return recordRpcEvent(store, channel, args[0] ?? {});
  if (channel === "skills:get") return discoverSkills({ workspace: runtime.workspace });
  if (channel.startsWith("skills:")) return skillsRpc({ store, workspace: runtime.workspace, channel, input: args[0] ?? {} });
	  if (channel === "sources:get") {
	    const workspaceRecord = await store.getWorkspace();
	    return discoverSources({ workspace: runtime.workspace, workspaceId: workspaceRecord.id, store });
	  }
  if (channel === "sources:create") {
    const source = await saveSourceConfig(runtime.workspace, args[0] ?? {});
    events.emit("source.created", { source });
    return source;
  }
  if (channel === "sources:delete") {
    const sourceSlug = required(args[0]?.slug ?? args[0]?.sourceSlug ?? args[0], "sourceSlug");
    await deleteSourceConfig(runtime.workspace, sourceSlug);
    events.emit("source.deleted", { sourceSlug });
    return { ok: true, sourceSlug };
  }
  if (channel === "sources:getMcpTools") {
    const source = await findSourceForRpc(runtime, args[0]?.slug ?? args[0]?.sourceSlug ?? args[0]);
    return listMcpSourceTools({ source, store, fetchImpl: runtime.fetchImpl });
  }
  if (channel === "sources:getPermissions") {
    const source = await findSourceForRpc(runtime, args[0]?.slug ?? args[0]?.sourceSlug ?? args[0]);
    return source.permissions ?? {};
  }
  if (channel === "sources:saveCredentials") {
    const input = args[0] ?? {};
    const source = await findSourceForRpc(runtime, input.slug ?? input.sourceSlug);
    const record = await store.saveCredential(credentialFromPromptInput(source, input));
    events.emit("credential.saved", { credential: summarizeCredential(record) });
    return summarizeCredential(record);
  }
  if (channel === "sources:startOAuth") {
    const source = await findSourceForRpc(runtime, args[0]?.slug ?? args[0]?.sourceSlug ?? args[0]);
    return createSourceOAuthAuthorizationRequest({ source, ...(args[0] ?? {}) });
  }
  if (channel === "sources:changed") return recordRpcEvent(store, channel, args[0] ?? {});
  if (channel === "knowledge:getEnabled") return (await preferences()).knowledgeEnabled;
  if (channel === "knowledge:setEnabled") return (await store.writePreferences({ knowledgeEnabled: Boolean(args[0]?.enabled ?? args[0]) })).knowledgeEnabled;
  if (channel === "knowledge:listVaults") return store.listKnowledgeCollections();
  if (channel === "knowledge:getDefaultVault") return defaultKnowledgeVault(await store.listKnowledgeCollections(), await preferences());
  if (channel === "knowledge:setDefaultVault") {
    const vaultId = args[0]?.vaultId ?? args[0]?.collectionId ?? args[0] ?? null;
    return (await store.writePreferences({ defaultKnowledgeVaultId: vaultId })).defaultKnowledgeVaultId;
  }
  if (channel === "knowledge:initVault" || channel === "knowledge:configureQmdVault") return saveKnowledgeVaultFromRpc(store, runtime.workspace, args[0] ?? {});
  if (channel === "knowledge:inspectVaultPath") return inspectKnowledgeVaultPath(args[0]?.path ?? args[0]?.root ?? args[0] ?? runtime.workspace);
  if (channel === "knowledge:getVaultSummary") return knowledgeVaultSummary(await store.getKnowledgeReport(), args[0]?.vaultId ?? args[0]?.collectionId ?? args[0]);
  if (channel === "knowledge:listPages") return store.listKnowledgeDocuments({ collectionId: args[0]?.vaultId ?? args[0]?.collectionId });
  if (channel === "knowledge:searchVault") {
    const filter = {
      query: args[0]?.query ?? args[0] ?? "",
      collectionId: args[0]?.vaultId ?? args[0]?.collectionId,
      limit: args[0]?.limit
    };
    return args[0]?.semantic === true ? store.searchKnowledgeSemantic(filter) : store.searchKnowledge(filter);
  }
  if (channel === "knowledge:addRawDocument") return addRawKnowledgeDocument(store, runtime.workspace, args[0] ?? {});
  if (channel === "knowledge:deleteDocuments") return deleteKnowledgeDocumentsFromRpc(store, args[0] ?? {});
  if (channel === "knowledge:moveDocuments") return moveKnowledgeDocumentsFromRpc(store, args[0] ?? {});
  if (channel === "knowledge:getKnowledgeGraph") return knowledgeGraph(await store.listKnowledgeCollections(), await store.listKnowledgeDocuments());
  if (channel === "knowledge:getQualityReport" || channel === "knowledge:getTaskReport" || channel === "knowledge:getQmdIndexReport") return store.inspectKnowledge();
  if (channel === "knowledge:checkReadiness" || channel === "knowledge:getQmdStatus") return {
    ready: (await store.getKnowledgeSemanticState()).installed === true,
    semanticEngine: (await store.getKnowledgeReport()).semanticEngine,
    report: await store.getKnowledgeReport()
  };
  if (channel === "knowledge:getQmdSettings") return store.getKnowledgeSemanticState();
  if (channel === "knowledge:setQmdSettings") return store.configureKnowledgeSemanticState(args[0] ?? {});
  if (channel === "knowledge:setQmdEmbedModel") return store.configureKnowledgeSemanticState({ model: args[0]?.model ?? args[0] ?? null });
  if (channel === "knowledge:embedQmdIndex") return store.createKnowledgeSemanticJob({
    collectionId: args[0]?.vaultId ?? args[0]?.collectionId,
    model: args[0]?.model,
    cacheDir: args[0]?.cacheDir
  });
  if (channel === "knowledge:rebuildQmdIndex" || channel === "knowledge:cleanupQmdIndex" || channel === "knowledge:repairQmdModels" || channel === "knowledge:runQmdDoctor") {
    const workspaceRecord = await store.getWorkspace();
    return store.repairKnowledge({ workspaceId: workspaceRecord.id });
  }
  if (channel === "knowledge:getTaskSettings") return (await preferences()).knowledgeTaskSettings;
  if (channel === "knowledge:setTaskSettings") return (await store.writePreferences({ knowledgeTaskSettings: args[0] ?? {} })).knowledgeTaskSettings;
  if (channel === "knowledge:getSchedule") return (await preferences()).knowledgeSchedule;
  if (channel === "knowledge:setSchedule") return (await store.writePreferences({ knowledgeSchedule: args[0] ?? {} })).knowledgeSchedule;
  if (channel === "knowledge:runScheduleNow") return { ok: true, report: await store.inspectKnowledge() };
  if (channel === "knowledge:listTaskReports") return (await preferences()).knowledgeTaskReports;
  if (channel === "knowledge:listHistorySessions") return (await store.listSessions()).filter((session) => session.metadata?.kind === "knowledge");
  if (channel === "knowledge:readHistorySession") return sessionMessagesForRpc(await store.getSession(required(args[0]?.sessionId ?? args[0]?.id ?? args[0], "sessionId")));
  if (channel === "knowledge:createTaskSession") {
    const workspaceRecord = await store.getWorkspace();
    const input = args[0] ?? {};
    const session = createSession({
      workspaceId: workspaceRecord.id,
      prompt: input.prompt ?? input.task ?? "Knowledge task",
      name: input.name ?? input.title ?? "Knowledge task"
    });
    await store.saveSession({ ...session, metadata: { ...(session.metadata ?? {}), kind: "knowledge" } });
    return sessionForRpc(session);
  }
  if (channel === "knowledge:listInboxItems") return (await preferences()).knowledgeInboxItems;
  if (channel === "knowledge:manageCategory") return saveKnowledgeCategory(store, args[0] ?? {});
  if (channel === "knowledge:confirmDraftReview" || channel === "knowledge:confirmTaskPlan") return confirmKnowledgeReviewRpc(store, channel, args[0] ?? {});
  if (channel === "knowledge:installQmd") return store.configureKnowledgeSemanticState({ installed: true, status: "ready", reason: null, engine: "clean-room-local-semantic" });
  if (channel === "knowledge:updateQmd") return store.configureKnowledgeSemanticState({ installed: true, status: "ready", reason: null, engine: "clean-room-local-semantic" });
  if (channel === "knowledge:uninstallQmd") return store.configureKnowledgeSemanticState({ installed: false, status: "unavailable", reason: "qmd engine is not installed" });
  if (channel === "knowledge:installLarkSkills" || channel === "knowledge:installWikiSkills") return installKnowledgeSkillsRpc({
    store,
    workspace: runtime.workspace,
    kind: channel === "knowledge:installLarkSkills" ? "lark" : "wiki",
    input: args[0] ?? {}
  });
  if (channel === "knowledge:event") return recordRpcEvent(store, channel, args[0] ?? {});
  if (channel === "messaging:getConfig") return (await preferences()).messagingConfig;
  if (channel === "messaging:updateConfig") return updateMessagingConfig(store, args[0] ?? {});
	  if (channel === "messaging:saveTelegram") return saveMessagingPlatform(store, "telegram", args[0] ?? {});
	  if (channel === "messaging:testTelegram") return testMessagingPlatform(await preferences(), "telegram");
	  if (channel === "messaging:saveLark") return saveMessagingPlatform(store, "lark", args[0] ?? {});
	  if (channel === "messaging:testLark") return testMessagingPlatform(await preferences(), "lark");
	  if (channel === "messaging:wa:startConnect") return startWhatsAppConnect(store, args[0] ?? {});
	  if (channel === "messaging:wa:submitPhone") return submitWhatsAppPhone(store, args[0] ?? {});
	  if (channel === "messaging:wa:uiEvent") return recordWhatsAppUiEvent(store, args[0] ?? {});
	  if (channel === "messaging:access:getMode") return (await preferences()).messagingAccess.mode;
	  if (channel === "messaging:access:setMode") return setMessagingAccessMode(store, args[0] ?? {});
	  if (channel === "messaging:access:getOwners") return (await preferences()).messagingAccess.owners;
	  if (channel === "messaging:access:setOwners") return setMessagingAccessOwners(store, args[0] ?? {});
	  if (channel === "messaging:access:getPending") return (await preferences()).messagingAccess.pending;
	  if (channel === "messaging:access:allowPending") return resolveMessagingAccessPending(store, args[0] ?? {}, "allowed");
	  if (channel === "messaging:access:dismissPending") return resolveMessagingAccessPending(store, args[0] ?? {}, "dismissed");
	  if (channel === "messaging:access:setBindingAccess") return setMessagingBindingAccess(store, args[0] ?? {});
	  if (channel === "messaging:platformStatus") return messagingPlatformStatus(await preferences(), args[0]?.platform ?? args[0]);
	  if (channel === "messaging:getBindings") return (await preferences()).messagingBindings;
  if (channel === "messaging:generateCode") return generateMessagingCode(store, args[0] ?? {});
  if (channel === "messaging:generateSupergroupCode") return generateMessagingCode(store, { ...(args[0] ?? {}), kind: "supergroup" });
  if (channel === "messaging:getSupergroup") return (await preferences()).messagingSupergroup;
  if (channel === "messaging:unbind" || channel === "messaging:unbindBinding") return unbindMessaging(store, args[0] ?? {});
  if (channel === "messaging:unbindSupergroup") return (await store.writePreferences({ messagingSupergroup: null })).messagingSupergroup;
  if (channel === "messaging:disconnect") return disconnectMessaging(store, args[0]?.platform ?? args[0]);
  if (channel === "messaging:forget") return forgetMessaging(store);
  if (channel === "messaging:bindingChanged") return applyMessagingBindingEvent(store, args[0] ?? {});
	  if (channel === "messaging:pendingChanged") return recordMessagingPendingChanged(store, args[0] ?? {});
  if (channel === "chatgpt:getAuthStatus" || channel === "copilot:getAuthStatus" || channel === "xai:getAuthStatus") {
    return providerAuthStatus(await preferences(), channel.split(":")[0]);
  }
  if (channel === "chatgpt:startOAuth" || channel === "copilot:startOAuth" || channel === "xai:startOAuth") {
    return startProviderOAuth(store, channel.split(":")[0]);
  }
  if (channel === "chatgpt:cancelOAuth" || channel === "copilot:cancelOAuth" || channel === "xai:cancelOAuth") {
    return cancelProviderOAuth(store, channel.split(":")[0]);
  }
  if (channel === "chatgpt:logout" || channel === "copilot:logout" || channel === "xai:logout") {
    return logoutProviderOAuth(store, channel.split(":")[0]);
  }
  if (channel === "copilot:deviceCode" || channel === "xai:deviceCode") return providerDeviceCode(store, channel.split(":")[0], args[0] ?? {});
  if (channel === "browser-pane:list") return browserPaneList(await preferences()).panes;
  if (channel === "browser-pane:create" || channel === "browser-empty-state:launch") return createBrowserPane(store, args[0] ?? {}, runtime);
  if (channel === "browser-pane:navigate") return navigateBrowserPane(store, args[0] ?? {}, runtime);
  if (channel === "browser-pane:go-back") return moveBrowserPaneHistory(store, args[0] ?? {}, -1);
  if (channel === "browser-pane:go-forward") return moveBrowserPaneHistory(store, args[0] ?? {}, 1);
  if (channel === "browser-pane:focus") return focusBrowserPane(store, args[0] ?? {});
  if (channel === "browser-pane:reload") return reloadBrowserPane(store, args[0] ?? {}, runtime);
  if (channel === "browser-pane:stop") return updateBrowserPane(store, args[0] ?? {}, { loading: false, stoppedAt: new Date().toISOString() });
  if (channel === "browser-pane:interacted") return updateBrowserPane(store, args[0] ?? {}, { lastInteractedAt: new Date().toISOString() });
  if (channel === "browser-pane:destroy" || channel === "browser-pane:removed") return destroyBrowserPane(store, args[0] ?? {});
  if (channel === "browser-pane:state-changed") return updateBrowserPane(store, args[0] ?? {}, args[0]?.state ?? args[0]?.patch ?? {});
  if (channel === "computerUse:getStatus") return computerUseStatus(await preferences());
  if (channel === "computerUse:openPermissionPane" || channel === "computerUse:requestPermissions") {
    return updateComputerUsePermission(store, channel, args[0] ?? {});
  }
  if (channel === "remote:testConnection") return remoteConnectionStatus(args[0] ?? {}, runtime);
  if (channel === "rtk:getEnabled") return (await preferences()).rtkEnabled;
  if (channel === "rtk:setEnabled") return (await setRtkEnabled(store, args[0] ?? {})).enabled;
  if (channel === "rtk:getGain") return (await preferences()).rtkGain;
  if (channel === "rtk:getStatus") return rtkStatus(await preferences());
  if (channel === "update:check") return checkDesktopUpdate(store, args[0] ?? {});
  if (channel === "update:getInfo" || channel === "update:available") return desktopUpdateStatus(await preferences(), channel);
  if (channel === "update:download" || channel === "update:startDownload") return downloadDesktopUpdate(store, args[0] ?? {});
  if (channel === "update:downloadProgress") return (await preferences()).updateInfo.downloadProgress;
  if (channel === "update:getDismissed") return (await preferences()).updateDismissed;
  if (channel === "update:dismiss") return dismissUpdate(store, args[0] ?? {});
  if (channel === "update:install") return installDesktopUpdate(store, args[0] ?? {});
  if (channel === "pilot:getStatus" || channel === "pilot:checkUpdate") return pilotStatus(await preferences(), channel);
  if (channel === "pilot:start") return setPilotStatus(store, "running");
  if (channel === "pilot:stop") return setPilotStatus(store, "stopped");
  if (channel === "pilot:install") return installPilotRuntime(store, args[0] ?? {});
  if (channel === "pilot:openDashboard") return openPilotDashboard(store, args[0] ?? {});
  if (channel === "preferences:read") return preferences();
  if (channel === "preferences:write") return rpcPreferences(await store.writePreferences(args[0] ?? {}));
  if (channel === "preferences:setUiLanguage") {
    return rpcPreferences(await store.writePreferences({ uiLanguage: args[0]?.language ?? args[0] ?? "en" }));
  }
  if (channel === "drafts:get") return store.getDraft(args[0]?.key ?? args[0] ?? "default");
  if (channel === "drafts:set") {
    const input = normalizeDraftInput(args);
    return store.setDraft(input.key, input.value);
  }
  if (channel === "drafts:delete") return store.deleteDraft(args[0]?.key ?? args[0] ?? "default");
  if (channel === "drafts:getAll") return store.listDrafts();
  if (channel === "theme:getSystemPreference") return (await preferences()).systemTheme;
  if (channel === "theme:getApp") return (await preferences()).appTheme;
  if (channel === "theme:getPresets") return resourceManifest().themes;
  if (channel === "theme:loadPreset") return resourceManifest().themes.find((theme) => theme.id === (args[0]?.id ?? args[0])) ?? null;
  if (channel === "theme:getColorTheme") return (await preferences()).colorTheme;
  if (channel === "theme:setColorTheme") {
    return (await store.writePreferences({ colorTheme: args[0]?.theme ?? args[0] ?? "default" })).colorTheme;
  }
  if (channel === "theme:getWorkspaceColorTheme") return (await preferences()).workspaceColorTheme;
  if (channel === "theme:setWorkspaceColorTheme") {
    return (await store.writePreferences({ workspaceColorTheme: args[0]?.theme ?? args[0] ?? "default" })).workspaceColorTheme;
  }
  if (channel === "theme:getAllWorkspaceThemes") return { [workspaceClientRecord(await store.getWorkspace()).id]: (await preferences()).workspaceColorTheme };
  if (channel === "theme:broadcastPreferences" || channel === "theme:broadcastWorkspaceTheme") return recordRpcEvent(store, channel, args[0] ?? {});
  if (channel.startsWith("theme:")) return themeRpc(store, channel, args[0] ?? {});
  if (channel === "input:getAutoCapitalisation") return (await preferences()).autoCapitalisation;
  if (channel === "input:setAutoCapitalisation") return (await store.writePreferences({ autoCapitalisation: Boolean(args[0]?.enabled ?? args[0]) })).autoCapitalisation;
  if (channel === "input:getSendMessageKey") return (await preferences()).sendMessageKey;
  if (channel === "input:setSendMessageKey") return (await store.writePreferences({ sendMessageKey: args[0]?.key ?? args[0] ?? "enter" })).sendMessageKey;
  if (channel === "input:getSpellCheck") return (await preferences()).spellCheck;
  if (channel === "input:setSpellCheck") return (await store.writePreferences({ spellCheck: Boolean(args[0]?.enabled ?? args[0]) })).spellCheck;
  if (channel === "power:getKeepAwake") return (await preferences()).keepAwakeWhileRunning;
  if (channel === "power:setKeepAwake") return (await store.writePreferences({ keepAwakeWhileRunning: Boolean(args[0]?.enabled ?? args[0]) })).keepAwakeWhileRunning;
  if (channel === "appearance:getRichToolDescriptions") return (await preferences()).richToolDescriptions;
  if (channel === "appearance:setRichToolDescriptions") return (await store.writePreferences({ richToolDescriptions: Boolean(args[0]?.enabled ?? args[0]) })).richToolDescriptions;
  if (channel === "tools:getBrowserToolEnabled") return (await preferences()).browserToolEnabled;
  if (channel === "tools:setBrowserToolEnabled") return (await store.writePreferences({ browserToolEnabled: Boolean(args[0]?.enabled ?? args[0]) })).browserToolEnabled;
  if (channel === "tools:getComputerUseEnabled") return (await preferences()).computerUseEnabled;
  if (channel === "tools:setComputerUseEnabled") return (await store.writePreferences({ computerUseEnabled: Boolean(args[0]?.enabled ?? args[0]) })).computerUseEnabled;
  if (channel === "tools:getSmartSnapshotSettings") return (await preferences()).smartSnapshotSettings;
  if (channel === "tools:setSmartSnapshotSettings") return (await store.writePreferences({ smartSnapshotSettings: args[0] ?? {} })).smartSnapshotSettings;
  if (channel === "memory:getEnabled") return (await preferences()).memoryEnabled;
  if (channel === "memory:setEnabled") return (await store.writePreferences({ memoryEnabled: Boolean(args[0]?.enabled ?? args[0]) })).memoryEnabled;
  if (channel === "memory:getDisableOnExternalContext") return (await preferences()).memoryDisableOnExternalContext;
  if (channel === "memory:setDisableOnExternalContext") {
    return (await store.writePreferences({ memoryDisableOnExternalContext: Boolean(args[0]?.enabled ?? args[0]) })).memoryDisableOnExternalContext;
  }
  if (channel === "memory:reset") {
    await store.writeMemory({ facts: [] });
    return { ok: true };
  }
  if (channel === "caching:getExtendedPromptCache") return (await preferences()).extendedPromptCache;
  if (channel === "caching:setExtendedPromptCache") return (await store.writePreferences({ extendedPromptCache: Boolean(args[0]?.enabled ?? args[0]) })).extendedPromptCache;
  if (channel === "caching:getEnable1MContext") return (await preferences()).enable1MContext;
  if (channel === "caching:setEnable1MContext") return (await store.writePreferences({ enable1MContext: Boolean(args[0]?.enabled ?? args[0]) })).enable1MContext;
  if (channel === "observability:getEmitEnabled") return (await preferences()).observabilityEmitEnabled;
  if (channel === "observability:setEmitEnabled") return (await store.writePreferences({ observabilityEmitEnabled: Boolean(args[0]?.enabled ?? args[0]) })).observabilityEmitEnabled;
  if (channel === "observability:getProfile") return observabilityProfile(await preferences());
	  if (channel === "observability:getSessionTrace") return buildSessionTrace(store, args[0]?.sessionId ?? args[0]?.threadId ?? args[0]);
	  if (channel === "observability:getSessionUsage") return buildSessionUsage(store, args[0]?.sessionId ?? args[0]?.threadId ?? args[0]);
	  if (channel === "usageQuota:get") return buildUsageQuota(store);
  if (channel === "goal:get") return (await preferences()).activeGoal;
  if (channel === "goal:set") return setGoalRpc(store, args[0] ?? {});
  if (channel === "goal:clear") return clearGoalRpc(store);
  if (channel === "loop:list") return (await preferences()).loopDefinitions;
  if (channel === "loop:get") return getLoopRpc(await preferences(), args[0] ?? {});
  if (channel === "loop:runs") return loopRunsRpc(await preferences(), args[0] ?? {});
  if (channel === "loop:start") return startLoopRpc({ store, input: args[0] ?? {} });
  if (channel === "loop:action") return loopActionRpc(store, args[0] ?? {});
  if (channel === "loop:event") return loopEventRpc(store, args[0] ?? {});
  if (channel === "loop:designStart") return designLoopRpc(store, args[0] ?? {});
  if (channel === "settings:getServerStatus") return { ok: true, power: powerState(), workspace: workspaceClientRecord(await store.getWorkspace()) };
  if (channel === "settings:setServerConfig") return rpcPreferences(await store.writePreferences({ serverConfig: args[0] ?? {} }));
  if (channel === "settings:testLlmConnectionSetup") return testLlmConnectionSetup(args[0] ?? {}, runtime);
  if (channel === "settings:setupLlmConnection") {
    const saved = await saveLlmConnection(store, args[0] ?? {}, { setDefault: true });
    return { ok: true, connection: saved.connection };
  }
  if (channel === "LLM_Connection:list") return listLlmConnections(await preferences());
  if (channel === "LLM_Connection:listWithStatus") return listLlmConnectionsWithStatus(await preferences());
  if (channel === "LLM_Connection:get") return getLlmConnection(await preferences(), args[0]?.id ?? args[0]?.connectionId ?? args[0]);
  if (channel === "LLM_Connection:getApiKey") return llmConnectionApiKeyStatus(await preferences(), args[0]?.id ?? args[0]?.connectionId ?? args[0]);
  if (channel === "LLM_Connection:save") return saveLlmConnection(store, args[0] ?? {}, { setDefault: args[0]?.setDefault === true });
  if (channel === "LLM_Connection:delete") return deleteLlmConnection(store, args[0]?.id ?? args[0]?.connectionId ?? args[0]);
  if (channel === "LLM_Connection:test") return testLlmConnectionSetup(args[0]?.connection ?? args[0] ?? {}, runtime);
  if (channel === "LLM_Connection:setDefault") return setDefaultLlmConnection(store, args[0]?.id ?? args[0]?.connectionId ?? args[0]);
  if (channel === "LLM_Connection:setWorkspaceDefault") return setWorkspaceDefaultLlmConnection(store, args[0]?.id ?? args[0]?.connectionId ?? args[0]);
  if (channel === "LLM_Connection:changed") return recordRpcEvent(store, channel, args[0] ?? {});
  if (channel === "settings:getDefaultThinkingLevel") return (await store.getWorkspace()).config?.thinkingLevel ?? mergeConfig().workspaceDefaults.thinkingLevel;
  if (channel === "settings:setDefaultThinkingLevel") {
    const workspaceRecord = await store.getWorkspace();
    const thinkingLevel = args[0]?.thinkingLevel ?? args[0] ?? mergeConfig().workspaceDefaults.thinkingLevel;
    await store.saveWorkspace({ ...workspaceRecord, config: { ...(workspaceRecord.config ?? {}), thinkingLevel }, updatedAt: new Date().toISOString() });
    return thinkingLevel;
  }
  if (channel === "settings:getNetworkProxy") return (await preferences()).networkProxy;
  if (channel === "settings:setNetworkProxy") return (await store.writePreferences({ networkProxy: args[0] ?? null })).networkProxy;
  if (channel === "settings:getQuickLauncher") return (await preferences()).quickLauncher;
  if (channel === "settings:setQuickLauncher") return (await store.writePreferences({ quickLauncher: args[0] ?? {} })).quickLauncher;
  if (channel === "notification:getEnabled") return (await preferences()).notificationsEnabled;
  if (channel === "notification:setEnabled") return (await store.writePreferences({ notificationsEnabled: Boolean(args[0]?.enabled ?? args[0]) })).notificationsEnabled;
  if (channel === "notification:show" || channel === "notification:navigate") return notificationRpc(store, channel, args[0] ?? {});
  if (channel === "terminal:getFrequentCommands") {
    const current = await preferences();
    return frequentTerminalCommands(await store.listTerminalHistory(), current.terminalHiddenFrequentCommands ?? []);
  }
  if (channel === "terminal:recordCommand") return terminalRecordCommandRpc({ store, runtime, input: args[0] ?? {} });
  if (channel === "terminal:deleteFrequent" || channel === "terminal:clearFrequent") return terminalFrequentCommandRpc(store, channel, args[0] ?? {});
  if (channel === "terminal:listButtons") return (await preferences()).terminalButtons;
  if (channel === "terminal:saveButton") return savePreferenceListItem(store, "terminalButtons", args[0] ?? {});
  if (channel === "terminal:deleteButton") return deletePreferenceListItem(store, "terminalButtons", args[0]?.id ?? args[0]);
  if (channel === "terminal:reorderButtons") return (await store.writePreferences({ terminalButtons: args[0]?.buttons ?? args[0] ?? [] })).terminalButtons;
  if (channel === "terminal:listButtonRoots") return [workspaceClientRecord(await store.getWorkspace())];
  if (channel === "git:getStatus") return gitStatus({ cwd: runtime.workspace, pathspecs: args[0]?.paths ?? args[0]?.pathspecs ?? args[0]?.path });
  if (channel === "git:getBranch") return gitCurrentBranch({ cwd: runtime.workspace });
  if (channel === "git:listBranches") return gitBranches({ cwd: runtime.workspace });
  if (channel === "git:listWorktrees") return gitWorktrees({ cwd: runtime.workspace });
  if (channel === "git:listStashes") return gitStashes({ cwd: runtime.workspace });
  if (channel === "git:getDiff") return gitDiff({ cwd: runtime.workspace, staged: args[0]?.staged === true, pathspecs: args[0]?.paths ?? args[0]?.pathspecs ?? args[0]?.path });
  if (channel === "git:getCommitDiff") return gitDiff({ cwd: runtime.workspace, commit: args[0]?.commit ?? args[0]?.hash ?? args[0], pathspecs: args[0]?.paths ?? args[0]?.pathspecs ?? args[0]?.path });
  if (channel === "git:listHistory") return gitHistory({ cwd: runtime.workspace, limit: args[0]?.limit, pathspecs: args[0]?.paths ?? args[0]?.pathspecs ?? args[0]?.path });
  if (channel.startsWith("git:")) return gitMutationRpc(runtime.workspace, channel, args[0] ?? {});
  if (channel === "file:read") return readWorkspaceText(runtime.workspace, args[0]?.path ?? args[0]);
  if (channel === "file:readDataUrl" || channel === "file:readPreviewDataUrl") return readWorkspaceDataUrl(runtime.workspace, args[0]?.path ?? args[0]);
  if (channel === "file:readBinary") return readWorkspaceBinaryEnvelope(runtime.workspace, args[0]?.path ?? args[0]);
  if (channel.startsWith("file:")) return fileRpc(runtime.workspace, channel, args[0] ?? {});
  if (channel === "fs:search") return searchWorkspace({ store, query: args[0]?.query ?? args[0] ?? "" });
  if (channel === "fs:listDirectory") return listWorkspaceDirectory(runtime.workspace, args[0]?.path ?? args[0] ?? ".");
  if (channel === "fs:listDirectoryImages") return (await listWorkspaceDirectory(runtime.workspace, args[0]?.path ?? args[0] ?? ".")).filter((entry) => /\.(png|jpe?g|gif|webp|svg)$/i.test(entry.name));
  if (channel === "workspace:getPermissions") return workspacePermissionState(await store.getWorkspace());
  if (channel === "workspace:getFiles") return workspaceFilesForRpc(runtime.workspace, args[0] ?? {});
  if (channel === "workspace:readImage") return readWorkspaceImageEnvelope(runtime.workspace, args[0]?.path ?? args[0]);
  if (channel === "workspace:writeImage") return writeWorkspaceImageEnvelope(runtime.workspace, args[0] ?? {});
  if (channel === "workspace:watchFiles") return workspaceWatchers.watch(args[0] ?? {});
  if (channel === "workspace:unwatchFiles") return workspaceWatchers.unwatch(args[0] ?? {});
  if (channel === "workspace:filesChanged") return workspaceWatchers.recordManualChange(args[0] ?? {});
  if (channel === "toolIcons:getMappings") return listToolIcons();
  if (channel === "pi:getApiKeyProviders") return listProviderProfiles();
  if (channel === "pi:getProviderBaseUrl") return providerProfileFromId(args[0]?.provider ?? args[0]?.id ?? args[0]).baseUrl ?? null;
  if (channel === "pi:getProviderModels") return piProviderModels(args[0] ?? {}, runtime);
  if (channel === "onboarding:getAuthState") return onboardingAuthState(await preferences());
  if (channel === "onboarding:deferSetup") return rpcPreferences(await store.writePreferences({ onboardingDeferred: true }));
  if (channel === "onboarding:hasClaudeOAuthState") return Boolean((await preferences()).claudeOAuthState);
  if (channel === "onboarding:clearClaudeOAuthState") return rpcPreferences(await store.writePreferences({ claudeOAuthState: null }));
  if (channel === "onboarding:startClaudeOAuth" || channel === "onboarding:startMcpOAuth") return startOnboardingOAuth(store, channel.split(":")[1], args[0] ?? {});
  if (channel === "onboarding:exchangeClaudeCode") return exchangeOnboardingClaudeCode(store, args[0] ?? {});
  if (channel === "session:getModel") return sessionModel(await store.getSession(required(args[0]?.sessionId ?? args[0], "sessionId")), await preferences());
	  if (channel === "session:setModel") {
	    const input = args[0] && typeof args[0] === "object" ? args[0] : { sessionId: args[0], model: args[1] };
	    const session = await store.getSession(required(input.sessionId, "sessionId"));
	    const next = { ...session, model: input.model ?? input.connection ?? null, llmConnection: input.connection ?? input.llmConnection ?? input.model ?? null, updatedAt: new Date().toISOString() };
	    await store.saveSession(next);
	    return sessionModel(next, await preferences());
	  }
  if (channel === "session:event") return recordSessionControlEvent(store, {
    channel,
    input: args[0] ?? {},
    command: args[0]?.type ?? args[0]?.event ?? "event"
  });
  if (channel === "workspaceSettings:get") return workspaceSettings(await store.getWorkspace(), await preferences());
  if (channel === "workspaceSettings:update") {
    const workspaceRecord = await store.getWorkspace();
    const patch = args[0] ?? {};
    const nextConfig = { ...(workspaceRecord.config ?? {}), ...(patch.config ?? patch) };
    const next = { ...workspaceRecord, config: nextConfig, updatedAt: new Date().toISOString() };
    await store.saveWorkspace(next);
    return workspaceSettings(next, await preferences());
  }
  if (channel.startsWith("menu:")) return menuCommandRpc({ store, runtime, channel, input: args[0] ?? {} });
  if (channel.startsWith("shell:")) return shellCommandRpc({ store, runtime, channel, input: args[0] ?? {} });
  if (channel === "auth:logout") return authLogoutRpc(store);
  if (channel === "auth:showLogoutConfirmation" || channel === "auth:showDeleteSessionConfirmation") return authDialogRpc(store, channel, args[0] ?? {});
  if (channel === "dialog:openFolder") return dialogOpenFolderRpc(runtime.workspace, args[0] ?? {});
  if (channel === "deeplink:navigate") return deeplinkNavigateRpc(store, args[0] ?? {});
  if (channel === "debug:log") return debugLogRpc(store, args[0] ?? {});
  if (channel === "credentials:healthCheck") return credentialsHealthRpc(store);
  if (channel === "permissions:getDefaults") return DEFAULT_PERMISSION_RULES;
  if (channel === "permissions:defaultsChanged") return recordRpcEvent(store, channel, args[0] ?? {});
  if (channel === "resources:export") return resourcesExportRpc(runtime.workspace, args[0] ?? {});
  if (channel === "resources:import") return resourcesImportRpc(runtime.workspace, args[0] ?? {});
  if (channel === "gitbash:check") return gitbashCheckRpc(await preferences());
  if (channel === "gitbash:setPath") return gitbashSetPathRpc(store, args[0] ?? {});
  if (channel === "gitbash:browse") return gitbashBrowseRpc(store, args[0] ?? {});
  if (channel === "oauth:start") return genericOauthStartRpc(store, args[0] ?? {});
  if (channel === "oauth:revoke") return genericOauthRevokeRpc(store, args[0] ?? {});
  if (channel.startsWith("badge:")) return badgeRpc(store, channel, args[0] ?? {});
  if (channel === "releaseNotes:get") return releaseNotesForRpc(args[0] ?? {});
  if (channel === "releaseNotes:getLatestVersion") return latestReleaseNote()?.id ?? null;
  if (channel === "logo:getUrl") return resourceManifest().logos[0]?.path ?? "/resources/source.png";
  if (channel === "settings:getServerConfig") return mergeConfig();
  if (channel === "system:versions") return { node: process.version, peng: VERSION, craftAgents: "compatible" };
  if (channel === "system:isDebugMode") return process.env.NODE_ENV !== "production";
  if (channel === "system:homeDir" || channel === "server:homeDir") return process.env.HOME ?? null;

  const error = new Error(`RPC channel is not implemented: ${channel}`);
  error.code = "CHANNEL_NOT_FOUND";
  throw error;
}

function isCraftRpcEnvelope(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["handshake", "handshake_ack", "request", "response", "event", "error", "sequence_ack"].includes(value.type);
}

function craftRpcHandshakeAck({ id, client }) {
  return {
    id: String(id ?? crypto.randomUUID()),
    type: "handshake_ack",
    clientId: client.rpcClientId,
    protocolVersion: "1.0",
    serverVersion: VERSION,
    reconnected: false,
    stale: false
  };
}

function craftRpcResponse({ id, channel, result, error }) {
  return {
    id: String(id ?? crypto.randomUUID()),
    type: "response",
    channel,
    ...(error ? { error } : { result })
  };
}

function craftRpcError({ id, code, message, data }) {
  return {
    id: String(id ?? crypto.randomUUID()),
    type: "error",
    error: { code, message, data }
  };
}

function sessionForRpc(session) {
  return {
    ...session,
    title: session.name,
    messages: rpcMessagesFromSession(session),
    isProcessing: session.statusId === "running",
    tokenUsage: null
  };
}

function sessionMessagesForRpc(session) {
  return {
    ...sessionForRpc(session),
    sessionFolderPath: null
  };
}

function rpcMessagesFromSession(session) {
  return (session.events ?? []).map((event, index) => {
    const role = event.role ?? (event.type === "UserPromptSubmit" ? "user" : "assistant");
    return {
      id: event.id ?? `${session.id}_message_${index + 1}`,
      sessionId: session.id,
      role,
      type: event.type ?? "message",
      content: event.content ?? event.prompt ?? "",
      createdAt: event.createdAt ?? session.createdAt
    };
  });
}

function normalizeSessionCreateInput(args) {
  const first = args[0];
  if (typeof first === "string") return { prompt: first };
  return {
    ...(first && typeof first === "object" ? first : {}),
    prompt: first?.prompt ?? first?.content ?? first?.message ?? ""
  };
}

function normalizeSessionMessageInput(args) {
  if (args[0] && typeof args[0] === "object") return args[0];
  return {
    sessionId: args[0],
    content: args[1]?.content ?? args[1]?.prompt ?? args[1]?.message ?? args[1]
  };
}

function pushVapidPublicKey() {
  const keyBytes = Buffer.concat([
    Buffer.from([0x04]),
    crypto.createHash("sha512").update("peng-clean-room-local-push-vapid").digest()
  ]);
  const publicKey = keyBytes.toString("base64url");
  return {
    ok: true,
    available: true,
    publicKey,
    applicationServerKey: publicKey,
    mode: "local",
    note: "Local compatibility key for browser PushManager subscription storage."
  };
}

async function savePushSubscription(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const subscription = normalizePushSubscription(input);
  const nextSubscriptions = [
    subscription,
    ...(preferences.pushSubscriptions ?? []).filter((item) => item.endpoint !== subscription.endpoint)
  ];
  const event = {
    id: `push_event_${crypto.randomUUID()}`,
    type: "push.subscription.saved",
    endpoint: subscription.endpoint,
    createdAt: subscription.updatedAt
  };
  await store.writePreferences({
    pushSubscriptions: nextSubscriptions,
    pushEvents: [event, ...(preferences.pushEvents ?? [])].slice(0, 200)
  });
  return {
    ok: true,
    available: true,
    subscription,
    subscriptions: nextSubscriptions,
    event
  };
}

async function deletePushSubscription(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const endpoint = required(input.endpoint ?? input.subscription?.endpoint ?? input, "endpoint");
  const current = preferences.pushSubscriptions ?? [];
  const nextSubscriptions = current.filter((item) => item.endpoint !== endpoint);
  const event = {
    id: `push_event_${crypto.randomUUID()}`,
    type: "push.subscription.deleted",
    endpoint,
    createdAt: new Date().toISOString()
  };
  await store.writePreferences({
    pushSubscriptions: nextSubscriptions,
    pushEvents: [event, ...(preferences.pushEvents ?? [])].slice(0, 200)
  });
  return {
    ok: true,
    deleted: current.length !== nextSubscriptions.length,
    endpoint,
    subscriptions: nextSubscriptions,
    event
  };
}

function normalizePushSubscription(input = {}) {
  const source = input.subscription ?? input;
  const endpoint = required(source.endpoint, "endpoint");
  const keys = source.keys ?? {};
  const now = new Date().toISOString();
  return {
    id: source.id ?? `push_${crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 16)}`,
    endpoint,
    expirationTime: source.expirationTime ?? null,
    keys: {
      p256dh: keys.p256dh ?? null,
      auth: keys.auth ?? null
    },
    userAgent: input.userAgent ?? source.userAgent ?? null,
    mode: "local",
    createdAt: source.createdAt ?? now,
    updatedAt: now
  };
}

function rpcPreferences(stored = {}) {
  const defaults = mergeConfig().defaults;
  return {
    notificationsEnabled: defaults.notificationsEnabled,
    notificationEvents: [],
    uiLanguage: "en",
    systemTheme: "system",
    appTheme: "system",
    colorTheme: defaults.colorTheme,
    workspaceColorTheme: defaults.colorTheme,
    autoCapitalisation: defaults.autoCapitalisation,
    sendMessageKey: defaults.sendMessageKey,
    spellCheck: defaults.spellCheck,
    keepAwakeWhileRunning: defaults.keepAwakeWhileRunning,
    richToolDescriptions: defaults.richToolDescriptions,
    browserToolEnabled: defaults.browserToolEnabled,
	    computerUseEnabled: defaults.computerUseEnabled,
	    networkProxy: null,
	    quickLauncher: { pages: [{ global: {}, workspaces: {} }], showNames: false },
	    terminalButtons: [],
	    terminalHiddenFrequentCommands: [],
	    rpcEvents: [],
	    skillOpenIntents: [],
	    skillDeleteIntents: [],
	    smartSnapshotSettings: { enabled: true, maxImages: 8, maxBytes: 2_000_000 },
	    memoryEnabled: true,
	    memoryDisableOnExternalContext: false,
		    extendedPromptCache: false,
		    enable1MContext: false,
		    observabilityEmitEnabled: false,
		    activeGoal: null,
		    loopDefinitions: [],
		    loopRuns: [],
		    loopEvents: [],
		    menuState: { sidebarVisible: true, focusMode: false, zoom: 1, devToolsOpen: false },
		    menuActions: [],
		    sessionControlEvents: [],
	    shellActions: [],
		    authDialogs: [],
		    deeplinks: [],
		    debugLogs: [],
		    gitbashPath: null,
		    gitbashBrowseIntents: [],
		    oauthSessions: [],
			    badgeState: { icon: null, count: 0, text: null, updatedAt: null },
			    badgeEvents: [],
		    onboardingDeferred: false,
		    claudeOAuthState: null,
		    onboardingOAuthSessions: [],
			    llmConnection: null,
			    llmConnections: [],
			    defaultLlmConnectionId: null,
			    workspaceDefaultLlmConnectionId: null,
			    llmConnectionTests: [],
			    knowledgeEnabled: true,
	    defaultKnowledgeVaultId: null,
	    knowledgeTaskSettings: {},
	    knowledgeSchedule: {},
	    knowledgeTaskReports: [],
	    knowledgeInboxItems: [],
	    knowledgeCategories: [],
	    knowledgeSkillInstalls: [],
	    knowledgeReviewEvents: [],
	    messagingConfig: {
	      enabled: false,
		      platforms: {
		        telegram: { enabled: false },
		        lark: { enabled: false },
		        whatsapp: { enabled: false }
		      }
		    },
		    messagingBindings: [],
			    messagingPendingCodes: [],
			    messagingSupergroup: null,
			    messagingAccess: { mode: "owners", owners: [], pending: [] },
			    messagingWhatsApp: { status: "idle", connectSessions: [], uiEvents: [] },
			    messagingGateway: { running: false, workers: {}, startedAt: null, stoppedAt: null },
	    messagingEvents: [],
	    workspaceFileWatchers: [],
	    workspaceFileEvents: [],
		    providerAuth: {},
		    browserPanes: [],
		    activeBrowserPaneId: null,
			    windowState: {
			      mode: "remote",
			      focused: true,
			      closeRequested: false,
			      closeConfirmed: false,
			      closeCancelled: false,
			      trafficLights: null,
			      openedSessions: [],
			      openedWorkspaces: []
			    },
			    windowEvents: [],
			    computerUsePermission: { permission: "prompt", status: "not_requested", requestedAt: null, openedAt: null, updatedAt: null },
	    rtkEnabled: false,
		    rtkGain: 1,
		    rtkState: { status: "disabled", enabledAt: null, disabledAt: null, updatedAt: null, source: "default" },
		    updateDismissed: null,
		    updateInfo: {
		      available: false,
		      currentVersion: VERSION,
		      latestVersion: VERSION,
		      status: "current",
		      downloadProgress: { status: "idle", percent: 0, bytesDownloaded: 0, totalBytes: 0 }
		    },
		    pushSubscriptions: [],
		    pushEvents: [],
		    pilotState: {
		      installed: false,
		      running: false,
		      status: "unavailable",
		      reason: "pilot runtime has not been installed in local-state mode",
		      version: null,
		      dashboard: { opened: false, openedAt: null }
		    },
		    ...stored
		  };
		}

function normalizeLlmConnectionSetup(input = {}) {
  const provider = input.provider ?? input.providerId ?? input.id ?? input.profile ?? "openai-compatible";
  const profile = {
    ...providerProfileFromId(provider),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.type ? { type: input.type } : {})
  };
  return {
    id: input.id ?? profile.id ?? provider,
    provider: profile.id ?? provider,
    type: profile.type ?? profile.id ?? provider,
    displayName: input.displayName ?? profile.displayName ?? profile.name ?? profile.id ?? provider,
    baseUrl: input.baseUrl ?? profile.baseUrl ?? null,
    model: input.model ?? input.modelId ?? null,
    hasApiKey: Boolean(input.apiKey || input.hasApiKey),
    updatedAt: new Date().toISOString()
  };
}

function normalizedLlmConnections(preferences = {}) {
  const byId = new Map();
  for (const connection of Array.isArray(preferences.llmConnections) ? preferences.llmConnections : []) {
    const normalized = normalizeLlmConnectionSetup(connection);
    byId.set(normalized.id, { ...connection, ...normalized });
  }
  if (preferences.llmConnection) {
    const normalized = normalizeLlmConnectionSetup(preferences.llmConnection);
    byId.set(normalized.id, { ...preferences.llmConnection, ...normalized });
  }
  const list = [...byId.values()].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const defaultId = preferences.defaultLlmConnectionId ?? preferences.llmConnection?.id ?? list[0]?.id ?? null;
  return list.map((connection) => ({
    ...connection,
    isDefault: connection.id === defaultId,
    isWorkspaceDefault: connection.id === preferences.workspaceDefaultLlmConnectionId
  }));
}

function listLlmConnections(preferences = {}) {
  return normalizedLlmConnections(preferences);
}

function listLlmConnectionsWithStatus(preferences = {}) {
  return normalizedLlmConnections(preferences).map((connection) => ({
    ...connection,
    status: connection.hasApiKey || connection.provider === "ollama" ? "configured" : "needs_api_key",
    authenticated: Boolean(connection.hasApiKey || connection.provider === "ollama")
  }));
}

function getLlmConnection(preferences = {}, connectionId = null) {
  const connections = normalizedLlmConnections(preferences);
  const id = connectionId ?? preferences.defaultLlmConnectionId ?? preferences.llmConnection?.id ?? connections[0]?.id;
  return connections.find((connection) => connection.id === id) ?? null;
}

function llmConnectionApiKeyStatus(preferences = {}, connectionId = null) {
  const connection = getLlmConnection(preferences, connectionId);
  return {
    id: connection?.id ?? connectionId ?? null,
    hasApiKey: Boolean(connection?.hasApiKey),
    apiKey: null,
    redacted: connection?.hasApiKey ? "***" : null
  };
}

async function setGoalRpc(store, input = {}) {
  const now = new Date().toISOString();
  const goal = {
    id: input.id ?? `goal_${crypto.randomUUID()}`,
    title: input.title ?? input.name ?? input.goal ?? input.prompt ?? "Untitled goal",
    description: input.description ?? input.details ?? null,
    status: input.status ?? "active",
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    metadata: input.metadata ?? {}
  };
  return (await store.writePreferences({ activeGoal: goal })).activeGoal;
}

async function clearGoalRpc(store) {
  await store.writePreferences({ activeGoal: null });
  return null;
}

function getLoopRpc(preferences = {}, input = {}) {
  const id = input.id ?? input.loopId ?? input;
  return (preferences.loopDefinitions ?? []).find((loop) => loop.id === id) ?? null;
}

function loopRunsRpc(preferences = {}, input = {}) {
  const loopId = input.loopId ?? input.id ?? null;
  const status = input.status ?? null;
  return (preferences.loopRuns ?? []).filter((run) =>
    (!loopId || run.loopId === loopId || run.id === loopId) &&
    (!status || run.status === status)
  );
}

async function designLoopRpc(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const loop = {
    id: input.id ?? input.loopId ?? `loop_${crypto.randomUUID()}`,
    name: input.name ?? input.title ?? "Untitled loop",
    goal: input.goal ?? input.prompt ?? preferences.activeGoal?.title ?? null,
    steps: Array.isArray(input.steps) ? input.steps : [],
    status: input.status ?? "draft",
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    metadata: input.metadata ?? {}
  };
  const current = preferences.loopDefinitions ?? [];
  const loopDefinitions = current.some((item) => item.id === loop.id)
    ? current.map((item) => item.id === loop.id ? { ...item, ...loop } : item)
    : [loop, ...current];
  await store.writePreferences({ loopDefinitions });
  return loop;
}

async function startLoopRpc({ store, input = {} }) {
  const preferences = rpcPreferences(await store.readPreferences());
  const workspaceRecord = await store.getWorkspace();
  const loop = input.loopId || input.id ? getLoopRpc(preferences, input.loopId ?? input.id) : null;
  const now = new Date().toISOString();
  const goalText = input.goal ?? input.prompt ?? loop?.goal ?? preferences.activeGoal?.title ?? "Loop run";
  const session = createSession({
    workspaceId: workspaceRecord.id,
    prompt: goalText,
    name: input.name ?? loop?.name ?? "Loop run"
  });
  session.metadata = { ...(session.metadata ?? {}), kind: "loop", loopId: loop?.id ?? input.loopId ?? null };
  await store.saveSession(session);
  const run = {
    id: input.runId ?? `loop_run_${crypto.randomUUID()}`,
    loopId: loop?.id ?? input.loopId ?? null,
    status: "running",
    goal: goalText,
    sessionId: session.id,
    startedAt: now,
    updatedAt: now,
    events: [],
    actions: []
  };
  const loopRuns = [run, ...(preferences.loopRuns ?? [])].slice(0, 100);
  await store.writePreferences({ loopRuns });
  return { ok: true, run, session: sessionForRpc(session), loop };
}

async function loopActionRpc(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const runId = required(input.runId ?? input.id, "runId");
  const now = new Date().toISOString();
  const action = {
    id: input.actionId ?? `loop_action_${crypto.randomUUID()}`,
    type: input.type ?? input.action ?? "update",
    status: input.status ?? "recorded",
    payload: input.payload ?? input.data ?? null,
    createdAt: now
  };
  const loopRuns = (preferences.loopRuns ?? []).map((run) => run.id === runId
    ? { ...run, status: input.runStatus ?? run.status, actions: [...(run.actions ?? []), action], updatedAt: now }
    : run);
  await store.writePreferences({ loopRuns });
  return { ok: true, run: loopRuns.find((run) => run.id === runId) ?? null, action };
}

async function loopEventRpc(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const event = {
    id: input.eventId ?? `loop_event_${crypto.randomUUID()}`,
    runId: input.runId ?? null,
    loopId: input.loopId ?? null,
    type: input.type ?? input.event ?? "event",
    payload: input.payload ?? input.data ?? null,
    createdAt: now
  };
  const loopEvents = [event, ...(preferences.loopEvents ?? [])].slice(0, 200);
  const loopRuns = (preferences.loopRuns ?? []).map((run) => run.id === event.runId
    ? { ...run, events: [...(run.events ?? []), event], updatedAt: now }
    : run);
  await store.writePreferences({ loopEvents, loopRuns });
  return { ok: true, event, run: loopRuns.find((run) => run.id === event.runId) ?? null };
}

async function menuCommandRpc({ store, runtime, channel, input = {} }) {
  const preferences = rpcPreferences(await store.readPreferences());
  const command = channel.split(":")[1];
  const now = new Date().toISOString();
  let state = { ...(preferences.menuState ?? {}) };
  let result = { ok: true, command, handledAt: now };
  if (command === "newChat") {
    const workspaceRecord = await store.getWorkspace();
    const session = createSession({
      workspaceId: workspaceRecord.id,
      prompt: input.prompt ?? "",
      name: input.name ?? "New chat"
    });
    await store.saveSession(session);
    result = { ...result, session: sessionForRpc(session) };
  } else if (command === "toggleSidebar") {
    state.sidebarVisible = state.sidebarVisible === false;
    result.sidebarVisible = state.sidebarVisible;
  } else if (command === "toggleFocusMode") {
    state.focusMode = !state.focusMode;
    result.focusMode = state.focusMode;
  } else if (command === "toggleDevTools") {
    state.devToolsOpen = !state.devToolsOpen;
    result.devToolsOpen = state.devToolsOpen;
  } else if (command === "zoomIn" || command === "zoomOut" || command === "zoomReset") {
    const current = Number(state.zoom ?? 1);
    state.zoom = command === "zoomReset" ? 1 : Math.max(0.25, Math.min(3, current + (command === "zoomIn" ? 0.1 : -0.1)));
    result.zoom = state.zoom;
  } else if (["copy", "cut", "paste", "selectAll", "undo", "redo"].includes(command)) {
    result = { ...result, ...menuIntent(command, input, now, "edit") };
  } else if (["newWindow", "about", "keyboardShortcuts", "openSettings", "minimize", "maximize", "quit"].includes(command)) {
    result = { ...result, ...menuIntent(command, input, now, "window") };
  }
  const patch = { menuState: state };
  if (result.intent) patch.menuActions = [result.intent, ...(preferences.menuActions ?? [])].slice(0, 50);
  await store.writePreferences(patch);
  return result;
}

function menuIntent(command, input, now, kind) {
  const intent = {
    id: `menu_action_${crypto.randomUUID()}`,
    command,
    kind,
    input,
    status: "registered",
    mode: "local-intent",
    nativeExecuted: false,
    createdAt: now
  };
  return {
    status: "registered",
    mode: "local-intent",
    nativeExecuted: false,
    intent
  };
}

async function recordSessionControlEvent(store, { channel = "session:event", input = {}, command = null, sessionId = null } = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const event = {
    id: input.eventId ?? input.id ?? `session_event_${crypto.randomUUID()}`,
    sessionId: sessionId ?? input.sessionId ?? input.id ?? (typeof input === "string" ? input : null),
    channel,
    command: command ?? input.command ?? input.type ?? input.event ?? channel.split(":")[1] ?? "event",
    payload: input.payload ?? input.data ?? input,
    status: "recorded",
    mode: "local-state",
    createdAt: now
  };
  const sessionControlEvents = [event, ...(preferences.sessionControlEvents ?? [])].slice(0, 200);
  await store.writePreferences({ sessionControlEvents });
  return { ok: true, sessionId: event.sessionId, command: event.command, status: event.status, mode: event.mode, event };
}

async function sessionFallbackRpc({ store, runtime, channel, input = {}, workspaceWatchers }) {
  const command = channel.split(":")[1];
  const sessionId = input.sessionId ?? input.id ?? (typeof input === "string" ? input : null);
  if (command === "delete" && sessionId) {
    const session = await store.getSession(sessionId);
    const next = { ...session, deleted: true, archived: true, updatedAt: new Date().toISOString() };
    await store.saveSession(next);
    return { ok: true, session: sessionForRpc(next) };
  }
  if (command === "export" || command === "exportRemoteTransfer") {
    const sessions = sessionId ? [await store.getSession(sessionId)] : await store.listSessions();
    return {
      ok: true,
      format: input.format ?? "json",
      sessions: sessions.map(sessionForRpc),
      remoteTransfer: command === "exportRemoteTransfer"
    };
  }
  if (command === "import" || command === "importRemoteTransfer") {
    const workspaceRecord = await store.getWorkspace();
    const source = input.session ?? input;
    const session = createSession({
      workspaceId: workspaceRecord.id,
      prompt: source.prompt ?? source.title ?? "Imported session",
      name: source.name ?? source.title ?? "Imported session",
      labels: source.labels ?? []
    });
    await store.saveSession({ ...session, metadata: { ...(session.metadata ?? {}), imported: true, remoteTransfer: command === "importRemoteTransfer" } });
    return { ok: true, session: sessionForRpc(session) };
  }
  if (command === "getFiles") return workspaceFilesForRpc(runtime.workspace, input);
  if (command === "watchFiles") return { sessionId, ...(await workspaceWatchers.watch(input)) };
  if (command === "unwatchFiles") return { sessionId, ...(await workspaceWatchers.unwatch(input)) };
  if (command === "filesChanged") return { sessionId, ...(await workspaceWatchers.recordManualChange(input)) };
  if (command === "unreadSummaryChanged") return { ok: true, sessionId };
  if (command === "getNotes") return (sessionId ? (await store.getSession(sessionId)).notes : null) ?? "";
  if (command === "setNotes" && sessionId) {
    const session = await store.getSession(sessionId);
    const next = { ...session, notes: String(input.notes ?? input.content ?? ""), updatedAt: new Date().toISOString() };
    await store.saveSession(next);
    return { ok: true, notes: next.notes };
  }
  if (command === "searchContent") return searchWorkspace({ store, query: input.query ?? input.text ?? "" });
  if (command === "getPendingPlanExecution") return { sessionId, pending: false, plan: null };
  if (command === "getPermissionModeState") return { sessionId, mode: "default", pending: [] };
  if (command === "respondToPermission" || command === "respondToCredential") return {
    ok: true,
    sessionId,
    response: input.response ?? input.decision ?? input.action ?? null
  };
  if (command === "command") return recordSessionControlEvent(store, {
    channel,
    input,
    sessionId,
    command: input.command ?? input.name ?? "command"
  });
  return recordSessionControlEvent(store, { channel, input, sessionId, command });
}

async function windowRpc({ store, runtime, channel, input = {} }) {
	  const command = channel.split(":")[1];
	  const preferences = rpcPreferences(await store.readPreferences());
	  const now = new Date().toISOString();
	  const workspaceRecord = await store.getWorkspace();
	  const state = {
	    ...(preferences.windowState ?? {}),
	    mode: "remote",
	    workspace: workspaceClientRecord(workspaceRecord),
	    updatedAt: now
	  };
	  const event = {
	    id: `window_event_${crypto.randomUUID()}`,
	    channel,
	    command,
	    input,
	    nativeWindow: false,
	    mode: "local-window-state",
	    createdAt: now
	  };
	  if (command === "getFocusState" || command === "focusState") {
	    state.focused = command === "focusState" ? Boolean(input.focused ?? input) : state.focused !== false;
	    event.focused = state.focused;
	  } else if (command === "setTrafficLights") {
	    state.trafficLights = input;
	    event.trafficLights = state.trafficLights;
	  } else if (command === "openWorkspace" || command === "switchWorkspace") {
	    const requestedWorkspace = input.slug ?? input.id ?? input.path ?? input;
	    state.requestedWorkspace = requestedWorkspace;
	    state.openedWorkspaces = [{
	      id: `window_workspace_${crypto.randomUUID()}`,
	      request: requestedWorkspace,
	      command,
	      status: "registered",
	      nativeOpened: false,
	      createdAt: now
	    }, ...(state.openedWorkspaces ?? [])].slice(0, 20);
	    event.requestedWorkspace = requestedWorkspace;
	  } else if (command === "openSessionInNewWindow") {
	    const requestedSessionId = input.sessionId ?? input.id ?? input;
	    state.requestedSessionId = requestedSessionId;
	    state.openedSessions = [{
	      id: `window_session_${crypto.randomUUID()}`,
	      sessionId: requestedSessionId,
	      workspaceId: workspaceRecord.id,
	      status: "registered",
	      nativeOpened: false,
	      createdAt: now
	    }, ...(state.openedSessions ?? [])].slice(0, 20);
	    event.requestedSessionId = requestedSessionId;
	  } else if (command === "closeRequested") {
	    state.closeRequested = true;
	    state.closeRequest = { id: event.id, source: input.source ?? null, createdAt: now };
	    event.closeRequested = true;
	  } else if (command === "confirmClose" || command === "close") {
	    state.closeRequested = false;
	    state.closeConfirmed = command === "confirmClose";
	    state.closed = command === "close";
	    state.closeHandledAt = now;
	    event.closeConfirmed = state.closeConfirmed;
	    event.closed = state.closed;
	  } else if (command === "cancelClose") {
	    state.closeRequested = false;
	    state.closeCancelled = true;
	    state.closeHandledAt = now;
	    event.closeCancelled = true;
	  }
	  const windowEvents = [event, ...(preferences.windowEvents ?? [])].slice(0, 100);
	  await store.writePreferences({ windowState: state, windowEvents });
	  return { ok: true, command, nativeWindow: false, mode: event.mode, state, event, events: windowEvents };
	}

async function skillsRpc({ store, workspace, channel, input = {} }) {
  const command = channel.split(":")[1];
  const skills = await discoverSkills({ workspace });
  if (command === "changed") return { ok: true, skills };
  if (command === "getFiles") return workspaceFilesForRpc(workspace, input.path ? input : { path: ".agents/skills" });
  if (command === "delete") return deleteSkillRpc({ store, workspace, input, skills });
  if (command === "openEditor" || command === "openFinder") return openSkillTargetRpc({ store, workspace, command, input, skills });
  return { ok: true, command, skills };
}

async function deleteSkillRpc({ store, workspace, input = {}, skills = [] }) {
  const target = input.path ?? input.filePath ?? input.id ?? input.slug ?? input.name ?? input;
  const skill = skills.find((item) =>
    item.slug === target ||
    item.id === target ||
    item.name === target ||
    item.metadata?.name === target ||
    item.path === target
  ) ?? null;
  const requestedPath = skill ? pathModule.dirname(skill.path) : required(target, "skill");
  const absolutePath = resolveInsideWorkspace(workspace, requestedPath);
  const relativePath = pathModule.relative(workspace, absolutePath) || ".";
  if (!isWorkspaceSkillPath(relativePath)) {
    return { ok: false, deleted: false, reason: "skill_path_not_workspace_local", target: relativePath };
  }
  const info = await stat(absolutePath);
  const now = new Date();
  const archiveRoot = resolveInsideWorkspace(workspace, ".peng/deleted-skills");
  await mkdir(archiveRoot, { recursive: true });
  const archiveName = `${now.toISOString().replace(/[:.]/g, "-")}-${safeFileName(pathModule.basename(absolutePath))}`;
  const archivePath = pathModule.join(archiveRoot, archiveName);
  await rename(absolutePath, archivePath);
  const intent = {
    id: `skill_delete_${crypto.randomUUID()}`,
    skillId: skill?.slug ?? input.id ?? input.slug ?? input.name ?? null,
    target: relativePath,
    archivedPath: pathModule.relative(workspace, archivePath),
    type: info.isDirectory() ? "directory" : "file",
    mode: "workspace-local-soft-delete",
    createdAt: now.toISOString()
  };
  const preferences = rpcPreferences(await store.readPreferences());
  await store.writePreferences({ skillDeleteIntents: [intent, ...(preferences.skillDeleteIntents ?? [])].slice(0, 50) });
  return {
    ok: true,
    deleted: true,
    softDeleted: true,
    nativeDeleted: false,
    skill,
    target: relativePath,
    archivedPath: intent.archivedPath,
    intent
  };
}

function isWorkspaceSkillPath(relativePath) {
  const normalized = relativePath.split(pathModule.sep).join("/");
  return /^(\.craft-agent|\.agents)\/skills\/[^/]+(?:\/.*)?$/.test(normalized);
}

async function openSkillTargetRpc({ store, workspace, command, input = {}, skills = [] }) {
  const target = input.path ?? input.filePath ?? input.id ?? input.name ?? input;
  const skill = skills.find((item) => item.id === target || item.name === target || item.path === target) ?? null;
  const requestedPath = skill?.path ?? target ?? ".agents/skills";
  const absolutePath = resolveInsideWorkspace(workspace, requestedPath);
  let fileInfo = null;
  try {
    const info = await stat(absolutePath);
    fileInfo = {
      exists: true,
      type: info.isDirectory() ? "directory" : "file",
      size: info.size,
      updatedAt: info.mtime.toISOString()
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fileInfo = { exists: false, type: null, size: 0, updatedAt: null };
  }
  const intent = {
    id: `skill_open_${crypto.randomUUID()}`,
    command,
    mode: command === "openFinder" ? "folder" : "editor",
    target: pathModule.relative(workspace, absolutePath) || ".",
    skillId: skill?.id ?? null,
    fileInfo,
    createdAt: new Date().toISOString()
  };
  const preferences = rpcPreferences(await store.readPreferences());
  await store.writePreferences({ skillOpenIntents: [intent, ...(preferences.skillOpenIntents ?? [])].slice(0, 50) });
  return {
    ok: true,
    opened: true,
    nativeOpened: false,
    mode: "workspace-local",
    intent,
    target: intent.target,
    skill,
    fileInfo
  };
}

async function themeRpc(store, channel, input = {}) {
  const command = channel.split(":")[1];
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const skins = [...(preferences.themeSkins ?? [])];
  let nextSkins = skins;
  let selected = null;
  if (command === "createSkin" || command === "duplicateSkin") {
    const source = skins.find((skin) => skin.id === (input.id ?? input.sourceId));
    selected = {
      ...(source ?? {}),
      ...(input.skin ?? input),
      id: input.newId ?? input.id ?? `skin_${crypto.randomUUID()}`,
      name: input.name ?? source?.name ?? "Custom skin",
      createdAt: now,
      updatedAt: now
    };
    nextSkins = [selected, ...skins.filter((skin) => skin.id !== selected.id)];
  } else if (command === "updateSkin") {
    const id = input.id ?? input.skin?.id;
    nextSkins = skins.map((skin) => skin.id === id ? { ...skin, ...(input.skin ?? input), id, updatedAt: now } : skin);
    selected = nextSkins.find((skin) => skin.id === id) ?? null;
  } else if (command === "deleteSkin") {
    const id = input.id ?? input.skinId ?? input;
    nextSkins = skins.filter((skin) => skin.id !== id);
  }
  await store.writePreferences({ themeSkins: nextSkins, themeLastEvent: { command, input, createdAt: now } });
  if (command.endsWith("Changed")) return { ok: true, command, event: input };
  return { ok: true, command, skin: selected, skins: nextSkins, themes: resourceManifest().themes };
}

async function gitMutationRpc(workspace, channel, input = {}) {
  const command = channel.split(":")[1];
  if (command === "stage") return gitStage({ cwd: workspace, pathspecs: input.paths ?? input.pathspecs ?? input.path });
  if (command === "unstage") return gitUnstage({ cwd: workspace, pathspecs: input.paths ?? input.pathspecs ?? input.path });
  if (command === "discard") return gitDiscard({ cwd: workspace, pathspecs: input.paths ?? input.pathspecs ?? input.path });
  if (command === "commit") return gitCommit({ cwd: workspace, message: input.message ?? input.summary ?? input });
  if (command === "createBranch") return gitCreateBranch({
    cwd: workspace,
    name: input.name ?? input.branch ?? input,
    startPoint: input.startPoint ?? input.from ?? null,
    checkout: input.checkout === true
  });
  if (command === "switchBranch") return gitSwitchBranch({ cwd: workspace, name: input.name ?? input.branch ?? input });
  if (command === "deleteBranch") return gitDeleteBranch({ cwd: workspace, name: input.name ?? input.branch ?? input, force: input.force === true });
  if (command === "merge") return gitMerge({ cwd: workspace, name: input.name ?? input.branch ?? input });
  if (command === "fetch") return gitFetch({ cwd: workspace, remote: input.remote ?? null });
  if (command === "pull") return gitPull({ cwd: workspace, remote: input.remote ?? null, branch: input.branch ?? null });
  if (command === "push") return gitPush({ cwd: workspace, remote: input.remote ?? null, branch: input.branch ?? null, setUpstream: input.setUpstream === true });
  if (command === "saveStash") return gitSaveStash({ cwd: workspace, message: input.message ?? null, includeUntracked: input.includeUntracked === true });
  if (command === "applyStash") return gitApplyStash({ cwd: workspace, ref: input.ref ?? input.stash ?? input.id ?? "stash@{0}", pop: input.pop === true });
  if (command === "dropStash") return gitDropStash({ cwd: workspace, ref: input.ref ?? input.stash ?? input.id ?? "stash@{0}" });
  if (command === "addWorktree") return gitAddWorktree({ cwd: workspace, worktreePath: input.path ?? input.worktreePath, branch: input.branch ?? null });
  if (command === "removeWorktree") return gitRemoveWorktree({ cwd: workspace, worktreePath: input.path ?? input.worktreePath, force: input.force === true });
  if (command === "generateCommitMessage") return { ok: true, message: await gitGenerateCommitMessage({ cwd: workspace }) };
  return { ok: false, reason: "git_rpc_unknown", command };
}

async function shellCommandRpc({ store, runtime, channel, input = {} }) {
  const command = channel.split(":")[1];
  const target = input.url ?? input.path ?? input.file ?? input.target ?? (typeof input === "string" ? input : null);
  const now = new Date().toISOString();
  const action = {
    id: `shell_action_${crypto.randomUUID()}`,
    command,
    target,
    status: "registered",
    kind: target && /^https?:\/\//i.test(String(target)) ? "url" : "workspace-path",
    executed: false,
    nativeExecuted: false,
    mode: "local-intent",
    createdAt: now
  };
  if ((command === "openFile" || command === "showInFolder") && target) {
    action.path = pathModule.relative(runtime.workspace, resolveInsideWorkspace(runtime.workspace, target)) || ".";
  }
  if (command === "openUrl" && target) {
    action.url = String(target);
  }
  const preferences = rpcPreferences(await store.readPreferences());
  await store.writePreferences({ shellActions: [action, ...(preferences.shellActions ?? [])].slice(0, 50) });
  return action;
}

async function authLogoutRpc(store) {
  const state = {
    authenticated: false,
    status: "signed_out",
    loggedOutAt: new Date().toISOString()
  };
  await store.writePreferences({ authState: state });
  return state;
}

async function authDialogRpc(store, channel, input = {}) {
  const dialog = {
    id: `auth_dialog_${crypto.randomUUID()}`,
    type: channel.split(":")[1],
    title: input.title ?? null,
    message: input.message ?? null,
    shown: true,
    createdAt: new Date().toISOString()
  };
  const preferences = rpcPreferences(await store.readPreferences());
  await store.writePreferences({ authDialogs: [dialog, ...(preferences.authDialogs ?? [])].slice(0, 20) });
  return dialog;
}

async function dialogOpenFolderRpc(workspace, input = {}) {
  const root = input.defaultPath ?? input.path ?? ".";
  const directoryPath = resolveInsideWorkspace(workspace, root);
  const directoryStat = await stat(directoryPath);
  const selectedPath = directoryStat.isDirectory() ? directoryPath : pathModule.dirname(directoryPath);
  const entries = await listWorkspaceDirectory(workspace, pathModule.relative(workspace, selectedPath) || ".");
  const folders = entries.filter((entry) => entry.type === "directory");
  return {
    ok: true,
    cancelled: false,
    path: pathModule.relative(workspace, selectedPath) || ".",
    selected: pathModule.relative(workspace, selectedPath) || ".",
    folders,
    entries: folders,
    mode: "workspace-local"
  };
}

async function deeplinkNavigateRpc(store, input = {}) {
  const deeplink = {
    id: `deeplink_${crypto.randomUUID()}`,
    route: input.route ?? input.url ?? input.path ?? (typeof input === "string" ? input : null),
    payload: input.payload ?? input.params ?? null,
    createdAt: new Date().toISOString()
  };
  const preferences = rpcPreferences(await store.readPreferences());
  await store.writePreferences({ deeplinks: [deeplink, ...(preferences.deeplinks ?? [])].slice(0, 50) });
  return { ok: true, deeplink };
}

async function notificationRpc(store, channel, input = {}) {
  const command = channel.split(":")[1];
  const preferences = rpcPreferences(await store.readPreferences());
  const createdAt = new Date().toISOString();
  const route = input.route ?? input.url ?? input.path ?? (typeof input === "string" ? input : null);
  const event = {
    id: input.id ?? `notification_${crypto.randomUUID()}`,
    command,
    title: input.title ?? input.name ?? null,
    body: input.body ?? input.message ?? input.text ?? null,
    route,
    payload: input.payload ?? input.data ?? input.params ?? null,
    status: "recorded",
    mode: "local-state",
    nativeExecuted: false,
    enabled: preferences.notificationsEnabled !== false,
    createdAt
  };
  const notificationEvents = [event, ...(preferences.notificationEvents ?? [])].slice(0, 100);
  await store.writePreferences({ notificationEvents });
  return {
    ok: true,
    route,
    status: event.status,
    mode: event.mode,
    nativeExecuted: event.nativeExecuted,
    enabled: event.enabled,
    event
  };
}

async function recordRpcEvent(store, channel, input = {}, overrides = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const [domain, eventName = "event"] = channel.split(":");
  const event = {
    id: input.id ?? input.eventId ?? `rpc_event_${crypto.randomUUID()}`,
    channel,
    domain,
    event: overrides.event ?? input.event ?? input.type ?? eventName,
    payload: input.payload ?? input.data ?? input,
    status: "recorded",
    mode: "local-state",
    createdAt: new Date().toISOString()
  };
  const rpcEvents = [event, ...(preferences.rpcEvents ?? [])].slice(0, 200);
  await store.writePreferences({ rpcEvents });
  return { ok: true, status: event.status, mode: event.mode, event };
}

async function debugLogRpc(store, input = {}) {
  const entry = {
    id: `debug_${crypto.randomUUID()}`,
    level: input.level ?? "info",
    message: input.message ?? input.text ?? String(input ?? ""),
    data: input.data ?? null,
    createdAt: new Date().toISOString()
  };
  const preferences = rpcPreferences(await store.readPreferences());
  await store.writePreferences({ debugLogs: [entry, ...(preferences.debugLogs ?? [])].slice(0, 100) });
  return { ok: true, entry };
}

async function terminalRecordCommandRpc({ store, runtime, input = {} }) {
  const workspaceRecord = await store.getWorkspace();
  const command = typeof input === "string" ? input : input.command ?? input.text ?? input.value;
  const now = new Date().toISOString();
  const record = createTerminalRecord({
    workspaceId: workspaceRecord.id,
    sessionId: typeof input === "object" ? input.sessionId ?? null : null,
    command: required(command, "command"),
    cwd: typeof input === "object" ? input.cwd ?? runtime.workspace : runtime.workspace,
    shell: typeof input === "object" ? input.shell ?? null : null,
    dimensions: typeof input === "object" ? input.dimensions : undefined,
    status: "completed",
    exitCode: typeof input === "object" && input.exitCode !== undefined ? input.exitCode : 0,
    output: typeof input === "object" ? input.output ?? "" : "",
    startedAt: typeof input === "object" ? input.startedAt ?? now : now,
    endedAt: typeof input === "object" ? input.endedAt ?? now : now
  });
  await store.saveTerminalRecord(record);
  const preferences = rpcPreferences(await store.readPreferences());
  const frequentCommands = frequentTerminalCommands(await store.listTerminalHistory(), preferences.terminalHiddenFrequentCommands ?? []);
  return { ok: true, recorded: record, frequentCommands };
}

async function terminalFrequentCommandRpc(store, channel, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const command = input.command ?? input.text ?? input.value ?? (typeof input === "string" ? input : null);
  const current = new Set(preferences.terminalHiddenFrequentCommands ?? []);
  if (channel === "terminal:clearFrequent") {
    for (const item of frequentTerminalCommands(await store.listTerminalHistory(), [])) current.add(item.command);
  } else if (command) {
    current.add(String(command).trim());
  }
  const terminalHiddenFrequentCommands = [...current].filter(Boolean).sort();
  await store.writePreferences({ terminalHiddenFrequentCommands });
  return {
    ok: true,
    command: command ?? null,
    hiddenCommands: terminalHiddenFrequentCommands,
    frequentCommands: frequentTerminalCommands(await store.listTerminalHistory(), terminalHiddenFrequentCommands)
  };
}

async function credentialsHealthRpc(store) {
  const credentials = await store.listCredentialSummaries();
  const storage = store.credentialStorageInfo();
  return {
    ok: true,
    credentialCount: credentials.length,
    credentials,
    storage
  };
}

async function resourcesExportRpc(workspace, input = {}) {
  const manifest = resourceManifest();
  const target = input.path ?? input.out ?? pathModule.join(".peng", "resource-exports", "resource-manifest.json");
  const targetPath = resolveInsideWorkspace(workspace, target);
  await mkdir(pathModule.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    ok: true,
    manifest,
    target: pathModule.relative(workspace, targetPath) || ".",
    exported: true,
    byteCount: Buffer.byteLength(JSON.stringify(manifest, null, 2) + "\n")
  };
}

async function resourcesImportRpc(workspace, input = {}) {
  const out = input.out ?? input.path ?? "resources";
  const source = input.from ?? input.source ?? pathModule.join(projectRoot, "resources");
  const webuiSource = input.webuiFrom ?? pathModule.join(projectRoot, "resources", "webui");
  const args = [
    "--out", resolveInsideWorkspace(workspace, out),
    "--from", source,
    ...(input.includeWebui === true ? ["--include-webui"] : []),
    ...(input.webuiOnly === true ? ["--webui-only"] : []),
    ...(input.includeWebui === true || input.webuiOnly === true ? ["--webui-from", webuiSource] : []),
    ...(input.toolIconsOnly === true ? ["--tool-icons-only"] : []),
    ...(input.themesOnly === true ? ["--themes-only"] : []),
    ...(input.docsOnly === true ? ["--docs-only"] : []),
    ...(input.helpersOnly === true ? ["--helpers-only"] : []),
    ...(input.dryRun === true ? ["--dry-run"] : []),
    ...(input.noClean === true ? ["--no-clean"] : [])
  ];
  const result = await importPengResources({ args, cwd: workspace });
  return {
    ok: true,
    imported: result.dryRun !== true,
    dryRun: result.dryRun === true,
    source: result.sourceRoot,
    outputRoot: pathModule.relative(workspace, result.outputRoot) || ".",
    includeWebui: input.includeWebui === true || input.webuiOnly === true,
    manifest: result
  };
}

function gitbashCheckRpc(preferences = {}) {
  const configuredPath = preferences.gitbashPath ?? null;
  const platform = process.platform;
  return {
    available: platform === "win32" && Boolean(configuredPath),
    platform,
    path: configuredPath,
    status: configuredPath ? "configured" : "unconfigured",
    reason: platform === "win32" ? null : "git_bash_is_windows_only"
  };
}

async function gitbashSetPathRpc(store, input = {}) {
  const gitbashPath = input.path ?? input.gitbashPath ?? (typeof input === "string" ? input : null);
  const saved = rpcPreferences(await store.writePreferences({ gitbashPath }));
  return gitbashCheckRpc(saved);
}

async function gitbashBrowseRpc(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const candidates = [
    input.path ?? input.defaultPath ?? null,
    preferences.gitbashPath,
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe"
  ].filter(Boolean);
  const selected = candidates[0] ?? null;
  const intent = {
    id: `gitbash_browse_${crypto.randomUUID()}`,
    selected,
    candidates,
    platform: process.platform,
    createdAt: new Date().toISOString(),
    mode: "local-state"
  };
  const next = await store.writePreferences({
    gitbashPath: selected ?? preferences.gitbashPath ?? null,
    gitbashBrowseIntents: [intent, ...(preferences.gitbashBrowseIntents ?? [])].slice(0, 20)
  });
  return {
    ...gitbashCheckRpc(rpcPreferences(next)),
    ok: true,
    cancelled: selected == null,
    selected,
    candidates,
    intent,
    nativeOpened: false,
    mode: "local-state"
  };
}

async function genericOauthStartRpc(store, input = {}) {
  const now = new Date().toISOString();
  const session = {
    id: `oauth_${crypto.randomUUID()}`,
    provider: input.provider ?? input.sourceSlug ?? "generic",
    status: "pending",
    authorizationUrl: input.url ?? null,
    state: input.state ?? crypto.randomBytes(8).toString("hex"),
    createdAt: now
  };
  const preferences = rpcPreferences(await store.readPreferences());
  await store.writePreferences({ oauthSessions: [session, ...(preferences.oauthSessions ?? [])].slice(0, 50) });
  return session;
}

async function genericOauthRevokeRpc(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const id = input.id ?? input.sessionId ?? input.provider ?? input.sourceSlug ?? null;
  const now = new Date().toISOString();
  const oauthSessions = (preferences.oauthSessions ?? []).map((session) =>
    !id || session.id === id || session.provider === id ? { ...session, status: "revoked", revokedAt: now } : session
  );
  await store.writePreferences({ oauthSessions });
  return { ok: true, revoked: id, sessions: oauthSessions };
}

async function badgeRpc(store, channel, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const command = channel.split(":")[1];
  const now = new Date().toISOString();
  let badgeState = { ...(preferences.badgeState ?? {}), updatedAt: now };
  if (command === "setIcon") {
    badgeState.icon = input.icon ?? input.path ?? input.name ?? null;
  } else if (command === "draw" || command === "draw-windows") {
    badgeState = {
      ...badgeState,
      count: Number(input.count ?? input.badge ?? badgeState.count ?? 0),
      text: input.text ?? input.label ?? badgeState.text ?? null,
      platform: command === "draw-windows" ? "windows" : process.platform
    };
  } else if (command === "refresh") {
    badgeState.refreshedAt = now;
  }
  const event = {
    id: `badge_${crypto.randomUUID()}`,
    command,
    badge: badgeState,
    input,
    createdAt: now,
    mode: "local-state"
  };
  const badgeEvents = [event, ...(preferences.badgeEvents ?? [])].slice(0, 50);
  await store.writePreferences({ badgeState, badgeEvents });
  return {
    ok: true,
    command,
    badge: badgeState,
    event,
    events: badgeEvents,
    applied: true,
    nativeApplied: false,
    mode: "local-state"
  };
}

async function saveLlmConnection(store, input = {}, options = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const connection = normalizeLlmConnectionSetup(input);
  const current = normalizedLlmConnections(preferences);
  const next = current.some((item) => item.id === connection.id)
    ? current.map((item) => item.id === connection.id ? { ...item, ...connection } : item)
    : [connection, ...current];
  const defaultId = options.setDefault ? connection.id : preferences.defaultLlmConnectionId ?? preferences.llmConnection?.id ?? connection.id;
  const saved = rpcPreferences(await store.writePreferences({
    llmConnection: connection.id === defaultId ? connection : preferences.llmConnection ?? connection,
    llmConnections: next,
    defaultLlmConnectionId: defaultId
  }));
  return {
    ok: true,
    connection: getLlmConnection(saved, connection.id),
    connections: normalizedLlmConnections(saved),
    defaultId: saved.defaultLlmConnectionId
  };
}

async function deleteLlmConnection(store, connectionId) {
  const id = required(connectionId, "connectionId");
  const preferences = rpcPreferences(await store.readPreferences());
  const next = normalizedLlmConnections(preferences).filter((connection) => connection.id !== id);
  const defaultId = preferences.defaultLlmConnectionId === id ? next[0]?.id ?? null : preferences.defaultLlmConnectionId;
  const workspaceDefaultId = preferences.workspaceDefaultLlmConnectionId === id ? null : preferences.workspaceDefaultLlmConnectionId;
  const llmConnection = preferences.llmConnection?.id === id ? next.find((connection) => connection.id === defaultId) ?? null : preferences.llmConnection;
  const saved = rpcPreferences(await store.writePreferences({
    llmConnections: next,
    llmConnection,
    defaultLlmConnectionId: defaultId,
    workspaceDefaultLlmConnectionId: workspaceDefaultId
  }));
  return { ok: true, deletedId: id, connections: normalizedLlmConnections(saved), defaultId: saved.defaultLlmConnectionId };
}

async function setDefaultLlmConnection(store, connectionId) {
  const id = required(connectionId, "connectionId");
  const preferences = rpcPreferences(await store.readPreferences());
  const connection = getLlmConnection(preferences, id);
  if (!connection) return { ok: false, reason: "llm_connection_not_found", id };
  const saved = rpcPreferences(await store.writePreferences({ defaultLlmConnectionId: id, llmConnection: connection }));
  return { ok: true, connection: getLlmConnection(saved, id), defaultId: id };
}

async function setWorkspaceDefaultLlmConnection(store, connectionId) {
  const id = required(connectionId, "connectionId");
  const preferences = rpcPreferences(await store.readPreferences());
  const connection = getLlmConnection(preferences, id);
  if (!connection) return { ok: false, reason: "llm_connection_not_found", id };
  const saved = rpcPreferences(await store.writePreferences({ workspaceDefaultLlmConnectionId: id }));
  return { ok: true, connection: getLlmConnection(saved, id), workspaceDefaultId: saved.workspaceDefaultLlmConnectionId };
}

async function testLlmConnectionSetup(input = {}, runtime) {
  const connection = normalizeLlmConnectionSetup(input);
  const provider = {
    ...providerProfileFromId(connection.provider),
    baseUrl: connection.baseUrl ?? undefined,
    type: connection.type
  };
  const request = planModelFetchRequest({ provider, apiKey: input.apiKey, useOllamaTags: input.useOllamaTags === true });
  let envelope;
  if (!input.apiKey && provider.id !== "ollama") {
    envelope = {
      ok: false,
      status: "needs_credentials",
      connection,
      request,
      models: [],
      error: "api key is required to test this provider"
    };
    await recordLlmConnectionTest(runtime.store, envelope);
    return envelope;
  }
  const result = await fetchProviderModels({
    provider,
    apiKey: input.apiKey,
    useOllamaTags: input.useOllamaTags === true,
    timeoutMs: input.timeoutMs ?? 5_000,
    fetchImpl: runtime.fetchImpl
  });
  envelope = { ok: result.ok, status: result.ok ? "connected" : "failed", connection, request, models: result.models, error: result.error ?? null };
  await recordLlmConnectionTest(runtime.store, envelope);
  return envelope;
}

async function recordLlmConnectionTest(store, envelope) {
  const preferences = rpcPreferences(await store.readPreferences());
  const event = {
    id: `llm_test_${crypto.randomUUID()}`,
    connectionId: envelope.connection.id,
    provider: envelope.connection.provider,
    status: envelope.status,
    ok: envelope.ok,
    modelCount: envelope.models?.length ?? 0,
    error: envelope.error ?? null,
    request: {
      ...envelope.request,
      headers: redactHeaders(envelope.request.headers ?? {})
    },
    createdAt: new Date().toISOString()
  };
  await store.writePreferences({ llmConnectionTests: [event, ...(preferences.llmConnectionTests ?? [])].slice(0, 100) });
  return event;
}

function redactHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) =>
    /authorization|api[-_]?key|x-api-key/i.test(key) ? [key, value ? "***" : value] : [key, value]));
}

async function piProviderModels(input = {}, runtime) {
  const providerId = input.provider ?? input.providerId ?? input.id ?? input.profile ?? "openai-compatible";
  const provider = {
    ...providerProfileFromId(providerId),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.type ? { type: input.type } : {})
  };
  if (input.planOnly === true || (!input.apiKey && provider.id !== "ollama")) {
    const request = planModelFetchRequest({ provider, apiKey: input.apiKey, useOllamaTags: input.useOllamaTags === true });
    return { ok: true, provider: provider.id, models: [], count: 0, request };
  }
  return fetchProviderModels({
    provider,
    apiKey: input.apiKey,
    useOllamaTags: input.useOllamaTags === true,
    timeoutMs: input.timeoutMs ?? 5_000,
    fetchImpl: runtime.fetchImpl
  });
}

function onboardingAuthState(preferences) {
  const sessions = preferences.onboardingOAuthSessions ?? [];
  const latestClaude = sessions.find((session) => session.provider === "claude") ?? null;
  const authenticated = Boolean(preferences.llmConnection?.provider || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
  const deferred = Boolean(preferences.onboardingDeferred);
  return {
    authenticated,
    deferred,
    setupNeeds: {
      needsBillingConfig: !authenticated,
      needsCredentials: !authenticated,
      isFullyConfigured: authenticated || deferred
    },
    claudeOAuth: {
      available: true,
      hasState: Boolean(preferences.claudeOAuthState),
      state: preferences.claudeOAuthState ?? null,
      latest: latestClaude,
      status: latestClaude?.status ?? "idle",
      mode: "local-state"
    },
    oauthSessions: sessions,
    llmConnection: preferences.llmConnection,
    provider: preferences.llmConnection?.provider ?? describeProvider({}).profile
  };
}

async function startOnboardingOAuth(store, command, input = {}) {
  const provider = command === "startMcpOAuth" ? input.provider ?? input.sourceSlug ?? "mcp" : "claude";
  const now = new Date().toISOString();
  const state = input.state ?? crypto.randomBytes(12).toString("hex");
  const session = {
    id: `onboarding_oauth_${crypto.randomUUID()}`,
    provider,
    command,
    status: "pending",
    authorizationUrl: input.url ?? input.authorizationUrl ?? onboardingAuthorizationUrl(provider, state),
    state,
    codeVerifier: input.codeVerifier ?? null,
    redirectUri: input.redirectUri ?? null,
    mode: "local-state",
    createdAt: now,
    updatedAt: now
  };
  const preferences = rpcPreferences(await store.readPreferences());
  const patch = {
    onboardingOAuthSessions: [session, ...(preferences.onboardingOAuthSessions ?? [])].slice(0, 50)
  };
  if (provider === "claude") patch.claudeOAuthState = state;
  await store.writePreferences(patch);
  return session;
}

async function exchangeOnboardingClaudeCode(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const code = input.code ?? input.authorizationCode ?? input;
  const state = input.state ?? preferences.claudeOAuthState ?? null;
  const now = new Date().toISOString();
  const sessions = preferences.onboardingOAuthSessions ?? [];
  const index = sessions.findIndex((session) => session.provider === "claude" && (!state || session.state === state));
  const exchanged = {
    ...(index === -1 ? { id: `onboarding_oauth_${crypto.randomUUID()}`, provider: "claude", command: "exchangeClaudeCode", createdAt: now } : sessions[index]),
    status: "exchanged",
    code: redactCode(code),
    state,
    exchangedAt: now,
    updatedAt: now,
    mode: "local-state"
  };
  const nextSessions = index === -1
    ? [exchanged, ...sessions]
    : sessions.map((session, sessionIndex) => sessionIndex === index ? exchanged : session);
  await store.writePreferences({
    claudeOAuthState: state,
    onboardingOAuthSessions: nextSessions.slice(0, 50)
  });
  return {
    ok: true,
    status: "exchanged",
    provider: "claude",
    session: exchanged,
    mode: "local-state"
  };
}

function onboardingAuthorizationUrl(provider, state) {
  const base = provider === "claude" ? "https://claude.ai/oauth/authorize" : "https://mcp.local/oauth/authorize";
  const url = new URL(base);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

function redactCode(code) {
  const value = String(code ?? "");
  if (!value) return null;
  return value.length <= 4 ? "***" : `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function sessionModel(session, preferences = {}) {
  const model = session.model ?? session.llmConnection ?? preferences.llmConnection?.model ?? null;
  return {
    sessionId: session.id,
    model,
    connection: session.llmConnection ?? preferences.llmConnection ?? null
  };
}

function workspaceSettings(workspace, preferences = {}) {
  return {
    workspaceId: workspace.id,
    root: workspace.root,
    name: workspace.name,
    config: workspace.config ?? {},
    preferences: {
      llmConnection: preferences.llmConnection,
      memoryEnabled: preferences.memoryEnabled,
      defaultThinkingLevel: workspace.config?.thinkingLevel ?? mergeConfig().workspaceDefaults.thinkingLevel
    },
    updatedAt: workspace.updatedAt
  };
}

function observabilityProfile(preferences = {}) {
	  return {
	    enabled: Boolean(preferences.observabilityEmitEnabled),
	    profile: preferences.observabilityProfile ?? "local",
	    endpoint: preferences.observabilityEndpoint ?? null
	  };
	}

async function buildSessionTrace(store, sessionId = null) {
  const id = sessionId ?? null;
  const events = id ? await store.listProtocolEvents({ threadId: id }) : await store.listProtocolEvents();
  const subject = id ? await readTraceSubject(store, id) : null;
  const spans = events.map((event) => ({
    id: event.id,
    type: event.type,
    threadId: event.threadId,
    step: event.step ?? null,
    sequence: event.sequence ?? null,
    startedAt: event.createdAt,
    endedAt: event.createdAt,
    status: traceStatus(event),
    payload: event.payload ?? {}
  }));
  return {
    sessionId: id,
    threadId: id,
    status: subject?.status ?? subject?.statusId ?? (spans.length ? "recorded" : "missing"),
    title: subject?.title ?? subject?.name ?? null,
    eventCount: events.length,
    events,
    spans,
    startedAt: events[0]?.createdAt ?? subject?.createdAt ?? null,
    endedAt: events.at(-1)?.createdAt ?? subject?.updatedAt ?? null,
    mode: "local-protocol-events"
  };
}

async function buildSessionUsage(store, sessionId = null) {
  const id = sessionId ?? null;
  const subject = id ? await readTraceSubject(store, id) : null;
  const events = id ? await store.listProtocolEvents({ threadId: id }) : await store.listProtocolEvents();
  const messages = subject?.events ?? [];
  const inputText = messages.filter((event) => event.role === "user" || event.type === "UserPromptSubmit").map((event) => event.content ?? event.prompt ?? "").join("\n");
  const outputText = messages.filter((event) => event.role === "assistant" || event.type === "AssistantMessage").map((event) => event.content ?? event.text ?? "").join("\n");
  const toolText = messages.filter((event) => event.role === "tool_call" || event.role === "tool_result" || event.type === "ToolCall" || event.type === "ToolResult").map((event) => event.content ?? event.result ?? "").join("\n");
  const inputTokens = estimateTokenCount(inputText);
  const outputTokens = estimateTokenCount(outputText);
  const toolTokens = estimateTokenCount(toolText);
  const totalTokens = inputTokens + outputTokens + toolTokens;
  return {
    sessionId: id,
    threadId: id,
    inputTokens,
    outputTokens,
    toolTokens,
    totalTokens,
    messageCount: messages.length,
    eventCount: events.length,
    completedRuns: events.filter((event) => event.type === "run.completed").length,
    failedRuns: events.filter((event) => event.type === "run.failed").length,
    stoppedRuns: events.filter((event) => event.type === "run.stopped").length,
    mode: "estimated-local"
  };
}

async function readTraceSubject(store, id) {
  try {
    return await store.getThread(id);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    return await store.getSession(id);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

async function buildUsageQuota(store) {
  const threads = await store.listThreads();
  const sessions = await store.listSessions();
  const ids = [...new Set([...threads.map((thread) => thread.id), ...sessions.map((session) => session.id)])];
  const usages = await Promise.all(ids.map((id) => buildSessionUsage(store, id)));
  const used = usages.reduce((sum, usage) => sum + usage.totalTokens, 0);
  return {
    unlimited: true,
    used,
    remaining: null,
    resetAt: null,
    sessionCount: usages.length,
    threadCount: threads.length,
    sessions: usages,
    mode: "estimated-local"
  };
}

function estimateTokenCount(value = "") {
  const text = String(value ?? "");
  if (!text.trim()) return 0;
  const asciiWords = text.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const nonAscii = text.match(/[^\x00-\x7F]/g)?.length ?? 0;
  const punctuationChunks = text.match(/[^\sA-Za-z0-9_\x00-\x7F]+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(asciiWords * 1.25 + nonAscii + punctuationChunks));
}

function traceStatus(event = {}) {
  if (event.type?.includes("failed")) return "error";
  if (event.type?.includes("stopped")) return "stopped";
  if (event.type?.includes("started")) return "running";
  return "ok";
}

function releaseNotesForRpc(input = {}) {
  const manifest = resourceManifest();
  const notes = manifest.releaseNotes;
  const requested = input.version ?? input.id ?? input.fileName ?? null;
  const selected = requested
    ? notes.find((note) => note.id === requested || note.fileName === requested || note.fileName === `${requested}.md`)
    : latestReleaseNote();
  if (!selected) return { notes, latest: null, selected: null, content: "" };
  const resourcePath = selected.path.replace(/^\/resources\//, "");
  const filePath = pathModule.join(projectRoot, "resources", resourcePath);
  let content = "";
  try {
    content = readFileSyncText(filePath);
  } catch {
    content = "";
  }
  return { notes, latest: latestReleaseNote(), selected, content };
}

function latestReleaseNote() {
  const notes = resourceManifest().releaseNotes.filter((note) => /^\d+\.\d+\.\d+$/.test(note.id));
  return notes.sort((a, b) => compareVersionIds(b.id, a.id))[0] ?? resourceManifest().releaseNotes.at(-1) ?? null;
}

function compareVersionIds(left, right) {
  const a = left.split(".").map((part) => Number(part));
  const b = right.split(".").map((part) => Number(part));
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

function readFileSyncText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function normalizeDraftInput(args) {
  const first = args[0];
  if (first && typeof first === "object") {
    return {
      key: first.key ?? first.sessionId ?? first.id ?? "default",
      value: first.value ?? first.text ?? first.content ?? ""
    };
  }
  return {
    key: first ?? "default",
    value: args[1] ?? ""
  };
}

function checkWorkspaceSlug(value) {
  const slug = slugFromInput(value);
  return {
    ok: Boolean(slug),
    slug,
    available: Boolean(slug),
    issues: slug ? [] : ["Workspace slug is required."]
  };
}

function automationRpcList(config = {}) {
  const automations = flattenAutomationConfig(config);
  return {
    version: config.version ?? 2,
    automations,
    items: automations,
    validation: validateAutomationConfig(config),
    lint: lintAutomationConfig(config)
  };
}

function flattenAutomationConfig(config = {}) {
  const items = [];
  for (const [eventName, matchers] of Object.entries(config.automations ?? {})) {
    if (!Array.isArray(matchers)) continue;
    matchers.forEach((matcher, matcherIndex) => {
      const id = matcher.id ?? `automation_${eventName}_${matcherIndex}`;
      items.push({
        ...matcher,
        id,
        event: eventName,
        eventName,
        matcherIndex,
        name: matcher.name ?? `${eventName} automation`,
        enabled: matcher.enabled !== false,
        actionCount: (matcher.actions ?? []).length
      });
    });
  }
  return items.sort((a, b) => String(a.eventName).localeCompare(String(b.eventName)) || a.matcherIndex - b.matcherIndex);
}

function automationMatcherIdentity(input = {}) {
  return {
    id: input.id ?? input.automationId ?? null,
    eventName: input.eventName ?? input.event ?? input.type ?? null,
    matcherIndex: Number.isInteger(input.matcherIndex) ? input.matcherIndex : Number.isInteger(input.index) ? input.index : null
  };
}

function updateAutomationConfig(config = {}, identity = {}, updater = (matcher) => matcher) {
  const next = { version: config.version ?? 2, automations: { ...(config.automations ?? {}) } };
  let changed = false;
  for (const [eventName, matchers] of Object.entries(next.automations)) {
    if (!Array.isArray(matchers)) continue;
    next.automations[eventName] = matchers.map((matcher, matcherIndex) => {
      const id = matcher.id ?? `automation_${eventName}_${matcherIndex}`;
      const matches = identity.id ? id === identity.id : identity.eventName === eventName && identity.matcherIndex === matcherIndex;
      if (!matches) return matcher;
      changed = true;
      return updater({ ...matcher, id }, eventName, matcherIndex);
    }).filter(Boolean);
  }
  return { config: next, changed };
}

async function setAutomationEnabledRpc(store, input = {}) {
  const identity = automationMatcherIdentity(input);
  const enabled = Boolean(input.enabled ?? input.value ?? true);
  const current = await store.getAutomationConfig();
  const { config, changed } = updateAutomationConfig(current, identity, (matcher) => ({ ...matcher, enabled, updatedAt: new Date().toISOString() }));
  if (changed) await store.saveAutomationConfig(config);
  return { ok: changed, enabled, config: automationRpcList(config) };
}

async function duplicateAutomationRpc(store, input = {}) {
  const identity = automationMatcherIdentity(input);
  const current = await store.getAutomationConfig();
  const next = { version: current.version ?? 2, automations: { ...(current.automations ?? {}) } };
  let duplicate = null;
  for (const [eventName, matchers] of Object.entries(current.automations ?? {})) {
    if (!Array.isArray(matchers)) continue;
    const matcherIndex = matchers.findIndex((matcher, index) => {
      const id = matcher.id ?? `automation_${eventName}_${index}`;
      return identity.id ? id === identity.id : identity.eventName === eventName && identity.matcherIndex === index;
    });
    if (matcherIndex === -1) continue;
    duplicate = {
      ...matchers[matcherIndex],
      id: `automation_${crypto.randomUUID()}`,
      name: `${matchers[matcherIndex].name ?? eventName} Copy`,
      enabled: matchers[matcherIndex].enabled !== false,
      updatedAt: new Date().toISOString()
    };
    next.automations[eventName] = [...matchers.slice(0, matcherIndex + 1), duplicate, ...matchers.slice(matcherIndex + 1)];
    break;
  }
  if (duplicate) await store.saveAutomationConfig(next);
  return { ok: Boolean(duplicate), automation: duplicate, config: automationRpcList(next) };
}

async function deleteAutomationRpc(store, input = {}) {
  const identity = automationMatcherIdentity(input);
  const current = await store.getAutomationConfig();
  const { config, changed } = updateAutomationConfig(current, identity, () => null);
  if (changed) await store.saveAutomationConfig(config);
  return { ok: changed, deleted: changed, config: automationRpcList(config) };
}

async function testAutomationRpc({ store, runtime, events, input = {} }) {
  const result = await runAutomations({
    config: await store.getAutomationConfig(),
    event: input.event ?? input,
    store,
    executeWebhooks: input.executeWebhooks === true,
    fetchImpl: runtime.fetchImpl
  });
  events.emit("automation.ran", result.history);
  return result;
}

async function replayAutomationRpc({ store, runtime, events, automationScheduler, input = {} }) {
  const historyId = input.historyId ?? input.id ?? null;
  if (historyId) {
    const history = (await store.listAutomationHistory()).find((item) => item.id === historyId);
    if (!history) return { ok: false, reason: "automation_history_not_found", historyId };
    const result = await runAutomations({
      config: await store.getAutomationConfig(),
      event: history.event,
      store,
      executeWebhooks: input.executeWebhooks === true,
      fetchImpl: runtime.fetchImpl
    });
    events.emit("automation.ran", result.history);
    return { ok: true, replayedFrom: historyId, ...result };
  }
  const now = input.now ? new Date(input.now) : new Date();
  const result = automationScheduler
    ? await automationScheduler.tick({ now })
    : await runAutomationSchedulerTick({ store, now, executeWebhooks: input.executeWebhooks === true, fetchImpl: runtime.fetchImpl });
  events.emit("automation.scheduler.tick", result.history);
  events.emit("automation.ran", result.history);
  return { ok: true, ...result };
}

async function getLastExecutedAutomationRpc(store, input = {}) {
  const history = await store.listAutomationHistory();
  const eventName = input.eventName ?? input.event ?? input.type ?? null;
  const automationId = input.id ?? input.automationId ?? null;
  return history.find((item) => {
    if (eventName && item.eventType !== eventName) return false;
    if (!automationId) return true;
    return (item.results ?? []).some((result) => result.automationKey?.includes(automationId) || result.automationId === automationId);
  }) ?? null;
}

async function saveViewFromRpc(store, input = {}) {
  if (input.id) {
    const view = updateView(await store.getView(input.id), input.patch ?? input);
    await store.saveView(view);
    return view;
  }
  const workspaceRecord = await store.getWorkspace();
  const view = createView({
    workspaceId: workspaceRecord.id,
    name: input.name ?? input.title ?? "Untitled view",
    entity: input.entity,
    filters: input.filters,
    sort: input.sort
  });
  await store.saveView(view);
  return view;
}

async function taskRunRpc(store, channel, input = {}) {
  const command = channel.split(":")[1];
  const status = command === "pause" ? "paused" : command === "stop" ? "stopped" : "running";
  const taskId = required(input.taskId ?? input.id ?? input, "taskId");
  const task = await store.getTask(taskId);
  const now = new Date().toISOString();
  const runEvent = {
    id: `task_run_${crypto.randomUUID()}`,
    command,
    status,
    reason: input.reason ?? null,
    createdAt: now
  };
  const outputLine = `${now} ${task.title}: ${status}`;
  const results = [
    ...(task.results ?? []),
    {
      id: runEvent.id,
      type: "task-run",
      status,
      command,
      taskId,
      createdAt: now
    }
  ];
  const next = {
    ...task,
    runState: {
      status,
      command,
      startedAt: task.runState?.startedAt ?? (status === "running" ? now : null),
      updatedAt: now,
      stoppedAt: status === "stopped" ? now : task.runState?.stoppedAt ?? null
    },
    runHistory: [...(task.runHistory ?? []), runEvent],
    output: [task.output, outputLine].filter(Boolean).join("\n"),
    results,
    updatedAt: now
  };
  await store.saveTask(next);
  return {
    ok: true,
    taskId,
    status,
    task: next,
    output: next.output,
    results
  };
}

async function taskOutputRpc(store, input = {}) {
  const taskId = required(input.taskId ?? input.id ?? input, "taskId");
  const task = await store.getTask(taskId);
  return { taskId, output: task.output ?? "", runState: task.runState ?? null, updatedAt: task.updatedAt };
}

async function taskResultsRpc(store, input = {}) {
  const taskId = required(input.taskId ?? input.id ?? input, "taskId");
  const task = await store.getTask(taskId);
  return { taskId, results: task.results ?? [], runHistory: task.runHistory ?? [], runState: task.runState ?? null };
}

async function taskGenerateRpc(store, input = {}) {
  const workspaceRecord = await store.getWorkspace();
  const statusConfig = await store.getStatusConfig();
  const source = input.prompt ?? input.goal ?? input.text ?? input.description ?? "Generated task";
  const lines = String(source).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tasks = (lines.length ? lines : [String(source)])
    .slice(0, Math.max(1, Math.min(Number(input.limit ?? 5), 20)))
    .map((line, index) => createTask({
      workspaceId: workspaceRecord.id,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      title: line.replace(/^[-*]\s+|\d+[.)]\s+/, "").slice(0, 120) || `Generated task ${index + 1}`,
      description: input.description && input.description !== line ? input.description : "",
      labels: input.labels ?? [],
      statusId: input.statusId,
      statusConfig
    }));
  return { ok: true, tasks, generated: tasks.length, mode: "local-state" };
}

async function listProjectAssets(workspace, projectId) {
  const root = projectAssetRoot(workspace, projectId);
  try {
    const files = await readdir(root);
    const assets = [];
    for (const fileName of files.sort()) {
      const filePath = pathModule.join(root, fileName);
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      assets.push({
        id: fileName,
        fileName,
        projectId: projectId ?? null,
        path: filePath,
        size: info.size,
        updatedAt: info.mtime.toISOString()
      });
    }
    return assets;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function saveProjectAsset(workspace, input = {}) {
  const projectId = input.projectId ?? input.id ?? "default";
  const fileName = safeFileName(input.fileName ?? input.name ?? "asset.txt");
  const root = projectAssetRoot(workspace, projectId);
  await mkdir(root, { recursive: true });
  const body = input.base64
    ? Buffer.from(String(input.base64), "base64")
    : Buffer.from(String(input.content ?? input.text ?? ""), "utf8");
  const filePath = pathModule.join(root, fileName);
  await writeFile(filePath, body);
  const info = await stat(filePath);
  return {
    id: fileName,
    fileName,
    projectId,
    path: filePath,
    size: info.size,
    updatedAt: info.mtime.toISOString()
  };
}

async function deleteProjectAsset(workspace, input = {}) {
  const projectId = input.projectId ?? input.id ?? "default";
  const fileName = safeFileName(required(input.fileName ?? input.assetId ?? input.name, "fileName"));
  const filePath = pathModule.join(projectAssetRoot(workspace, projectId), fileName);
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ok: true, projectId, fileName };
}

function projectAssetRoot(workspace, projectId = "default") {
  return pathModule.join(workspace, ".craft-agent", "project-assets", slugFromInput(projectId) || "default");
}

async function saveSourceConfig(workspace, input = {}) {
  const slug = slugFromInput(required(input.slug ?? input.id ?? input.name, "slug"));
  const root = pathModule.join(workspace, ".craft-agent", "sources", slug);
  await mkdir(root, { recursive: true });
  const now = new Date().toISOString();
  const config = {
    id: input.id ?? slug,
    slug,
    name: input.name ?? slug,
    type: input.type ?? "local",
    enabled: input.enabled ?? true,
    provider: input.provider ?? slug,
    ...(input.type === "local" || input.local || input.root ? { local: { ...(input.local ?? {}), path: input.root ?? input.local?.path ?? workspace } } : {}),
    ...(input.api ? { api: input.api } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
    ...(input.auth ? { auth: input.auth } : {}),
    ...(input.oauth ? { oauth: input.oauth } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: now
  };
  await writeFile(pathModule.join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (input.guide) await writeFile(pathModule.join(root, "guide.md"), String(input.guide), "utf8");
  if (input.permissions) await writeFile(pathModule.join(root, "permissions.json"), `${JSON.stringify(input.permissions, null, 2)}\n`, "utf8");
  return {
    ...config,
    path: root,
    guide: input.guide ?? null,
    permissions: input.permissions ?? null,
    validation: { ok: true, issues: [] }
  };
}

async function deleteSourceConfig(workspace, sourceSlug) {
  const slug = slugFromInput(sourceSlug);
  const root = pathModule.join(workspace, ".craft-agent", "sources", slug);
  for (const fileName of ["permissions.json", "guide.md", "config.json"]) {
    try {
      await unlink(pathModule.join(root, fileName));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function findSourceForRpc(runtime, sourceSlug) {
  const workspaceRecord = await runtime.store.getWorkspace();
  const slug = required(sourceSlug, "sourceSlug");
  const source = (await discoverSources({ workspace: runtime.workspace, workspaceId: workspaceRecord.id, store: runtime.store }))
    .find((item) => item.slug === slug);
  if (!source) {
    const error = new Error(`Source not found: ${slug}`);
    error.code = "SOURCE_NOT_FOUND";
    throw error;
  }
  return source;
}

async function saveKnowledgeVaultFromRpc(store, workspace, input = {}) {
  const workspaceRecord = await store.getWorkspace();
  if (input.id || input.vaultId || input.collectionId) {
    const collectionId = input.id ?? input.vaultId ?? input.collectionId;
    const collection = updateKnowledgeCollection(await store.getKnowledgeCollection(collectionId), input.patch ?? input);
    await store.saveKnowledgeCollection(collection);
    return collection;
  }
  const root = input.root ?? input.path ?? pathModule.join(workspace, "knowledge");
  await mkdir(root, { recursive: true });
  const collection = createKnowledgeCollection({
    workspaceId: workspaceRecord.id,
    name: input.name ?? input.title ?? pathModule.basename(root) ?? "Knowledge",
    root,
    type: input.type ?? "vault",
    enabled: input.enabled,
    semanticEnabled: input.semanticEnabled
  });
  await store.saveKnowledgeCollection(collection);
  await store.writePreferences({ defaultKnowledgeVaultId: collection.id });
  return collection;
}

async function inspectKnowledgeVaultPath(requestedPath) {
  const root = pathModule.resolve(required(requestedPath, "path"));
  try {
    const info = await stat(root);
    return {
      ok: info.isDirectory(),
      path: root,
      exists: true,
      isDirectory: info.isDirectory(),
      reason: info.isDirectory() ? null : "path_is_not_directory"
    };
  } catch (error) {
    return {
      ok: false,
      path: root,
      exists: false,
      isDirectory: false,
      reason: error.code ?? error.message
    };
  }
}

function knowledgeVaultSummary(report, collectionId = null) {
  if (!collectionId) return report;
  return report.collections.find((collection) => collection.collectionId === collectionId || collection.id === collectionId) ?? null;
}

function defaultKnowledgeVault(collections, preferences = {}) {
  return collections.find((collection) => collection.id === preferences.defaultKnowledgeVaultId) ?? collections[0] ?? null;
}

async function addRawKnowledgeDocument(store, workspace, input = {}) {
  const workspaceRecord = await store.getWorkspace();
  let collection = null;
  const collectionId = input.collectionId ?? input.vaultId;
  if (collectionId) {
    collection = await store.getKnowledgeCollection(collectionId);
  } else {
    collection = (await store.listKnowledgeCollections())[0] ?? await saveKnowledgeVaultFromRpc(store, workspace, {
      name: "Knowledge",
      root: pathModule.join(workspace, "knowledge")
    });
  }
  await mkdir(collection.root, { recursive: true });
  const fileName = safeFileName(input.fileName ?? input.title ?? "note.md");
  const relativePath = fileName.endsWith(".md") || fileName.endsWith(".txt") ? fileName : `${fileName}.md`;
  const filePath = pathModule.join(collection.root, relativePath);
  const content = String(input.content ?? input.text ?? "");
  await writeFile(filePath, content, "utf8");
  const info = await stat(filePath);
  const current = (await store.listKnowledgeDocuments({ collectionId: collection.id }))
    .filter((document) => document.path !== relativePath);
  const document = createKnowledgeDocument({
    workspaceId: workspaceRecord.id,
    collectionId: collection.id,
    title: input.title,
    path: relativePath,
    content,
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString()
  });
  await store.saveKnowledgeDocuments(collection.id, [document, ...current]);
  return document;
}

async function deleteKnowledgeDocumentsFromRpc(store, input = {}) {
  const ids = new Set(Array.isArray(input.ids) ? input.ids : Array.isArray(input.documentIds) ? input.documentIds : [input.id ?? input.documentId].filter(Boolean));
  const collectionId = input.collectionId ?? input.vaultId;
  const collections = collectionId ? [await store.getKnowledgeCollection(collectionId)] : await store.listKnowledgeCollections();
  let deleted = 0;
  for (const collection of collections) {
    const documents = await store.listKnowledgeDocuments({ collectionId: collection.id });
    const next = documents.filter((document) => {
      const remove = ids.size === 0 || ids.has(document.id) || ids.has(document.path);
      if (remove) deleted += 1;
      return !remove;
    });
    await store.saveKnowledgeDocuments(collection.id, next);
  }
  return { ok: true, deleted };
}

async function moveKnowledgeDocumentsFromRpc(store, input = {}) {
  const targetCollectionId = required(input.targetCollectionId ?? input.toCollectionId ?? input.toVaultId, "targetCollectionId");
  const targetCollection = await store.getKnowledgeCollection(targetCollectionId);
  const ids = new Set(Array.isArray(input.ids) ? input.ids : Array.isArray(input.documentIds) ? input.documentIds : [input.id ?? input.documentId].filter(Boolean));
  const collections = await store.listKnowledgeCollections();
  const moved = [];
  for (const collection of collections) {
    const documents = await store.listKnowledgeDocuments({ collectionId: collection.id });
    const keep = [];
    for (const document of documents) {
      if (ids.has(document.id) || ids.has(document.path)) moved.push({ ...document, collectionId: targetCollection.id, indexedAt: new Date().toISOString() });
      else keep.push(document);
    }
    if (collection.id !== targetCollection.id) await store.saveKnowledgeDocuments(collection.id, keep);
  }
  const targetDocuments = await store.listKnowledgeDocuments({ collectionId: targetCollection.id });
  const movedIds = new Set(moved.map((document) => document.id));
  await store.saveKnowledgeDocuments(targetCollection.id, [...moved, ...targetDocuments.filter((document) => !movedIds.has(document.id))]);
  return { ok: true, moved: moved.length, targetCollectionId: targetCollection.id };
}

function knowledgeGraph(collections, documents) {
  return {
    nodes: [
      ...collections.map((collection) => ({ id: collection.id, type: "collection", label: collection.name })),
      ...documents.map((document) => ({ id: document.id, type: "document", label: document.title, path: document.path }))
    ],
    edges: documents.map((document) => ({ source: document.collectionId, target: document.id, type: "contains" }))
  };
}

async function saveKnowledgeCategory(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const id = input.id ?? slugFromInput(input.name ?? "category");
  const categories = Array.isArray(preferences.knowledgeCategories) ? preferences.knowledgeCategories : [];
  const nextCategory = { ...input, id, updatedAt: new Date().toISOString() };
  const next = input.delete === true
    ? categories.filter((category) => category.id !== id)
    : categories.some((category) => category.id === id)
      ? categories.map((category) => category.id === id ? { ...category, ...nextCategory } : category)
      : [nextCategory, ...categories];
  return (await store.writePreferences({ knowledgeCategories: next })).knowledgeCategories;
}

async function confirmKnowledgeReviewRpc(store, channel, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const kind = channel === "knowledge:confirmTaskPlan" ? "task-plan" : "draft-review";
  const targetId = input.id ?? input.itemId ?? input.documentId ?? input.taskId ?? null;
  const decision = input.decision ?? input.action ?? (input.accepted === false ? "rejected" : "accepted");
  const event = {
    id: input.eventId ?? `knowledge_review_${crypto.randomUUID()}`,
    kind,
    targetId,
    decision,
    note: input.note ?? input.comment ?? null,
    payload: input.payload ?? input.data ?? input,
    accepted: decision !== "rejected",
    createdAt: now
  };
  const knowledgeInboxItems = (preferences.knowledgeInboxItems ?? []).map((item) =>
    targetId && (item.id === targetId || item.documentId === targetId || item.taskId === targetId)
      ? { ...item, reviewStatus: event.accepted ? "accepted" : "rejected", reviewedAt: now, reviewEventId: event.id }
      : item);
  const report = {
    id: `knowledge_report_${crypto.randomUUID()}`,
    type: kind,
    status: event.accepted ? "accepted" : "rejected",
    targetId,
    eventId: event.id,
    createdAt: now
  };
  await store.writePreferences({
    knowledgeReviewEvents: [event, ...(preferences.knowledgeReviewEvents ?? [])].slice(0, 100),
    knowledgeTaskReports: [report, ...(preferences.knowledgeTaskReports ?? [])].slice(0, 100),
    knowledgeInboxItems
  });
  return { ok: true, accepted: event.accepted, event, report, inboxItems: knowledgeInboxItems };
}

async function installKnowledgeSkillsRpc({ store, workspace, kind, input = {} }) {
  const templates = kind === "lark" ? LARK_KNOWLEDGE_SKILLS : WIKI_KNOWLEDGE_SKILLS;
  const selected = Array.isArray(input.skills) && input.skills.length
    ? templates.filter((template) => input.skills.includes(template.slug) || input.skills.includes(template.name))
    : templates;
  const root = pathModule.join(workspace, ".craft-agent", "skills");
  const installed = [];
  for (const template of selected) {
    const directory = pathModule.join(root, template.slug);
    const skillPath = pathModule.join(directory, "SKILL.md");
    const existed = existsSync(skillPath);
    if (!existed || input.overwrite === true) {
      await mkdir(directory, { recursive: true });
      await writeFile(skillPath, renderKnowledgeSkill(template), "utf8");
    }
    installed.push({
      slug: template.slug,
      name: template.name,
      path: pathModule.relative(workspace, skillPath),
      installed: !existed || input.overwrite === true,
      skipped: existed && input.overwrite !== true
    });
  }
  const preferences = rpcPreferences(await store.readPreferences());
  const event = {
    id: `knowledge_skill_install_${crypto.randomUUID()}`,
    kind,
    installed,
    createdAt: new Date().toISOString()
  };
  await store.writePreferences({
    knowledgeSkillInstalls: [event, ...(preferences.knowledgeSkillInstalls ?? [])].slice(0, 50)
  });
  return { ok: true, kind, installed, skills: await discoverSkills({ workspace }), event };
}

function renderKnowledgeSkill(template) {
  return `---\nname: ${template.name}\ndescription: ${template.description}\n---\n\n${template.body.trim()}\n`;
}

const LARK_KNOWLEDGE_SKILLS = [
  {
    slug: "lark-knowledge-sync",
    name: "Lark Knowledge Sync",
    description: "Prepare Lark documents and messages for the local Peng knowledge cockpit.",
    body: "Use this skill when Lark content should be organized for local knowledge indexing. Collect document URLs, summarize the requested scope, save imported notes as markdown, and keep source links in the front matter."
  },
  {
    slug: "lark-knowledge-review",
    name: "Lark Knowledge Review",
    description: "Review imported Lark knowledge items and propose categories, tags, and follow-up tasks.",
    body: "Use this skill after Lark content is imported. Check whether each item has a clear title, source, owner, and next action. Suggest categories and mark gaps that need another import pass."
  }
];

const WIKI_KNOWLEDGE_SKILLS = [
  {
    slug: "wiki-knowledge-index",
    name: "Wiki Knowledge Index",
    description: "Prepare wiki or Obsidian-style markdown folders for Peng knowledge indexing.",
    body: "Use this skill when a wiki folder should become a local knowledge vault. Normalize headings, preserve backlinks, keep source paths stable, and flag stale or duplicate pages before indexing."
  },
  {
    slug: "wiki-knowledge-synthesis",
    name: "Wiki Knowledge Synthesis",
    description: "Synthesize indexed wiki notes into summaries, categories, and task candidates.",
    body: "Use this skill after wiki notes are indexed. Find related notes, summarize core claims, propose categories, and emit task candidates for missing evidence or outdated pages."
  }
];

function mergeMessagingConfig(current = {}, patch = {}) {
  return {
    ...current,
    ...patch,
    platforms: {
      ...(current.platforms ?? {}),
      ...(patch.platforms ?? {})
    },
    updatedAt: new Date().toISOString()
  };
}

async function updateMessagingConfig(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const messagingConfig = mergeMessagingConfig(preferences.messagingConfig, input);
  const messagingGateway = messagingGatewayState(messagingConfig, preferences.messagingGateway);
  await store.writePreferences({ messagingConfig, messagingGateway });
  return { ...messagingConfig, gateway: messagingGateway };
}

async function saveMessagingPlatform(store, platform, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const current = preferences.messagingConfig;
  const nextConfig = mergeMessagingConfig(current, {
    enabled: true,
    platforms: {
      [platform]: {
        ...(current.platforms?.[platform] ?? {}),
        ...redactMessagingSecrets(input),
        enabled: input.enabled ?? true,
        configured: true,
        updatedAt: new Date().toISOString()
      }
    }
  });
  const messagingGateway = messagingGatewayState(nextConfig, preferences.messagingGateway);
  return (await store.writePreferences({ messagingConfig: nextConfig, messagingGateway })).messagingConfig.platforms[platform];
}

function testMessagingPlatform(preferences, platform) {
  const config = preferences.messagingConfig?.platforms?.[platform] ?? {};
  const configured = config.configured === true || config.enabled === true;
  const worker = preferences.messagingGateway?.workers?.[platform] ?? null;
  return {
    ok: configured,
    platform,
    status: configured ? "configured" : "needs_config",
    reason: configured ? null : `${platform} is not configured`,
    worker
  };
}

function messagingPlatformStatus(preferences, platform = null) {
	  const platforms = preferences.messagingConfig?.platforms ?? {};
	  const gateway = preferences.messagingGateway ?? { workers: {} };
	  if (platform) {
	    const extra = platform === "whatsapp" ? { whatsapp: preferences.messagingWhatsApp ?? null } : {};
	    return { platform, ...(platforms[platform] ?? { enabled: false, configured: false }), worker: gateway.workers?.[platform] ?? null, ...extra };
	  }
	  return {
	    gateway,
	    platforms: Object.fromEntries(Object.entries(platforms).map(([name, config]) => [name, { platform: name, ...config, worker: gateway.workers?.[name] ?? null }]))
	  };
	}

async function startWhatsAppConnect(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const connect = {
    id: input.id ?? `wa_connect_${crypto.randomUUID()}`,
    platform: "whatsapp",
    status: "awaiting_phone",
    phone: input.phone ?? null,
    pairingCode: input.pairingCode ?? null,
    qr: input.qr ?? null,
    createdAt: now,
    updatedAt: now,
    mode: "clean-room-local",
    externalNetwork: false
  };
  const messagingConfig = mergeMessagingConfig(preferences.messagingConfig, {
    enabled: true,
    platforms: {
      whatsapp: {
        ...(preferences.messagingConfig?.platforms?.whatsapp ?? {}),
        enabled: true,
        configured: true,
        status: connect.status,
        updatedAt: now
      }
    }
  });
  const messagingWhatsApp = {
    ...(preferences.messagingWhatsApp ?? {}),
    status: connect.status,
    activeConnectId: connect.id,
    connectSessions: [connect, ...(preferences.messagingWhatsApp?.connectSessions ?? [])].slice(0, 20),
    updatedAt: now
  };
  const messagingGateway = messagingGatewayState(messagingConfig, preferences.messagingGateway);
  await store.writePreferences({ messagingConfig, messagingGateway, messagingWhatsApp });
  await recordMessagingEvent(store, "whatsappConnectStarted", { connectId: connect.id, phone: connect.phone });
  return { ok: true, platform: "whatsapp", connect, status: connect.status, gateway: messagingGateway.workers.whatsapp };
}

async function submitWhatsAppPhone(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const phone = String(input.phone ?? input.whatsappPhone ?? "").trim();
  const sessions = preferences.messagingWhatsApp?.connectSessions ?? [];
  const current = sessions.find((session) => session.id === input.id || session.id === input.connectId) ?? sessions[0] ?? {
    id: `wa_connect_${crypto.randomUUID()}`,
    platform: "whatsapp",
    createdAt: now,
    mode: "clean-room-local",
    externalNetwork: false
  };
  const connect = {
    ...current,
    phone,
    status: phone ? "phone_submitted" : "needs_phone",
    pairingCode: input.pairingCode ?? current.pairingCode ?? null,
    updatedAt: now
  };
  const messagingConfig = mergeMessagingConfig(preferences.messagingConfig, {
    enabled: true,
    platforms: {
      whatsapp: {
        ...(preferences.messagingConfig?.platforms?.whatsapp ?? {}),
        enabled: true,
        configured: Boolean(phone),
        phone: phone || null,
        status: connect.status,
        updatedAt: now
      }
    }
  });
  const messagingWhatsApp = {
    ...(preferences.messagingWhatsApp ?? {}),
    status: connect.status,
    activeConnectId: connect.id,
    phone: phone || null,
    connectSessions: [connect, ...sessions.filter((session) => session.id !== connect.id)].slice(0, 20),
    updatedAt: now
  };
  const messagingGateway = messagingGatewayState(messagingConfig, preferences.messagingGateway);
  await store.writePreferences({ messagingConfig, messagingGateway, messagingWhatsApp });
  await recordMessagingEvent(store, "whatsappPhoneSubmitted", { connectId: connect.id, phone: phone || null, status: connect.status });
  return { ok: Boolean(phone), platform: "whatsapp", connect, status: connect.status, gateway: messagingGateway.workers.whatsapp };
}

async function recordWhatsAppUiEvent(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const event = {
    id: `wa_ui_${crypto.randomUUID()}`,
    type: input.type ?? input.event ?? "uiEvent",
    payload: input,
    createdAt: new Date().toISOString()
  };
  const messagingWhatsApp = {
    ...(preferences.messagingWhatsApp ?? {}),
    uiEvents: [event, ...(preferences.messagingWhatsApp?.uiEvents ?? [])].slice(0, 100),
    updatedAt: event.createdAt
  };
  await store.writePreferences({ messagingWhatsApp });
  await recordMessagingEvent(store, "whatsappUiEvent", { event });
  return { ok: true, event, events: messagingWhatsApp.uiEvents };
}

async function recordMessagingPendingChanged(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const request = {
    id: input.id ?? input.requestId ?? `msg_pending_${crypto.randomUUID()}`,
    platform: input.platform ?? "telegram",
    chatId: input.chatId ?? null,
    userId: input.userId ?? null,
    label: input.label ?? input.name ?? null,
    status: input.status ?? "pending",
    createdAt: input.createdAt ?? now,
    updatedAt: now
  };
  const pending = [request, ...(preferences.messagingAccess?.pending ?? []).filter((item) => item.id !== request.id)].slice(0, 100);
  const messagingAccess = { ...preferences.messagingAccess, pending, updatedAt: now };
  await store.writePreferences({ messagingAccess });
  await recordMessagingEvent(store, "pendingChanged", { request });
  return { ok: true, request, pending };
}

async function setMessagingAccessMode(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const mode = input.mode ?? input;
  const messagingAccess = { ...preferences.messagingAccess, mode: String(mode ?? "owners"), updatedAt: new Date().toISOString() };
  await store.writePreferences({ messagingAccess });
  await recordMessagingEvent(store, "accessModeChanged", { mode: messagingAccess.mode });
  return messagingAccess.mode;
}

async function setMessagingAccessOwners(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const owners = Array.isArray(input) ? input : (input.owners ?? input.userIds ?? []);
  const messagingAccess = {
    ...preferences.messagingAccess,
    owners: owners.map((owner) => typeof owner === "string" ? { id: owner, label: owner } : owner).filter(Boolean),
    updatedAt: new Date().toISOString()
  };
  await store.writePreferences({ messagingAccess });
  await recordMessagingEvent(store, "accessOwnersChanged", { count: messagingAccess.owners.length });
  return messagingAccess.owners;
}

async function resolveMessagingAccessPending(store, input = {}, status) {
  const preferences = rpcPreferences(await store.readPreferences());
  const pending = preferences.messagingAccess?.pending ?? [];
  const id = input.id ?? input.requestId ?? input.chatId ?? input.userId;
  const match = id ? pending.find((item) => [item.id, item.requestId, item.chatId, item.userId].includes(id)) : (input.request ?? input);
  const nextPending = id ? pending.filter((item) => ![item.id, item.requestId, item.chatId, item.userId].includes(id)) : pending;
  const messagingAccess = { ...preferences.messagingAccess, pending: nextPending, updatedAt: new Date().toISOString() };
  const patch = { messagingAccess };
  if (status === "allowed" && match) {
    const owner = {
      id: match.userId ?? match.chatId ?? match.id ?? `owner_${crypto.randomUUID()}`,
      platform: match.platform ?? input.platform ?? "telegram",
      chatId: match.chatId ?? null,
      label: match.label ?? match.name ?? null,
      allowedAt: messagingAccess.updatedAt
    };
    patch.messagingAccess = { ...messagingAccess, owners: [owner, ...(preferences.messagingAccess?.owners ?? []).filter((item) => item.id !== owner.id)] };
  }
  await store.writePreferences(patch);
  await recordMessagingEvent(store, `accessPending${status === "allowed" ? "Allowed" : "Dismissed"}`, { id: id ?? null });
  return { ok: true, status, request: match ?? null, access: patch.messagingAccess };
}

async function setMessagingBindingAccess(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const id = input.id ?? input.bindingId ?? input.chatId;
  const now = new Date().toISOString();
  const bindings = (preferences.messagingBindings ?? []).map((binding) =>
    [binding.id, binding.bindingId, binding.chatId].includes(id)
      ? { ...binding, access: input.access ?? input.mode ?? "allowed", accessUpdatedAt: now }
      : binding
  );
  await store.writePreferences({ messagingBindings: bindings });
  await recordMessagingEvent(store, "bindingAccessChanged", { id, access: input.access ?? input.mode ?? "allowed" });
  return { ok: true, binding: bindings.find((binding) => [binding.id, binding.bindingId, binding.chatId].includes(id)) ?? null, bindings };
}

async function generateMessagingCode(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const code = input.code ?? crypto.randomBytes(4).toString("hex").toUpperCase();
  const now = new Date();
  const record = {
    id: `msg_code_${crypto.randomUUID()}`,
    code,
    kind: input.kind ?? "binding",
    platform: input.platform ?? "telegram",
    label: input.label ?? null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Number(input.ttlMs ?? 10 * 60 * 1000)).toISOString()
  };
  const pending = [record, ...(preferences.messagingPendingCodes ?? [])].slice(0, 50);
  const patch = { messagingPendingCodes: pending };
  if (record.kind === "supergroup") {
    patch.messagingSupergroup = {
      id: record.id,
      code,
      platform: record.platform,
      status: "pending",
      createdAt: record.createdAt,
      expiresAt: record.expiresAt
    };
  }
  await store.writePreferences(patch);
  await recordMessagingEvent(store, "codeGenerated", { id: record.id, platform: record.platform, kind: record.kind });
  return record;
}

async function unbindMessaging(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const id = input.id ?? input.bindingId ?? input.chatId ?? input.platform;
  const next = (preferences.messagingBindings ?? []).filter((binding) =>
    id ? ![binding.id, binding.bindingId, binding.chatId, binding.platform].includes(id) : false
  );
  await store.writePreferences({ messagingBindings: next });
  await recordMessagingEvent(store, "bindingRemoved", { id });
  return { ok: true, removed: (preferences.messagingBindings ?? []).length - next.length, bindings: next };
}

async function disconnectMessaging(store, platform = null) {
  const preferences = rpcPreferences(await store.readPreferences());
  const config = preferences.messagingConfig;
  const platforms = { ...(config.platforms ?? {}) };
  const names = platform ? [platform] : Object.keys(platforms);
  for (const name of names) {
    platforms[name] = { ...(platforms[name] ?? {}), enabled: false, disconnectedAt: new Date().toISOString() };
  }
  const nextConfig = { ...config, enabled: Object.values(platforms).some((item) => item.enabled === true), platforms };
  const messagingGateway = messagingGatewayState(nextConfig, preferences.messagingGateway);
  await store.writePreferences({ messagingConfig: nextConfig, messagingGateway });
  await recordMessagingEvent(store, "gatewayStopped", { platform: platform ?? null });
  return { ok: true, platform: platform ?? null, config: nextConfig, gateway: messagingGateway };
}

async function forgetMessaging(store) {
  const preferences = rpcPreferences(await store.readPreferences());
  const messagingGateway = messagingGatewayState({ ...(preferences.messagingConfig ?? {}), enabled: false, platforms: {} }, preferences.messagingGateway);
  return store.writePreferences({
    messagingBindings: [],
    messagingPendingCodes: [],
    messagingSupergroup: null,
    messagingGateway,
    messagingEvents: []
  });
}

async function applyMessagingBindingEvent(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const platform = input.platform ?? "telegram";
  const code = input.code ?? input.bindingCode ?? null;
  const pending = preferences.messagingPendingCodes ?? [];
  const pendingMatch = code ? pending.find((item) => item.code === code && item.platform === platform) : null;
  const now = new Date().toISOString();
  const binding = {
    id: input.id ?? `msg_binding_${crypto.randomUUID()}`,
    platform,
    chatId: input.chatId ?? input.threadId ?? input.userId ?? null,
    userId: input.userId ?? null,
    label: input.label ?? pendingMatch?.label ?? null,
    code,
    kind: pendingMatch?.kind ?? input.kind ?? "binding",
    status: "bound",
    createdAt: now,
    updatedAt: now
  };
  const bindings = [binding, ...(preferences.messagingBindings ?? []).filter((item) => item.id !== binding.id && item.chatId !== binding.chatId)].slice(0, 100);
  const patch = {
    messagingBindings: bindings,
    messagingPendingCodes: pending.filter((item) => item.id !== pendingMatch?.id)
  };
  if (binding.kind === "supergroup") patch.messagingSupergroup = { ...binding, status: "bound" };
  await store.writePreferences(patch);
  await recordMessagingEvent(store, "bindingChanged", { binding });
  return { ok: true, binding, bindings };
}

async function recordMessagingInbound({ store, runtime, input = {} }) {
  const preferences = rpcPreferences(await store.readPreferences());
  const platform = input.platform ?? "telegram";
  const chatId = input.chatId ?? input.threadId ?? input.userId ?? null;
  const text = String(input.text ?? input.message ?? input.content ?? "");
  const binding = (preferences.messagingBindings ?? []).find((item) =>
    item.platform === platform && (!chatId || item.chatId === chatId || item.userId === chatId)
  ) ?? null;
  let session = null;
  if (input.createSession !== false && text.trim()) {
    const workspaceRecord = await store.getWorkspace();
    session = createSession({
      workspaceId: workspaceRecord.id,
      prompt: text,
      name: input.sessionName ?? `${platform} message`
    });
    await store.saveSession({
      ...session,
      metadata: {
        ...(session.metadata ?? {}),
        kind: "messaging",
        platform,
        chatId,
        bindingId: binding?.id ?? null
      }
    });
  }
  const eventResult = await recordMessagingEvent(store, "inboundMessage", {
    platform,
    chatId,
    text,
    bindingId: binding?.id ?? null,
    sessionId: session?.id ?? null,
    raw: input.raw ?? null
  });
  runtime?.events?.emit?.("messaging.inbound", eventResult.event);
  return {
    ok: true,
    event: eventResult.event,
    binding,
    session: session ? sessionForRpc(session) : null
  };
}

async function recordMessagingEvent(store, type, payload = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const event = {
    id: `msg_event_${crypto.randomUUID()}`,
    type,
    payload,
    createdAt: new Date().toISOString()
  };
  const messagingEvents = [event, ...(preferences.messagingEvents ?? [])].slice(0, 200);
  await store.writePreferences({ messagingEvents });
  return { ok: true, event, events: messagingEvents };
}

function messagingGatewayState(config = {}, previous = {}) {
  const now = new Date().toISOString();
  const platforms = config.platforms ?? {};
  const workers = {};
  for (const [platform, platformConfig] of Object.entries(platforms)) {
    const running = config.enabled !== false && platformConfig.enabled === true && platformConfig.configured === true;
    workers[platform] = {
      platform,
      running,
      status: running ? "running" : platformConfig.configured ? "stopped" : "needs_config",
      startedAt: running ? previous.workers?.[platform]?.startedAt ?? now : previous.workers?.[platform]?.startedAt ?? null,
      stoppedAt: running ? null : now,
      mode: "clean-room-local",
      externalNetwork: false
    };
  }
  const running = Object.values(workers).some((worker) => worker.running);
  return {
    running,
    status: running ? "running" : "stopped",
    workers,
    startedAt: running ? previous.startedAt ?? now : previous.startedAt ?? null,
    stoppedAt: running ? null : now,
    updatedAt: now,
    mode: "clean-room-local"
  };
}

function providerAuthStatus(preferences, provider) {
  const auth = preferences.providerAuth?.[provider] ?? {};
  return {
    provider,
    authenticated: auth.authenticated === true,
    status: auth.status ?? "signed_out",
    pending: auth.pending ?? null,
    updatedAt: auth.updatedAt ?? null
  };
}

async function startProviderOAuth(store, provider) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const state = crypto.randomBytes(12).toString("hex");
  const pending = {
    id: `${provider}_oauth_${crypto.randomUUID()}`,
    provider,
    status: "pending",
    url: providerAuthorizationUrl(provider, state),
    authorizationUrl: providerAuthorizationUrl(provider, state),
    state,
    mode: "local-state",
    createdAt: now,
    updatedAt: now
  };
  const providerAuth = {
    ...(preferences.providerAuth ?? {}),
    [provider]: { authenticated: false, status: "pending", pending, updatedAt: pending.createdAt }
  };
  await store.writePreferences({ providerAuth });
  return pending;
}

function providerAuthorizationUrl(provider, state) {
  const bases = {
    chatgpt: "https://chatgpt.com/oauth/authorize",
    copilot: "https://github.com/login/oauth/authorize",
    xai: "https://accounts.x.ai/oauth/authorize"
  };
  const url = new URL(bases[provider] ?? "https://auth.local/oauth/authorize");
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

async function cancelProviderOAuth(store, provider) {
  const preferences = rpcPreferences(await store.readPreferences());
  const providerAuth = {
    ...(preferences.providerAuth ?? {}),
    [provider]: { authenticated: false, status: "cancelled", pending: null, updatedAt: new Date().toISOString() }
  };
  await store.writePreferences({ providerAuth });
  return providerAuth[provider];
}

async function logoutProviderOAuth(store, provider) {
  const preferences = rpcPreferences(await store.readPreferences());
  const providerAuth = {
    ...(preferences.providerAuth ?? {}),
    [provider]: { authenticated: false, status: "signed_out", pending: null, updatedAt: new Date().toISOString() }
  };
  await store.writePreferences({ providerAuth });
  return providerAuth[provider];
}

async function providerDeviceCode(store, provider, input = {}) {
  const ttlMs = input.ttlMs ?? (input.expiresInSecs ? Number(input.expiresInSecs) * 1000 : undefined);
  const code = await generateMessagingCode(store, {
    platform: provider,
    kind: "device",
    code: input.code,
    ttlMs
  });
  const verificationUri = input.verificationUri ?? input.verificationUrl ?? providerDeviceVerificationUri(provider);
  const deviceFlow = {
    id: code.id,
    provider,
    deviceCode: code.code,
    userCode: input.userCode ?? code.code,
    verificationUri,
    verificationUrl: verificationUri,
    expiresAt: code.expiresAt,
    intervalSecs: Number(input.intervalSecs ?? 5),
    status: "pending",
    mode: "local-state",
    createdAt: code.createdAt
  };
  const preferences = rpcPreferences(await store.readPreferences());
  const providerAuth = {
    ...(preferences.providerAuth ?? {}),
    [provider]: {
      authenticated: false,
      status: "device_code_pending",
      pending: deviceFlow,
      updatedAt: code.createdAt
    }
  };
  await store.writePreferences({ providerAuth });
  return deviceFlow;
}

function providerDeviceVerificationUri(provider) {
  if (provider === "copilot") return "https://github.com/login/device";
  if (provider === "xai") return "https://accounts.x.ai/device";
  return null;
}

function normalizeBrowserPane(input = {}, existing = {}) {
  const now = new Date().toISOString();
  const url = input.url ?? input.href ?? existing.url ?? "about:blank";
  const history = Array.isArray(existing.history) && existing.history.length ? existing.history : [url];
  const historyIndex = Number.isInteger(existing.historyIndex) ? existing.historyIndex : history.length - 1;
  return {
    id: input.id ?? input.paneId ?? existing.id ?? `browser_pane_${crypto.randomUUID()}`,
    url,
    title: input.title ?? existing.title ?? (url === "about:blank" ? "New tab" : url),
    loading: Boolean(input.loading ?? existing.loading ?? false),
    focused: Boolean(input.focused ?? existing.focused ?? false),
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex < history.length - 1,
    history,
    historyIndex,
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
    snapshot: input.snapshot ?? existing.snapshot ?? null,
    snapshotStatus: input.snapshotStatus ?? existing.snapshotStatus ?? null,
    snapshotAt: input.snapshotAt ?? existing.snapshotAt ?? null,
    contentType: input.contentType ?? existing.contentType ?? null,
    statusCode: input.statusCode ?? existing.statusCode ?? null,
    lastInteractedAt: existing.lastInteractedAt ?? null,
    reloadedAt: existing.reloadedAt ?? null,
    stoppedAt: existing.stoppedAt ?? null
  };
}

function browserPaneList(preferences) {
  const panes = (preferences.browserPanes ?? []).map((pane) => normalizeBrowserPane({}, pane));
  return {
    panes,
    activeId: preferences.activeBrowserPaneId ?? panes.find((pane) => pane.focused)?.id ?? panes[0]?.id ?? null,
    activePaneId: preferences.activeBrowserPaneId ?? panes.find((pane) => pane.focused)?.id ?? panes[0]?.id ?? null
  };
}

async function saveBrowserPanes(store, panes, activeId = null) {
  const normalized = panes.map((pane) => normalizeBrowserPane({}, pane));
  const preferredActiveId = activeId ?? normalized.find((pane) => pane.focused)?.id ?? normalized[0]?.id ?? null;
  const nextPanes = normalized.map((pane) => ({ ...pane, focused: pane.id === preferredActiveId }));
  const saved = await store.writePreferences({ browserPanes: nextPanes, activeBrowserPaneId: preferredActiveId });
  return browserPaneList(rpcPreferences(saved));
}

async function createBrowserPane(store, input = {}, runtime = null) {
  const preferences = rpcPreferences(await store.readPreferences());
  const snapshot = await maybeBrowserSnapshot(input.url ?? input.href ?? "about:blank", input, runtime);
  const pane = normalizeBrowserPane({ ...input, ...snapshot, focused: true });
  const current = (preferences.browserPanes ?? []).map((existing) => ({ ...existing, focused: false }));
  const list = await saveBrowserPanes(store, [pane, ...current], pane.id);
  return { ...pane, focused: true, list };
}

function browserPaneId(input = {}) {
  return input.paneId ?? input.browserPaneId ?? input.id ?? input;
}

async function updateBrowserPane(store, input = {}, patch = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const paneId = browserPaneId(input);
  const panes = preferences.browserPanes ?? [];
  const index = panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) return { ok: false, reason: "browser_pane_not_found", paneId };
  const nextPane = normalizeBrowserPane({ ...patch, id: paneId }, { ...panes[index], ...patch });
  const nextPanes = panes.map((pane, paneIndex) => paneIndex === index ? nextPane : pane);
  await saveBrowserPanes(store, nextPanes, preferences.activeBrowserPaneId);
  return nextPane;
}

async function navigateBrowserPane(store, input = {}, runtime = null) {
  const preferences = rpcPreferences(await store.readPreferences());
  const paneId = browserPaneId(input);
  const url = required(input.url ?? input.href, "url");
  const panes = preferences.browserPanes ?? [];
  const index = panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) return createBrowserPane(store, { ...input, url });
  const pane = normalizeBrowserPane({}, panes[index]);
  const history = [...pane.history.slice(0, pane.historyIndex + 1), url];
  const snapshot = await maybeBrowserSnapshot(url, input, runtime);
  const nextPane = normalizeBrowserPane({ ...input, ...snapshot, id: pane.id, url, title: input.title ?? snapshot.title ?? url }, {
    ...pane,
    url,
    title: input.title ?? snapshot.title ?? url,
    loading: false,
    history,
    historyIndex: history.length - 1
  });
  const nextPanes = panes.map((item, itemIndex) => itemIndex === index ? nextPane : item);
  await saveBrowserPanes(store, nextPanes, preferences.activeBrowserPaneId);
  return nextPane;
}

async function maybeBrowserSnapshot(url, input = {}, runtime = null) {
  if (input.snapshot !== true) return {};
  const fetchImpl = runtime?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { snapshotStatus: "unavailable", snapshotAt: new Date().toISOString(), snapshot: null };
  }
  try {
    const response = await fetchImpl(url, { headers: { accept: "text/html,text/plain,*/*;q=0.8" } });
    const contentTypeHeader = response.headers?.get?.("content-type") ?? response.headers?.["content-type"] ?? "";
    const body = await response.text();
    const clipped = body.slice(0, 256 * 1024);
    const snapshot = summarizeBrowserSnapshot(clipped, contentTypeHeader);
    return {
      title: snapshot.title ?? undefined,
      snapshot,
      snapshotStatus: response.ok ? "loaded" : "http_error",
      snapshotAt: new Date().toISOString(),
      contentType: contentTypeHeader || null,
      statusCode: response.status ?? null
    };
  } catch (error) {
    return {
      snapshot: { title: null, excerpt: "", textLength: 0, error: error.message },
      snapshotStatus: "failed",
      snapshotAt: new Date().toISOString(),
      statusCode: null
    };
  }
}

function summarizeBrowserSnapshot(body, contentType = "") {
  const text = String(body ?? "");
  const title = decodeHtmlEntities((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim()) || null;
  const withoutScripts = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const plainText = decodeHtmlEntities(withoutScripts).replace(/\s+/g, " ").trim();
  return {
    title,
    excerpt: plainText.slice(0, 1000),
    textLength: plainText.length,
    contentType: contentType || null
  };
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

async function reloadBrowserPane(store, input = {}, runtime = null) {
  const preferences = rpcPreferences(await store.readPreferences());
  const paneId = browserPaneId(input);
  const pane = (preferences.browserPanes ?? []).find((item) => item.id === paneId);
  if (!pane) return { ok: false, reason: "browser_pane_not_found", paneId };
  const snapshot = await maybeBrowserSnapshot(pane.url, { ...input, snapshot: input.snapshot ?? true }, runtime);
  return updateBrowserPane(store, input, { ...snapshot, reloadedAt: new Date().toISOString(), loading: false });
}

async function moveBrowserPaneHistory(store, input = {}, delta = 0) {
  const preferences = rpcPreferences(await store.readPreferences());
  const paneId = browserPaneId(input);
  const panes = preferences.browserPanes ?? [];
  const index = panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) return { ok: false, reason: "browser_pane_not_found", paneId };
  const pane = normalizeBrowserPane({}, panes[index]);
  const nextIndex = Math.max(0, Math.min(pane.history.length - 1, pane.historyIndex + delta));
  const nextPane = normalizeBrowserPane({}, {
    ...pane,
    url: pane.history[nextIndex] ?? pane.url,
    title: pane.history[nextIndex] ?? pane.title,
    historyIndex: nextIndex,
    loading: false
  });
  const nextPanes = panes.map((item, itemIndex) => itemIndex === index ? nextPane : item);
  await saveBrowserPanes(store, nextPanes, preferences.activeBrowserPaneId);
  return nextPane;
}

async function focusBrowserPane(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const paneId = browserPaneId(input);
  const panes = preferences.browserPanes ?? [];
  const pane = panes.find((item) => item.id === paneId);
  if (!pane) return { ok: false, reason: "browser_pane_not_found", paneId };
  await saveBrowserPanes(store, panes, paneId);
  return { ...normalizeBrowserPane({}, pane), focused: true };
}

async function destroyBrowserPane(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const paneId = browserPaneId(input);
  const panes = preferences.browserPanes ?? [];
  const removed = panes.find((pane) => pane.id === paneId) ?? null;
  const next = panes.filter((pane) => pane.id !== paneId);
  const activeId = preferences.activeBrowserPaneId === paneId ? next[0]?.id ?? null : preferences.activeBrowserPaneId;
  const list = await saveBrowserPanes(store, next, activeId);
  return { ok: true, removed, list };
}

function computerUseStatus(preferences) {
  const state = preferences.computerUsePermission ?? {};
  const permission = state.permission ?? "prompt";
  const enabled = Boolean(preferences.computerUseEnabled);
  const available = enabled && permission === "granted";
  return {
    available,
    enabled,
    permission,
    status: available ? "ready" : state.status ?? "not_requested",
    requestedAt: state.requestedAt ?? null,
    openedAt: state.openedAt ?? null,
    updatedAt: state.updatedAt ?? null,
    reason: available ? null : (enabled ? "permission_required" : "computer_use_disabled")
  };
}

async function updateComputerUsePermission(store, channel, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const previous = preferences.computerUsePermission ?? {};
  const now = new Date().toISOString();
  const requestedPermission = input.permission ?? input.status ?? null;
  const permission = ["granted", "denied", "prompt"].includes(requestedPermission)
    ? requestedPermission
    : previous.permission ?? "prompt";
  const status = permission === "granted"
    ? "ready"
    : permission === "denied"
      ? "denied"
      : channel === "computerUse:openPermissionPane"
        ? "opened"
        : "requested";
  const computerUsePermission = {
    permission,
    status,
    requestedAt: previous.requestedAt ?? now,
    openedAt: channel === "computerUse:openPermissionPane" ? now : previous.openedAt ?? null,
    updatedAt: now,
    source: input.source ?? "rpc"
  };
  const next = await store.writePreferences({ computerUsePermission });
  return {
    ok: true,
    requested: channel === "computerUse:requestPermissions",
    opened: channel === "computerUse:openPermissionPane",
    ...computerUseStatus(rpcPreferences(next))
  };
}

async function remoteConnectionStatus(input = {}, runtime = {}) {
  const target = input.url ?? input.endpoint ?? input.host ?? null;
  if (!target) {
    return {
      ok: false,
      status: "unavailable",
      target: null,
      reason: "remote_target_missing"
    };
  }
  const startedAt = Date.now();
  const timeoutMs = Number(input.timeoutMs ?? 5_000);
  const method = input.method ?? "GET";
  const fetchImpl = runtime.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      available: false,
      status: "unavailable",
      target,
      method,
      reason: "fetch_unavailable",
      checkedAt: new Date().toISOString()
    };
  }
  try {
    const response = await fetchImpl(target, {
      method,
      headers: input.headers ?? {},
      signal: AbortSignal.timeout(timeoutMs)
    });
    const latencyMs = Date.now() - startedAt;
    return {
      ok: response.ok,
      available: response.ok,
      status: response.ok ? "connected" : "http_error",
      target,
      method,
      statusCode: response.status,
      statusText: response.statusText,
      latencyMs,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      available: false,
      status: error.name === "TimeoutError" ? "timeout" : "failed",
      target,
      method,
      error: error.message,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString()
    };
  }
}

function rtkStatus(preferences) {
  const enabled = Boolean(preferences.rtkEnabled);
  const state = preferences.rtkState ?? {};
  return {
    enabled,
    gain: Number(preferences.rtkGain ?? 1),
    status: enabled ? "local" : "disabled",
    available: true,
    mode: "local-state",
    enabledAt: state.enabledAt ?? null,
    disabledAt: state.disabledAt ?? null,
    updatedAt: state.updatedAt ?? null,
    source: state.source ?? "default"
  };
}

async function setRtkEnabled(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const enabled = Boolean(input.enabled ?? input);
  const now = new Date().toISOString();
  const rtkState = {
    ...(preferences.rtkState ?? {}),
    status: enabled ? "local" : "disabled",
    enabledAt: enabled ? now : preferences.rtkState?.enabledAt ?? null,
    disabledAt: enabled ? preferences.rtkState?.disabledAt ?? null : now,
    updatedAt: now,
    source: input.source ?? "rpc"
  };
  const next = await store.writePreferences({ rtkEnabled: enabled, rtkState });
  return rtkStatus(rpcPreferences(next));
}

function desktopUpdateStatus(preferences, channel = "update:getInfo") {
  return {
    ...preferences.updateInfo,
    checkedAt: channel === "update:check" ? new Date().toISOString() : preferences.updateInfo.checkedAt ?? null,
    dismissed: preferences.updateDismissed
  };
}

async function checkDesktopUpdate(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const latest = input.latestVersion ?? input.version ?? latestReleaseNote()?.id ?? preferences.updateInfo.latestVersion ?? VERSION;
  const current = input.currentVersion ?? preferences.updateInfo.currentVersion ?? VERSION;
  const available = compareVersionIds(String(latest), String(current)) > 0;
  const updateInfo = {
    ...preferences.updateInfo,
    available,
    currentVersion: current,
    latestVersion: latest,
    releaseUrl: input.releaseUrl ?? preferences.updateInfo.releaseUrl ?? latestReleaseNote()?.path ?? null,
    status: available ? "available" : "current",
    checkedAt: new Date().toISOString(),
    downloadProgress: available
      ? { status: "idle", percent: 0, bytesDownloaded: 0, totalBytes: Number(input.totalBytes ?? 0) }
      : { status: "idle", percent: 0, bytesDownloaded: 0, totalBytes: 0 }
  };
  return (await store.writePreferences({ updateInfo })).updateInfo;
}

async function downloadDesktopUpdate(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const totalBytes = Number(input.totalBytes ?? preferences.updateInfo.downloadProgress?.totalBytes ?? 0);
  const now = new Date().toISOString();
  const downloadProgress = {
    status: "completed",
    percent: 100,
    bytesDownloaded: totalBytes,
    totalBytes,
    startedAt: input.startedAt ?? now,
    completedAt: now
  };
  const updateInfo = {
    ...preferences.updateInfo,
    available: preferences.updateInfo.available === true,
    status: preferences.updateInfo.available === true ? "downloaded" : preferences.updateInfo.status ?? "current",
    downloadProgress,
    downloadedAt: now,
    artifactPath: input.artifactPath ?? preferences.updateInfo.artifactPath ?? null
  };
  return (await store.writePreferences({ updateInfo })).updateInfo;
}

async function installDesktopUpdate(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const targetVersion = input.version ?? preferences.updateInfo.latestVersion ?? preferences.updateInfo.currentVersion ?? VERSION;
  const installed = compareVersionIds(String(targetVersion), String(preferences.updateInfo.currentVersion ?? VERSION)) >= 0;
  const updateInfo = {
    ...preferences.updateInfo,
    ok: true,
    available: false,
    currentVersion: installed ? targetVersion : preferences.updateInfo.currentVersion,
    latestVersion: targetVersion,
    status: installed ? "installed" : "current",
    installedAt: now,
    installMode: "local-state",
    downloadProgress: {
      ...(preferences.updateInfo.downloadProgress ?? {}),
      status: "completed",
      percent: 100
    }
  };
  return (await store.writePreferences({ updateInfo })).updateInfo;
}

async function dismissUpdate(store, input = {}) {
  const dismissed = {
    version: input.version ?? input.latestVersion ?? null,
    reason: input.reason ?? null,
    dismissedAt: new Date().toISOString()
  };
  return (await store.writePreferences({ updateDismissed: dismissed })).updateDismissed;
}

function pilotStatus(preferences, channel = "pilot:getStatus") {
  return {
    ...preferences.pilotState,
    checkedAt: channel === "pilot:checkUpdate" ? new Date().toISOString() : preferences.pilotState.checkedAt ?? null
  };
}

async function setPilotStatus(store, status, reason = null) {
  const preferences = rpcPreferences(await store.readPreferences());
  const installed = status === "running" || status === "stopped"
    ? true
    : preferences.pilotState.installed === true;
  const pilotState = {
    ...preferences.pilotState,
    running: status === "running",
    installed,
    status,
    reason: reason ?? (installed ? null : preferences.pilotState.reason ?? null),
    updatedAt: new Date().toISOString()
  };
  await store.writePreferences({ pilotState });
  return pilotState;
}

async function installPilotRuntime(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const pilotState = {
    ...preferences.pilotState,
    installed: true,
    running: false,
    status: "stopped",
    reason: null,
    version: input.version ?? preferences.pilotState.version ?? "local",
    installMode: "local-state",
    installedAt: preferences.pilotState.installedAt ?? now,
    updatedAt: now
  };
  await store.writePreferences({ pilotState });
  return pilotState;
}

async function openPilotDashboard(store, input = {}) {
  const preferences = rpcPreferences(await store.readPreferences());
  const now = new Date().toISOString();
  const dashboard = {
    ...(preferences.pilotState.dashboard ?? {}),
    opened: true,
    route: input.route ?? input.path ?? "dashboard",
    openedAt: now
  };
  const pilotState = {
    ...preferences.pilotState,
    installed: preferences.pilotState.installed === true,
    status: preferences.pilotState.running ? "running" : (preferences.pilotState.installed ? "stopped" : preferences.pilotState.status ?? "unavailable"),
    dashboard,
    updatedAt: now
  };
  await store.writePreferences({ pilotState });
  return { ...pilotState, opened: true, dashboard };
}

function redactMessagingSecrets(input = {}) {
  const output = { ...input };
  for (const key of Object.keys(output)) {
    if (/token|secret|password|key/i.test(key)) {
      output[key] = output[key] ? "***" : output[key];
      output[`has${key[0].toUpperCase()}${key.slice(1)}`] = Boolean(input[key]);
    }
  }
  return output;
}

function slugFromInput(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function safeFileName(value) {
  return pathModule.basename(String(value ?? "asset.txt")).replace(/[^\w.-]+/g, "_") || "asset.txt";
}

async function savePreferenceListItem(store, key, item) {
  const preferences = rpcPreferences(await store.readPreferences());
  const id = item.id ?? `${key}_${crypto.randomUUID()}`;
  const current = Array.isArray(preferences[key]) ? preferences[key] : [];
  const nextItem = { ...item, id, updatedAt: new Date().toISOString() };
  const next = current.some((entry) => entry.id === id)
    ? current.map((entry) => entry.id === id ? { ...entry, ...nextItem } : entry)
    : [nextItem, ...current];
  return (await store.writePreferences({ [key]: next }))[key];
}

async function deletePreferenceListItem(store, key, id) {
  const preferences = rpcPreferences(await store.readPreferences());
  const next = (Array.isArray(preferences[key]) ? preferences[key] : []).filter((entry) => entry.id !== id);
  return (await store.writePreferences({ [key]: next }))[key];
}

function frequentTerminalCommands(records, hiddenCommands = []) {
  const hidden = new Set(hiddenCommands.map((command) => String(command).trim()).filter(Boolean));
  const counts = new Map();
  for (const record of records) {
    const command = String(record.command ?? "").trim();
    if (!command) continue;
    if (hidden.has(command)) continue;
    const current = counts.get(command) ?? { command, count: 0, lastUsedAt: record.startedAt ?? record.createdAt ?? null };
    current.count += 1;
    if (record.startedAt && (!current.lastUsedAt || record.startedAt > current.lastUsedAt)) current.lastUsedAt = record.startedAt;
    counts.set(command, current);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || String(b.lastUsedAt ?? "").localeCompare(String(a.lastUsedAt ?? ""))).slice(0, 20);
}

async function readWorkspaceText(workspace, requestedPath) {
  return readFile(resolveInsideWorkspace(workspace, required(requestedPath, "path")), "utf8");
}

async function readWorkspaceDataUrl(workspace, requestedPath) {
  const filePath = resolveInsideWorkspace(workspace, required(requestedPath, "path"));
  const body = await readFile(filePath);
  return `data:${contentType(filePath)};base64,${body.toString("base64")}`;
}

async function readWorkspaceBinaryEnvelope(workspace, requestedPath) {
  const body = await readFile(resolveInsideWorkspace(workspace, required(requestedPath, "path")));
  return { __craftRpcType: "u8", base64: body.toString("base64") };
}

async function fileRpc(workspace, channel, input = {}) {
  const command = channel.split(":")[1];
  if (command === "openDialog") {
    return openWorkspaceFileDialog(workspace, input);
  }
  if (command === "readAttachment" || command === "readUserAttachment") {
    const requestedPath = input.path ?? input.filePath ?? input.attachmentPath ?? input.id ?? input;
    return readWorkspaceBinaryEnvelope(workspace, requestedPath);
  }
  if (command === "storeAttachment") {
    const fileName = safeFileName(input.fileName ?? input.name ?? `${crypto.randomUUID()}.bin`);
    const directory = resolveInsideWorkspace(workspace, input.directory ?? ".peng/attachments");
    await mkdir(directory, { recursive: true });
    const filePath = pathModule.join(directory, fileName);
    const body = decodeAttachmentBody(input.dataUrl ?? input.base64 ?? input.content ?? input.bytes ?? "");
    await writeFile(filePath, body);
    const fileStat = await stat(filePath);
    return {
      ok: true,
      path: pathModule.relative(workspace, filePath),
      fileName,
      size: fileStat.size,
      contentType: contentType(filePath),
      updatedAt: fileStat.mtime.toISOString()
    };
  }
  if (command === "generateThumbnail") {
    const requestedPath = input.path ?? input.filePath ?? input;
    const dataUrl = await readWorkspaceDataUrl(workspace, requestedPath);
    return {
      ok: true,
      path: pathModule.relative(workspace, resolveInsideWorkspace(workspace, required(requestedPath, "path"))),
      thumbnail: dataUrl,
      dataUrl,
      generatedBy: "clean-room-data-url"
    };
  }
  if (command === "exists") {
    const requestedPath = input.path ?? input.filePath ?? input;
    const filePath = resolveInsideWorkspace(workspace, required(requestedPath, "path"));
    try {
      const fileStat = await stat(filePath);
      return { ok: true, exists: true, file: workspaceFileInfo(workspace, filePath, fileStat) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { ok: true, exists: false, path: pathModule.relative(workspace, filePath) || "." };
    }
  }
  if (command === "stat" || command === "getInfo") {
    const requestedPath = input.path ?? input.filePath ?? input;
    const filePath = resolveInsideWorkspace(workspace, required(requestedPath, "path"));
    return { ok: true, file: workspaceFileInfo(workspace, filePath, await stat(filePath)) };
  }
  if (command === "write" || command === "writeText" || command === "writeDataUrl") {
    return writeWorkspaceFileEnvelope(workspace, input, command);
  }
  if (command === "delete" || command === "unlink" || command === "remove") {
    const requestedPath = input.path ?? input.filePath ?? input;
    const filePath = resolveInsideWorkspace(workspace, required(requestedPath, "path"));
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return { ok: false, deleted: false, reason: "path_is_not_file", file: workspaceFileInfo(workspace, filePath, fileStat) };
    await unlink(filePath);
    return { ok: true, deleted: true, path: pathModule.relative(workspace, filePath) || "." };
  }
  return { ok: false, reason: "file_rpc_unavailable", command };
}

async function writeWorkspaceFileEnvelope(workspace, input = {}, command = "write") {
  const requestedPath = required(input.path ?? input.filePath ?? input.name, "path");
  const filePath = resolveInsideWorkspace(workspace, requestedPath);
  const body = command === "writeText"
    ? Buffer.from(String(input.text ?? input.content ?? ""), "utf8")
    : decodeAttachmentBody(input.dataUrl ?? input.base64 ?? input.content ?? input.text ?? input.bytes ?? "");
  await mkdir(pathModule.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  return { ok: true, written: true, file: workspaceFileInfo(workspace, filePath, await stat(filePath)) };
}

function workspaceFileInfo(workspace, filePath, fileStat) {
  return {
    path: pathModule.relative(workspace, filePath) || ".",
    name: pathModule.basename(filePath),
    type: fileStat.isDirectory() ? "directory" : "file",
    size: fileStat.size,
    contentType: fileStat.isFile() ? contentType(filePath) : null,
    updatedAt: fileStat.mtime.toISOString()
  };
}

async function openWorkspaceFileDialog(workspace, input = {}) {
  const root = input.defaultPath ?? input.path ?? ".";
  const rootPath = resolveInsideWorkspace(workspace, root);
  const rootStat = await stat(rootPath);
  const directoryPath = rootStat.isDirectory() ? rootPath : pathModule.dirname(rootPath);
  const entries = await listWorkspaceDirectory(workspace, pathModule.relative(workspace, directoryPath) || ".");
  const extensions = fileDialogExtensions(input);
  const files = entries.filter((entry) =>
    entry.type === "file" &&
    (extensions.length === 0 || extensions.includes(pathModule.extname(entry.name).replace(/^\./, "").toLowerCase()))
  );
  const selected = input.selectDirectory === true
    ? pathModule.relative(workspace, directoryPath) || "."
    : files[0]?.path ?? null;
  return {
    ok: true,
    cancelled: selected == null,
    defaultPath: pathModule.relative(workspace, rootPath) || ".",
    directory: pathModule.relative(workspace, directoryPath) || ".",
    selected,
    path: selected,
    files,
    entries: files,
    filters: extensions,
    mode: "workspace-local"
  };
}

function fileDialogExtensions(input = {}) {
  const rawFilters = input.filters ?? input.extensions ?? input.allowedExtensions ?? [];
  const values = Array.isArray(rawFilters) ? rawFilters : [rawFilters];
  return values.flatMap((filter) => {
    if (typeof filter === "string") return [filter];
    if (Array.isArray(filter?.extensions)) return filter.extensions;
    if (Array.isArray(filter?.patterns)) return filter.patterns;
    return [];
  }).map((value) => String(value).replace(/^\*\./, "").replace(/^\./, "").toLowerCase()).filter(Boolean);
}

async function workspaceFilesForRpc(workspace, input = {}) {
  const root = input.root ?? input.path ?? ".";
  const entries = await listWorkspaceDirectory(workspace, root);
  return {
    root,
    files: entries,
    entries,
    workspace
  };
}

async function readWorkspaceImageEnvelope(workspace, requestedPath) {
  const filePath = resolveInsideWorkspace(workspace, required(requestedPath, "path"));
  const body = await readFile(filePath);
  return {
    path: pathModule.relative(workspace, filePath) || ".",
    contentType: contentType(filePath),
    dataUrl: `data:${contentType(filePath)};base64,${body.toString("base64")}`,
    binary: { __craftRpcType: "u8", base64: body.toString("base64") }
  };
}

async function writeWorkspaceImageEnvelope(workspace, input = {}) {
  const requestedPath = required(input.path ?? input.filePath ?? input.name, "path");
  const filePath = resolveInsideWorkspace(workspace, requestedPath);
  const body = decodeImageBody(input.dataUrl ?? input.base64 ?? input.content ?? input.bytes);
  await mkdir(pathModule.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  const fileStat = await stat(filePath);
  return {
    ok: true,
    path: pathModule.relative(workspace, filePath) || ".",
    size: fileStat.size,
    contentType: contentType(filePath),
    updatedAt: fileStat.mtime.toISOString()
  };
}

function decodeImageBody(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object" && typeof value.base64 === "string") return Buffer.from(value.base64, "base64");
  const text = required(value, "image data");
  if (typeof text !== "string") return Buffer.from(text);
  const match = text.match(/^data:[^;]+;base64,(.*)$/);
  return Buffer.from(match ? match[1] : text, "base64");
}

function decodeAttachmentBody(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object" && typeof value.base64 === "string") return Buffer.from(value.base64, "base64");
  if (typeof value !== "string") return Buffer.from(String(value ?? ""), "utf8");
  const match = value.match(/^data:[^;]+;base64,(.*)$/);
  return match ? Buffer.from(match[1], "base64") : Buffer.from(value, "base64");
}

async function listWorkspaceDirectory(workspace, requestedPath) {
  const directory = resolveInsideWorkspace(workspace, requestedPath);
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => {
    const filePath = pathModule.join(directory, entry.name);
    const fileStat = await stat(filePath);
    return {
      name: entry.name,
      path: pathModule.relative(workspace, filePath) || ".",
      type: entry.isDirectory() ? "directory" : "file",
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString()
    };
  }));
}

function workspacePermissionState(workspace) {
  const defaults = mergeConfig().workspaceDefaults;
  return {
    workspaceId: workspace.id,
    root: workspace.root,
    permissionMode: workspace.config?.permissionMode ?? defaults.permissionMode,
    cyclablePermissionModes: workspace.config?.cyclablePermissionModes ?? defaults.cyclablePermissionModes,
    allowedTools: workspace.permissions?.allowedTools ?? [],
    deniedTools: workspace.permissions?.deniedTools ?? [],
    safeMode: (workspace.config?.permissionMode ?? defaults.permissionMode) !== "allow-all"
  };
}

function resolveInsideWorkspace(workspace, requestedPath) {
  const target = pathModule.resolve(workspace, requestedPath);
  const root = pathModule.resolve(workspace);
  if (target !== root && !target.startsWith(`${root}${pathModule.sep}`)) {
    const error = new Error(`Path escapes workspace: ${requestedPath}`);
    error.code = "FORBIDDEN";
    throw error;
  }
  return target;
}

function normalizeWebSocketMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const error = new Error("WebSocket message must be a JSON object.");
    error.code = "bad_request";
    throw error;
  }
  const originalType = raw.type ?? raw.event ?? raw.kind ?? raw.action ?? raw.command;
  const type = normalizeWebSocketType(originalType);
  const payload = raw.payload ?? raw.data ?? raw.params ?? raw.arguments ?? topLevelPayload(raw);
  return {
    id: raw.id ?? raw.requestId ?? raw.request_id ?? raw.correlationId ?? raw.correlation_id ?? null,
    type,
    originalType,
    payload
  };
}

function normalizeWebSocketType(type) {
  const value = String(type ?? "").trim();
  const aliases = {
    ping: "ping",
    pong: "ping",
    run: "run.start",
    start_run: "run.start",
    "run:start": "run.start",
    runStart: "run.start",
    "run.start": "run.start",
    message: "thread.message",
    queue_message: "thread.message",
    "message.queue": "thread.message",
    "thread.message": "thread.message",
    stop: "thread.stop",
    stop_run: "thread.stop",
    "run.stop": "thread.stop",
    "thread.stop": "thread.stop",
    replay_queue: "thread.replayQueue",
    "queue.replay": "thread.replayQueue",
    "thread.replayQueue": "thread.replayQueue"
  };
  return aliases[value] ?? value;
}

function topLevelPayload(raw) {
  const payload = {};
  for (const [key, value] of Object.entries(raw)) {
    if (["id", "requestId", "request_id", "correlationId", "correlation_id", "type", "event", "kind", "action", "command"].includes(key)) continue;
    payload[key] = value;
  }
  return payload;
}

function webSocketEvent(type, payload) {
  return {
    type,
    event: type,
    ok: true,
    payload,
    data: payload,
    createdAt: new Date().toISOString()
  };
}

function webSocketResponse({ id = null, type, payload }) {
  return {
    id,
    requestId: id,
    type,
    event: type,
    ok: true,
    payload,
    data: payload,
    createdAt: new Date().toISOString()
  };
}

function webSocketError({ id = null, message, code }) {
  return {
    id,
    requestId: id,
    type: "error",
    event: "error",
    ok: false,
    error: { message, code },
    createdAt: new Date().toISOString()
  };
}

function encodeWebSocketFrame(data, { opcode = 0x1 } = {}) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xFFFF) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeWebSocketCloseFrame() {
  return encodeWebSocketFrame(Buffer.alloc(0), { opcode: 0x8 });
}

function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0F;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7F;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large.");
    length = Number(bigLength);
    offset += 8;
  }
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, bytes: offset + length };
}

function stripTrailingSlash(path) {
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function providerProfileFromQuery(url) {
  return {
    ...providerProfileFromId(url.searchParams.get("profile")),
    ...(url.searchParams.get("baseUrl") ? { baseUrl: url.searchParams.get("baseUrl") } : {}),
    ...(url.searchParams.get("type") ? { type: url.searchParams.get("type") } : {})
  };
}

function providerProfileFromId(id) {
  return listProviderProfiles().find((profile) => profile.id === id) ?? { id: id ?? "openai-compatible", type: id ?? "openai-compatible" };
}

function required(value, name) {
  if (value === undefined || value === null || value === "") {
    const error = new Error(`Missing required field: ${name}`);
    error.status = 400;
    throw error;
  }
  return value;
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

async function viewSource(store, entity) {
  if (entity === "tasks") return store.listTasks();
  if (entity === "projects") return store.listProjects();
  if (entity === "threads") return store.listThreads();
  return store.listSessions();
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

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders()
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendEmpty(response, status) {
  response.writeHead(status, corsHeaders());
  response.end();
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function statusFromError(error) {
  if (error.status) return error.status;
  if (error.code === "permission_denied") return 403;
  if (error.code === "ENOENT") return 404;
  if (error instanceof SyntaxError) return 400;
  return 500;
}
