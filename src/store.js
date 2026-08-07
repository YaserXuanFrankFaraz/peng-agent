import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { EMPTY_AUTOMATION_CONFIG } from "./automations.js";
import { atomicWriteJson, backupUnreadableFile, credentialFile, summarizeCredential } from "./credentials.js";
import { createWorkspace } from "./domain.js";
import { buildKnowledgeMaintenanceReport, buildKnowledgeReport, buildSemanticIndex, createSemanticIndexJob, defaultSemanticState, indexKnowledgeCollection, inspectKnowledgeCollection, searchKnowledgeDocuments, searchSemanticIndex, semanticEngineStatusFromState, updateSemanticState } from "./knowledge.js";
import { EMPTY_LABEL_CONFIG } from "./labels.js";
import { applyMemoryCitationUsage, buildMemoryMaintenanceReport, consolidateMemories, createMemoryRecord, parseMemoryCitations, pruneMemories, renderMemoriesJsonl, renderMemoriesMarkdown, renderMemoryContext, scanMemoryCitations, searchMemories } from "./memory.js";
import { createCredentialBackendFromEnv, deserializeSecret, serializeSecret } from "./secure-credentials.js";
import { DEFAULT_STATUS_CONFIG } from "./statuses.js";
import { attachTerminalRecordToSession, closeTerminalSession } from "./terminal.js";

export class JsonStore {
  constructor({
    workspace,
    folder = ".peng",
    credentialBackend = createCredentialBackendFromEnv(),
    craftUserMemoriesDir = process.env.PENG_CRAFT_USER_MEMORIES_DIR ?? path.join(homedir(), ".craft-agent", "memories")
  }) {
    this.workspacePath = workspace;
    this.credentialBackend = credentialBackend;
    this.root = path.join(workspace, folder);
    this.threadsDir = path.join(this.root, "threads");
    this.sessionsDir = path.join(this.root, "sessions");
    this.projectsDir = path.join(this.root, "projects");
    this.tasksDir = path.join(this.root, "tasks");
    this.viewsDir = path.join(this.root, "views");
    this.knowledgeCollectionsDir = path.join(this.root, "knowledge", "collections");
    this.knowledgeDocumentsDir = path.join(this.root, "knowledge", "documents");
    this.knowledgeSemanticStateFile = path.join(this.root, "knowledge", "semantic-state.json");
    this.terminalDir = path.join(this.root, "terminal");
    this.terminalSessionsDir = path.join(this.root, "terminal-sessions");
    this.protocolEventsDir = path.join(this.root, "protocol-events");
    this.queuedMessagesDir = path.join(this.root, "queued-messages");
    this.runControlDir = path.join(this.root, "run-control");
    this.eventsDir = path.join(this.root, "events");
    this.automationHistoryDir = path.join(this.root, "automation-history");
    this.workspaceFile = path.join(this.root, "workspace.json");
    this.statusesFile = path.join(this.root, "statuses.json");
    this.labelsFile = path.join(this.root, "labels.json");
    this.automationsFile = path.join(this.root, "automations.json");
    this.preferencesFile = path.join(this.root, "preferences.json");
    this.draftsFile = path.join(this.root, "drafts.json");
    this.credentialsFile = credentialFile(this.root);
    this.memoryFile = path.join(this.root, "memory.json");
    this.memoryDir = path.join(this.root, "memory");
    this.memoriesJsonlFile = path.join(this.memoryDir, "memories.jsonl");
    this.memoriesMarkdownFile = path.join(this.memoryDir, "MEMORIES.md");
    this.craftMemoriesDir = path.join(this.workspacePath, ".craft-agent", "memories");
    this.craftMemoriesJsonlFile = path.join(this.craftMemoriesDir, "memories.jsonl");
    this.craftMemoriesMarkdownFile = path.join(this.craftMemoriesDir, "MEMORIES.md");
    this.craftUserMemoriesDir = craftUserMemoriesDir;
    this.craftUserMemoriesJsonlFile = path.join(this.craftUserMemoriesDir, "memories.jsonl");
    this.craftUserMemoriesMarkdownFile = path.join(this.craftUserMemoriesDir, "MEMORIES.md");
  }

  async saveThread(thread) {
    await mkdir(this.threadsDir, { recursive: true });
    await writeFile(this.threadPath(thread.id), `${JSON.stringify(thread, null, 2)}\n`, "utf8");
  }

  async getThread(threadId) {
    const text = await readFile(this.threadPath(threadId), "utf8");
    return JSON.parse(text);
  }

  async listThreads() {
    await mkdir(this.threadsDir, { recursive: true });
    const files = await readdir(this.threadsDir);
    const threads = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const text = await readFile(path.join(this.threadsDir, file), "utf8");
      threads.push(JSON.parse(text));
    }
    return threads.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readMemory() {
    const records = await this.listMemoryRecords();
    return { facts: records.map((record) => ({ ...record, fact: record.text })) };
  }

  async writeMemory(memory) {
    await mkdir(this.memoryDir, { recursive: true });
    const records = (memory.facts ?? []).map((item) =>
      item.text && item.id ? item : createMemoryRecord({ text: item.fact ?? item.text, source: item.source ?? "legacy" })
    );
    await writeFile(this.memoriesJsonlFile, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
  }

  async appendMemoryRecord(record) {
    await mkdir(this.memoryDir, { recursive: true });
    await appendFile(this.memoriesJsonlFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  async saveMemoryRecords(records) {
    await mkdir(this.memoryDir, { recursive: true });
    await writeFile(this.memoriesJsonlFile, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
  }

  async listMemoryRecords() {
    try {
      const text = await readFile(this.memoriesJsonlFile, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    try {
      const legacy = JSON.parse(await readFile(this.memoryFile, "utf8"));
      return (legacy.facts ?? [])
        .map((item) => createMemoryRecord({ text: item.fact ?? item.text, source: item.source ?? "legacy", createdAt: item.createdAt }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async getMemoryRecord(memoryId) {
    const record = (await this.listMemoryRecords()).find((item) => item.id === memoryId);
    if (!record) {
      const error = new Error(`Memory not found: ${memoryId}`);
      error.code = "ENOENT";
      throw error;
    }
    return record;
  }

  async searchMemoryRecords(filter = {}) {
    return searchMemories(await this.listMemoryRecords(), filter);
  }

  async renderMemoryContext(filter = {}) {
    return renderMemoryContext(await this.listMemoryRecords(), filter);
  }

  async recordMemoryCitations(ids, { usedAt = new Date().toISOString() } = {}) {
    const records = await this.listMemoryRecords();
    const next = applyMemoryCitationUsage(records, ids, { usedAt });
    await this.saveMemoryRecords(next);
    return next.filter((record) => ids.includes(record.id));
  }

  async scanHistoricalMemoryCitations({ usedAt = new Date().toISOString() } = {}) {
    const citedIds = new Set();
    for (const thread of await this.listThreads()) {
      const assistantEvents = (thread.events ?? []).filter((event) => event.role === "assistant");
      for (const id of scanMemoryCitations(assistantEvents)) citedIds.add(id);
    }
    for (const event of await this.listProtocolEvents()) {
      if (!["assistant.message", "run.completed"].includes(event.type)) continue;
      for (const id of parseMemoryCitations(JSON.stringify(event.payload ?? {}))) citedIds.add(id);
    }
    if (citedIds.size === 0) return { ids: [], records: [] };
    return { ids: [...citedIds], records: await this.recordMemoryCitations([...citedIds], { usedAt }) };
  }

  async maintainMemory(options = {}) {
    const citationScan = options.scanCitations === true ? await this.scanHistoricalMemoryCitations({ usedAt: options.usedAt ?? options.generatedAt }) : null;
    const original = await this.listMemoryRecords();
    const consolidated = consolidateMemories(original);
    const unconstrained = pruneMemories(consolidated, { ...options, maxRemovedPerRun: null, maxRemovedRatio: null });
    const maintained = pruneMemories(consolidated, options);
    await this.saveMemoryRecords(maintained);
    const markdown = renderMemoriesMarkdown(maintained, options);
    await mkdir(this.memoryDir, { recursive: true });
    await writeFile(this.memoriesMarkdownFile, markdown, "utf8");
    const compatibility = options.compatibility === false ? null : await this.writeCraftMemoryCompatibility({
      records: maintained,
      markdown,
      userCompatibility: options.userCompatibility === true
    });
    return {
      records: maintained,
      report: buildMemoryMaintenanceReport(original, maintained, { unconstrainedCount: unconstrained.length }),
      markdownPath: this.memoriesMarkdownFile,
      compatibility,
      citationScan
    };
  }

  async writeCraftMemoryCompatibility({ records, markdown, userCompatibility = false }) {
    await mkdir(this.craftMemoriesDir, { recursive: true });
    await writeFile(this.craftMemoriesMarkdownFile, markdown, "utf8");
    await writeFile(this.craftMemoriesJsonlFile, renderMemoriesJsonl(records), "utf8");
    const workspace = {
      dir: this.craftMemoriesDir,
      markdownPath: this.craftMemoriesMarkdownFile,
      jsonlPath: this.craftMemoriesJsonlFile,
      recordCount: records.length
    };
    if (!userCompatibility) return workspace;
    return {
      ...workspace,
      workspace,
      userHome: await this.writeCraftUserMemoryCompatibility({ records, markdown })
    };
  }

  async writeCraftUserMemoryCompatibility({ records, markdown }) {
    await mkdir(this.craftUserMemoriesDir, { recursive: true });
    await writeFile(this.craftUserMemoriesMarkdownFile, markdown, "utf8");
    await writeFile(this.craftUserMemoriesJsonlFile, renderMemoriesJsonl(records), "utf8");
    return {
      dir: this.craftUserMemoriesDir,
      markdownPath: this.craftUserMemoriesMarkdownFile,
      jsonlPath: this.craftUserMemoriesJsonlFile,
      recordCount: records.length
    };
  }

  async getWorkspace() {
    try {
      return JSON.parse(await readFile(this.workspaceFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const workspace = createWorkspace({ root: this.workspacePath });
      await this.saveWorkspace(workspace);
      return workspace;
    }
  }

  async saveWorkspace(workspace) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
  }

  async getStatusConfig() {
    return this.readJsonOrDefault(this.statusesFile, DEFAULT_STATUS_CONFIG);
  }

  async saveStatusConfig(config) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.statusesFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  async getLabelConfig() {
    return this.readJsonOrDefault(this.labelsFile, EMPTY_LABEL_CONFIG);
  }

  async saveLabelConfig(config) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.labelsFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  async saveProject(project) {
    await mkdir(this.projectsDir, { recursive: true });
    await writeFile(this.projectPath(project.id), `${JSON.stringify(project, null, 2)}\n`, "utf8");
  }

  async getProject(projectId) {
    return JSON.parse(await readFile(this.projectPath(projectId), "utf8"));
  }

  async deleteProject(projectId) {
    await unlink(this.projectPath(projectId));
  }

  async listProjects() {
    const projects = await this.listJsonFiles(this.projectsDir);
    return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveTask(task) {
    await mkdir(this.tasksDir, { recursive: true });
    await writeFile(this.taskPath(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  async getTask(taskId) {
    return JSON.parse(await readFile(this.taskPath(taskId), "utf8"));
  }

  async deleteTask(taskId) {
    await unlink(this.taskPath(taskId));
  }

  async listTasks(filter = {}) {
    const tasks = await this.listJsonFiles(this.tasksDir);
    return tasks
      .filter((task) => {
        if (filter.projectId && task.projectId !== filter.projectId) return false;
        if (filter.sessionId && task.sessionId !== filter.sessionId) return false;
        if (filter.statusId && task.statusId !== filter.statusId) return false;
        if (filter.label && !(task.labels ?? []).some((label) => label === filter.label || String(label).split("::")[0] === filter.label)) return false;
        if (filter.query) {
          const query = String(filter.query).toLowerCase();
          const haystack = `${task.title}\n${task.description}\n${(task.labels ?? []).join(" ")}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => sortRecords(a, b, filter.sort ?? "createdAt:desc"));
  }

  async saveView(view) {
    await mkdir(this.viewsDir, { recursive: true });
    await writeFile(this.viewPath(view.id), `${JSON.stringify(view, null, 2)}\n`, "utf8");
  }

  async getView(viewId) {
    return JSON.parse(await readFile(this.viewPath(viewId), "utf8"));
  }

  async deleteView(viewId) {
    await unlink(this.viewPath(viewId));
  }

  async listViews(filter = {}) {
    const views = await this.listJsonFiles(this.viewsDir);
    return views.filter((view) => !filter.entity || view.entity === filter.entity).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveKnowledgeCollection(collection) {
    await mkdir(this.knowledgeCollectionsDir, { recursive: true });
    await writeFile(this.knowledgeCollectionPath(collection.id), `${JSON.stringify(collection, null, 2)}\n`, "utf8");
  }

  async getKnowledgeCollection(collectionId) {
    return JSON.parse(await readFile(this.knowledgeCollectionPath(collectionId), "utf8"));
  }

  async deleteKnowledgeCollection(collectionId) {
    await unlink(this.knowledgeCollectionPath(collectionId));
    await this.deleteKnowledgeDocuments(collectionId);
  }

  async listKnowledgeCollections() {
    const collections = await this.listJsonFiles(this.knowledgeCollectionsDir);
    return collections.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveKnowledgeDocuments(collectionId, documents) {
    await mkdir(this.knowledgeDocumentsDir, { recursive: true });
    await writeFile(this.knowledgeDocumentsPath(collectionId), `${JSON.stringify(documents, null, 2)}\n`, "utf8");
  }

  async deleteKnowledgeDocuments(collectionId) {
    try {
      await unlink(this.knowledgeDocumentsPath(collectionId));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async listKnowledgeDocuments(filter = {}) {
    await mkdir(this.knowledgeDocumentsDir, { recursive: true });
    const files = await readdir(this.knowledgeDocumentsDir);
    const documents = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      documents.push(...JSON.parse(await readFile(path.join(this.knowledgeDocumentsDir, file), "utf8")));
    }
    return documents
      .filter((document) => !filter.collectionId || document.collectionId === filter.collectionId)
      .sort((a, b) => b.indexedAt.localeCompare(a.indexedAt));
  }

  async searchKnowledge(filter = {}) {
    return searchKnowledgeDocuments(await this.listKnowledgeDocuments(), filter);
  }

  async searchKnowledgeSemantic(filter = {}) {
    const state = await this.getKnowledgeSemanticState();
    if (!state.indexFile) return [];
    try {
      const index = JSON.parse(await readFile(state.indexFile, "utf8"));
      return searchSemanticIndex(index, filter);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async getKnowledgeReport() {
    const semanticState = await this.getKnowledgeSemanticState();
    return buildKnowledgeReport({
      collections: await this.listKnowledgeCollections(),
      documents: await this.listKnowledgeDocuments(),
      semanticEngine: semanticEngineStatusFromState(semanticState)
    });
  }

  async inspectKnowledge() {
    const collections = await this.listKnowledgeCollections();
    const documents = await this.listKnowledgeDocuments();
    const semanticState = await this.getKnowledgeSemanticState();
    const inspections = [];
    for (const collection of collections) {
      inspections.push(await inspectKnowledgeCollection({ collection, documents }));
    }
    return buildKnowledgeMaintenanceReport({ collections, documents, inspections, semanticEngine: semanticEngineStatusFromState(semanticState) });
  }

  async repairKnowledge({ workspaceId } = {}) {
    const collections = await this.listKnowledgeCollections();
    const documents = [];
    const inspections = [];
    const semanticState = await this.getKnowledgeSemanticState();
    for (const collection of collections.filter((item) => item.enabled !== false)) {
      const result = await indexKnowledgeCollection({ collection, workspaceId: workspaceId ?? (await this.getWorkspace()).id });
      await this.saveKnowledgeDocuments(collection.id, result.documents);
      documents.push(...result.documents);
      inspections.push(await inspectKnowledgeCollection({ collection, documents: result.documents }));
    }
    return buildKnowledgeMaintenanceReport({ collections, documents, inspections, semanticEngine: semanticEngineStatusFromState(semanticState) });
  }

  async getKnowledgeSemanticState() {
    try {
      return JSON.parse(await readFile(this.knowledgeSemanticStateFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return defaultSemanticState({ cacheDir: path.join(this.root, "knowledge", "semantic-cache") });
    }
  }

  async saveKnowledgeSemanticState(state) {
    await mkdir(path.dirname(this.knowledgeSemanticStateFile), { recursive: true });
    await writeFile(this.knowledgeSemanticStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return state;
  }

  async configureKnowledgeSemanticState(patch = {}) {
    return this.saveKnowledgeSemanticState(updateSemanticState(await this.getKnowledgeSemanticState(), patch));
  }

  async createKnowledgeSemanticJob({ collectionId = null, model = null, cacheDir = null } = {}) {
    const state = await this.getKnowledgeSemanticState();
    const documents = await this.listKnowledgeDocuments({ collectionId });
    const effectiveModel = model ?? state.model ?? "clean-room-tfidf";
    const effectiveCacheDir = cacheDir ?? state.cacheDir;
    const job = createSemanticIndexJob({
      collectionId,
      documentCount: documents.length,
      model: effectiveModel,
      cacheDir: effectiveCacheDir,
      status: state.installed ? "queued" : "blocked",
      reason: state.installed ? null : state.reason ?? "qmd engine is not installed"
    });
    let indexResult = null;
    if (state.installed) {
      indexResult = await buildSemanticIndex({
        documents,
        cacheDir: effectiveCacheDir,
        model: effectiveModel,
        collectionId
      });
      job.status = "completed";
      job.reason = null;
      job.indexPath = indexResult.indexPath;
      job.updatedAt = new Date().toISOString();
    }
    const next = updateSemanticState(state, {
      model: effectiveModel,
      cacheDir: effectiveCacheDir,
      ...(indexResult ? { indexFile: indexResult.indexPath } : {}),
      jobs: [job, ...(state.jobs ?? [])].slice(0, 100),
      status: state.installed ? "ready" : "unavailable",
      reason: state.installed ? null : state.reason ?? "qmd engine is not installed"
    });
    await this.saveKnowledgeSemanticState(next);
    return { job, state: next, semanticEngine: semanticEngineStatusFromState(next), index: indexResult?.index ?? null };
  }

  async saveTerminalRecord(record) {
    await mkdir(this.terminalDir, { recursive: true });
    await writeFile(this.terminalRecordPath(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  }

  async saveTerminalSession(session) {
    await mkdir(this.terminalSessionsDir, { recursive: true });
    await writeFile(this.terminalSessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    return session;
  }

  async getTerminalSession(sessionId) {
    const session = await this.readJsonOrDefault(this.terminalSessionPath(sessionId), null);
    if (!session) throw Object.assign(new Error("Terminal session not found"), { code: "not_found" });
    return session;
  }

  async listTerminalSessions(filter = {}) {
    const sessions = await this.listJsonFiles(this.terminalSessionsDir);
    return sessions
      .filter((session) => !filter.status || session.status === filter.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async attachTerminalRecordToSession(sessionId, recordId) {
    const session = await this.getTerminalSession(sessionId);
    const record = await this.getTerminalRecord(recordId);
    const updatedSession = attachTerminalRecordToSession(session, record);
    await this.saveTerminalSession(updatedSession);
    if (record.sessionId !== sessionId) {
      await this.saveTerminalRecord({ ...record, sessionId });
    }
    return { session: updatedSession, record: { ...record, sessionId } };
  }

  async closeTerminalSession(sessionId, options = {}) {
    return this.saveTerminalSession(closeTerminalSession(await this.getTerminalSession(sessionId), options));
  }

  async getTerminalRecord(recordId) {
    const record = await this.readJsonOrDefault(this.terminalRecordPath(recordId), null);
    if (!record) throw Object.assign(new Error("Terminal record not found"), { code: "not_found" });
    return record;
  }

  async listTerminalHistory(filter = {}) {
    const records = await this.listJsonFiles(this.terminalDir);
    return records
      .filter((record) => {
        if (filter.exitCode !== undefined && filter.exitCode !== null && filter.exitCode !== "" && record.exitCode !== Number(filter.exitCode)) {
          return false;
        }
        if (filter.query) {
          const query = String(filter.query).toLowerCase();
          return record.command.toLowerCase().includes(query) || String(record.output ?? "").toLowerCase().includes(query);
        }
        return true;
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async appendProtocolEvent(event) {
    await mkdir(this.protocolEventsDir, { recursive: true });
    const file = path.join(this.protocolEventsDir, `${event.createdAt.replaceAll(":", "-")}-${event.id}.json`);
    await writeFile(file, `${JSON.stringify(event, null, 2)}\n`, "utf8");
  }

  async listProtocolEvents(filter = {}) {
    const items = await this.listJsonFiles(this.protocolEventsDir);
    return items
      .filter((event) => {
        if (filter.threadId && event.threadId !== filter.threadId) return false;
        if (filter.type && event.type !== filter.type) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || sequenceSortValue(a) - sequenceSortValue(b));
  }

  async saveQueuedMessage(message) {
    await mkdir(this.queuedMessagesDir, { recursive: true });
    await writeFile(this.queuedMessagePath(message.id), `${JSON.stringify(message, null, 2)}\n`, "utf8");
    return message;
  }

  async getQueuedMessage(messageId) {
    return JSON.parse(await readFile(this.queuedMessagePath(messageId), "utf8"));
  }

  async listQueuedMessages(filter = {}) {
    const messages = await this.listJsonFiles(this.queuedMessagesDir);
    return messages
      .filter((message) => {
        if (filter.threadId && message.threadId !== filter.threadId) return false;
        if (filter.status && message.status !== filter.status) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async saveRunControl(control) {
    await mkdir(this.runControlDir, { recursive: true });
    await writeFile(this.runControlPath(control.threadId), `${JSON.stringify(control, null, 2)}\n`, "utf8");
    return control;
  }

  async getRunControl(threadId) {
    try {
      return JSON.parse(await readFile(this.runControlPath(threadId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async listRunControls(filter = {}) {
    const controls = await this.listJsonFiles(this.runControlDir);
    return controls
      .filter((control) => !filter.status || control.status === filter.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveSession(session) {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.sessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  async getSession(sessionId) {
    return JSON.parse(await readFile(this.sessionPath(sessionId), "utf8"));
  }

  async listSessions() {
    const sessions = await this.listJsonFiles(this.sessionsDir);
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async appendDomainEvent(event) {
    await mkdir(this.eventsDir, { recursive: true });
    const file = path.join(this.eventsDir, `${event.createdAt.replaceAll(":", "-")}-${event.type}.json`);
    await writeFile(file, `${JSON.stringify(event, null, 2)}\n`, "utf8");
  }

  async getAutomationConfig() {
    return this.readJsonOrDefault(this.automationsFile, EMPTY_AUTOMATION_CONFIG);
  }

  async saveAutomationConfig(config) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.automationsFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  async readPreferences() {
    return this.readJsonOrDefault(this.preferencesFile, {});
  }

  async writePreferences(patch = {}) {
    const preferences = {
      ...(await this.readPreferences()),
      ...(patch && typeof patch === "object" ? patch : {})
    };
    await mkdir(this.root, { recursive: true });
    await writeFile(this.preferencesFile, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    return preferences;
  }

  async getDraft(key) {
    const drafts = await this.readJsonOrDefault(this.draftsFile, {});
    return drafts[String(key)] ?? null;
  }

  async setDraft(key, value) {
    const drafts = await this.readJsonOrDefault(this.draftsFile, {});
    const draftKey = String(key);
    drafts[draftKey] = {
      key: draftKey,
      value,
      updatedAt: new Date().toISOString()
    };
    await mkdir(this.root, { recursive: true });
    await writeFile(this.draftsFile, `${JSON.stringify(drafts, null, 2)}\n`, "utf8");
    return drafts[draftKey];
  }

  async deleteDraft(key) {
    const drafts = await this.readJsonOrDefault(this.draftsFile, {});
    const draftKey = String(key);
    const existing = drafts[draftKey] ?? null;
    delete drafts[draftKey];
    await mkdir(this.root, { recursive: true });
    await writeFile(this.draftsFile, `${JSON.stringify(drafts, null, 2)}\n`, "utf8");
    return existing;
  }

  async listDrafts() {
    return Object.values(await this.readJsonOrDefault(this.draftsFile, {}))
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async appendAutomationHistory(history) {
    await mkdir(this.automationHistoryDir, { recursive: true });
    const file = path.join(this.automationHistoryDir, `${history.createdAt.replaceAll(":", "-")}-${history.id}.json`);
    await writeFile(file, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  }

  async listAutomationHistory() {
    const items = await this.listJsonFiles(this.automationHistoryDir);
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readCredentials() {
    try {
      return JSON.parse(await readFile(this.credentialsFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, credentials: {} };
      if (error instanceof SyntaxError) {
        const backupPath = await backupUnreadableFile(this.credentialsFile);
        return { version: 1, credentials: {}, backupPath };
      }
      throw error;
    }
  }

  async writeCredentials(store) {
    await mkdir(this.root, { recursive: true });
    await atomicWriteJson(this.credentialsFile, store);
  }

  async saveCredential(record) {
    const credentials = await this.readCredentials();
    credentials.credentials[record.sourceSlug] = await this.prepareCredentialForStorage({
      ...record,
      updatedAt: new Date().toISOString()
    });
    await this.writeCredentials(credentials);
    return this.hydrateCredential(credentials.credentials[record.sourceSlug]);
  }

  async getCredential(sourceSlug) {
    const credentials = await this.readCredentials();
    return this.hydrateCredential(credentials.credentials[sourceSlug] ?? null);
  }

  async listCredentialSummaries() {
    const credentials = await this.readCredentials();
    return Object.values(credentials.credentials).map(summarizeCredential);
  }

  credentialStorageInfo() {
    return {
      backend: this.credentialBackend?.name ?? "json-file",
      encrypted: Boolean(this.credentialBackend),
      credentialsFile: this.credentialsFile
    };
  }

  async prepareCredentialForStorage(record) {
    if (!this.credentialBackend) return record;
    const stored = { ...record, secretStorage: this.credentialBackend.name };
    if (record.value !== undefined && record.value !== null && record.value !== "") {
      const secret = serializeSecret(record.value);
      stored.secretRef = {
        ...(await this.credentialBackend.saveSecret({ sourceSlug: record.sourceSlug, field: "value", value: secret.text })),
        encoding: secret.encoding
      };
      delete stored.value;
    }
    if (record.refreshToken !== undefined && record.refreshToken !== null && record.refreshToken !== "") {
      const secret = serializeSecret(record.refreshToken);
      stored.refreshTokenRef = {
        ...(await this.credentialBackend.saveSecret({ sourceSlug: record.sourceSlug, field: "refreshToken", value: secret.text })),
        encoding: secret.encoding
      };
      delete stored.refreshToken;
    }
    return stored;
  }

  async hydrateCredential(record) {
    if (!record) return null;
    if (!this.credentialBackend) return record;
    const hydrated = { ...record };
    if (record.secretRef && hydrated.value === undefined) {
      hydrated.value = deserializeSecret(await this.credentialBackend.readSecret(record.secretRef), record.secretRef.encoding);
    }
    if (record.refreshTokenRef && hydrated.refreshToken === undefined) {
      hydrated.refreshToken = deserializeSecret(await this.credentialBackend.readSecret(record.refreshTokenRef), record.refreshTokenRef.encoding);
    }
    return hydrated;
  }

  threadPath(threadId) {
    return path.join(this.threadsDir, `${threadId}.json`);
  }

  queuedMessagePath(messageId) {
    return path.join(this.queuedMessagesDir, `${messageId}.json`);
  }

  runControlPath(threadId) {
    return path.join(this.runControlDir, `${threadId}.json`);
  }

  projectPath(projectId) {
    return path.join(this.projectsDir, `${projectId}.json`);
  }

  sessionPath(sessionId) {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  taskPath(taskId) {
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  viewPath(viewId) {
    return path.join(this.viewsDir, `${viewId}.json`);
  }

  knowledgeCollectionPath(collectionId) {
    return path.join(this.knowledgeCollectionsDir, `${collectionId}.json`);
  }

  knowledgeDocumentsPath(collectionId) {
    return path.join(this.knowledgeDocumentsDir, `${collectionId}.json`);
  }

  terminalRecordPath(recordId) {
    return path.join(this.terminalDir, `${recordId}.json`);
  }

  terminalSessionPath(sessionId) {
    return path.join(this.terminalSessionsDir, `${sessionId}.json`);
  }

  async readJsonOrDefault(file, fallback) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(fallback);
      throw error;
    }
  }

  async listJsonFiles(dir) {
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    const items = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      items.push(JSON.parse(await readFile(path.join(dir, file), "utf8")));
    }
    return items;
  }
}

function sequenceSortValue(event) {
  return event.sequence === null || event.sequence === undefined ? Number.MAX_SAFE_INTEGER : event.sequence;
}

function sortRecords(a, b, sort) {
  const [field, direction] = String(sort).split(":");
  const sign = direction === "asc" ? 1 : -1;
  return String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * sign;
}
