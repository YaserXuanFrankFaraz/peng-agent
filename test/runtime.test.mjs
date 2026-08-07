import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AutomationScheduler, lintAutomationConfig, runAutomations, runAutomationSchedulerTick, validateAutomationConfig } from "../src/automations.js";
import { mergeConfig } from "../src/config.js";
import { applyApiAuth, createCredentialRecord, credentialFromPromptInput, credentialPromptSpec, credentialRestartSignature, sourceAuthState } from "../src/credentials.js";
import { addSessionLabel, createProject, createSession, updateProject, updateSessionStatus } from "../src/domain.js";
import { gitBranches, gitCreateBranch, gitDiff, gitGenerateCommitMessage, gitHistory, gitLogPrettyFormat, gitSaveStash, gitStage, gitStashes, gitStatus, parseGitLog, parseGitStatusPorcelain, summarizeGitStatus } from "../src/git.js";
import { createKnowledgeCollection, indexKnowledgeCollection, searchKnowledgeDocuments, updateKnowledgeCollection } from "../src/knowledge.js";
import { createLabel, deleteLabel, filterLabels, flattenLabels, parseSessionLabel, updateLabel, validateLabelConfig } from "../src/labels.js";
import { consolidateMemories, createMemoryRecord, extractMemoryCandidates, parseMemoryCitations, pruneMemories, redactMemoryText, renderMemoriesMarkdown, renderMemoryContext } from "../src/memory.js";
import { createOAuthAuthorizationRequest, generateOAuthPkcePair, generateOAuthState, openOAuthAuthorizationUrl } from "../src/oauth.js";
import { evaluatePermission, evaluateSourcePermission, validatePermissionRules, DEFAULT_PERMISSION_RULES } from "../src/permissions.js";
import { powerState, resetPowerState } from "../src/power.js";
import { resolveResource, resolveToolIcon, resourceManifest } from "../src/resources.js";
import { searchWorkspace } from "../src/search.js";
import { DeterministicProvider } from "../src/provider.js";
import { createRuntime } from "../src/runtime.js";
import { discoverSkills } from "../src/skills.js";
import { cacheSourceIcon, callMcpSourceTool, discoverSources, exchangeSourceOAuthCode, exchangeSourceOAuthDeviceCode, executeApiSourceRequest, getSourceOAuthAuthorizationUrl, getSourceRuntimeSignature, listMcpSourceTools, pollSourceOAuthDeviceCode, readSource, refreshSourceOAuthCredential, startSourceOAuthDeviceFlow, testSource, validateSourceConfig } from "../src/sources.js";
import { createStatus, deleteStatus, setDefaultStatus, updateStatus, DEFAULT_STATUS_CONFIG, validateStatusConfig } from "../src/statuses.js";
import { JsonStore } from "../src/store.js";
import { createTask, updateTask, updateTaskStatus } from "../src/tasks.js";
import { createTerminalRecord, createTerminalSession, executeTerminalCommand, filterTerminalHistory, finishTerminalRecord, recordTerminalChunk, replayTerminalRecord, TerminalProcessManager } from "../src/terminal.js";
import { createDefaultTools } from "../src/tools.js";
import { createView, applyView, updateView } from "../src/views.js";
import { discoverWorkflows } from "../src/workflows.js";

test("runs a task and persists the thread", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const runtime = testRuntime(workspace);

  const result = await runtime.runTask({ prompt: "List workspace files" });
  const loaded = await runtime.getThread(result.thread.id);

  assert.equal(loaded.status, "completed");
  assert.ok(result.output.includes("Tool workspace.list result"));
});

test("keeps the system awake while configured runs are active and always releases", async () => {
  resetPowerState();
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const events = [];
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider: new DeterministicProvider(),
    tools: createDefaultTools({ workspace }),
    config: { defaults: { keepAwakeWhileRunning: true } }
  });

  const result = await runtime.runTask({ prompt: "List workspace files", onEvent: (event) => events.push(event) });

  assert.equal(result.thread.status, "completed");
  assert.equal(powerState().preventSleep, false);
  assert.equal(events.some((event) => event.type === "power.prevent_sleep"), true);
  assert.equal(events.some((event) => event.type === "power.allow_sleep"), true);

  const failingWorkspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const failing = createRuntime({
    workspace: failingWorkspace,
    store: new JsonStore({ workspace: failingWorkspace }),
    provider: {
      name: "failing",
      async complete() {
        throw Object.assign(new Error("provider exploded"), { code: "provider_transient", retryable: false });
      }
    },
    tools: createDefaultTools({ workspace: failingWorkspace }),
    config: { defaults: { keepAwakeWhileRunning: true } }
  });
  await assert.rejects(() => failing.runTask({ prompt: "fail" }), /provider exploded/);
  assert.equal(powerState().preventSleep, false);
});

test("memory tool stores searchable facts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const runtime = testRuntime(workspace);

  await runtime.runTask({ prompt: "Remember that the app should support tool plugins" });
  const memory = await runtime.store.readMemory();

  assert.equal(memory.facts.length, 1);
  assert.match(memory.facts[0].fact, /tool plugins/);
});

test("stores citable JSONL memories with redaction and context rendering", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const memory = createMemoryRecord({
    workspaceId: workspaceRecord.id,
    text: "Prefer small focused PRs with token=secret-value-12345",
    tags: ["engineering"],
    createdAt: "2026-08-07T00:00:00.000Z"
  });
  await store.appendMemoryRecord(memory);

  const records = await store.searchMemoryRecords({ query: "focused PRs" });
  const context = renderMemoryContext(await store.listMemoryRecords(), { query: "focused" });

  assert.equal(redactMemoryText("Bearer abcdefghijklmnop").includes("[REDACTED]"), true);
  assert.equal(records.length, 1);
  assert.match(records[0].citation, /^\[memory:memory_/);
  assert.match(records[0].text, /token=\[REDACTED\]/);
  assert.match(context, /<memory_context>/);
  assert.deepEqual(parseMemoryCitations(`Use ${records[0].citation}`), [records[0].id]);
});

test("extracts, maintains, renders, and counts memory citations", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const craftUserMemoriesDir = path.join(workspace, "home", ".craft-agent", "memories");
  const store = new JsonStore({ workspace, craftUserMemoriesDir });
  const workspaceRecord = await store.getWorkspace();
  const candidates = extractMemoryCandidates({
    workspaceId: workspaceRecord.id,
    text: "Remember prefer short reviews. Random note. Never include raw secrets in memory.",
    tags: ["review"],
    createdAt: "2026-08-07T00:00:00.000Z"
  });
  assert.equal(candidates.length, 2);
  await store.appendMemoryRecord(candidates[0]);
  await store.appendMemoryRecord({ ...candidates[0], id: "memory_duplicate", usageCount: 2, updatedAt: "2026-08-07T00:01:00.000Z" });
  await store.appendMemoryRecord(candidates[1]);

  const consolidated = consolidateMemories(await store.listMemoryRecords());
  assert.equal(consolidated.length, 2);
  assert.equal(consolidated.find((item) => item.text === candidates[0].text).usageCount, 2);
  await store.recordMemoryCitations([candidates[0].id], { usedAt: "2026-08-07T00:02:00.000Z" });
  assert.equal((await store.getMemoryRecord(candidates[0].id)).usageCount, 1);
  await store.saveThread({
    id: "thread_memory_scan",
    title: "Memory scan",
    status: "completed",
    createdAt: "2026-08-07T00:02:30.000Z",
    updatedAt: "2026-08-07T00:02:30.000Z",
    events: [{ role: "assistant", content: `Use [memory:${candidates[1].id}] next time.` }]
  });
  const maintained = await store.maintainMemory({
    maxRecords: 2,
    title: "Project Memory",
    generatedAt: "2026-08-07T00:03:00.000Z",
    scanCitations: true,
    userCompatibility: true
  });
  assert.equal(maintained.records.length, 2);
  assert.match(maintained.markdownPath, /MEMORIES\.md$/);
  assert.match(await readFile(maintained.markdownPath, "utf8"), /# Project Memory/);
  assert.match(maintained.compatibility.markdownPath, /\.craft-agent\/memories\/MEMORIES\.md$/);
  assert.match(await readFile(maintained.compatibility.markdownPath, "utf8"), /# Project Memory/);
  assert.match(await readFile(maintained.compatibility.jsonlPath, "utf8"), /memory_/);
  assert.match(maintained.compatibility.userHome.markdownPath, /\.craft-agent\/memories\/MEMORIES\.md$/);
  assert.match(await readFile(maintained.compatibility.userHome.markdownPath, "utf8"), /# Project Memory/);
  assert.match(await readFile(maintained.compatibility.userHome.jsonlPath, "utf8"), /memory_/);
  assert.deepEqual(maintained.citationScan.ids, [candidates[1].id]);
  assert.equal((await store.getMemoryRecord(candidates[1].id)).usageCount, 1);
  assert.equal(pruneMemories(consolidated, { minUsageCount: 1 }).length, 1);
  assert.match(renderMemoriesMarkdown(consolidated, { generatedAt: "2026-08-07T00:04:00.000Z" }), /usage=2/);
});

test("memory maintenance rate caps deferred removals", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  for (let index = 0; index < 5; index += 1) {
    await store.appendMemoryRecord(createMemoryRecord({
      text: `Prefer retention cap sample ${index}.`,
      createdAt: `2026-08-07T00:0${index}:00.000Z`
    }));
  }

  const maintained = await store.maintainMemory({
    maxRecords: 1,
    maxRemovedPerRun: 2,
    compatibility: false
  });

  assert.equal(maintained.records.length, 3);
  assert.equal(maintained.report.removed, 2);
  assert.equal(maintained.report.deferredRemovals, 2);
});

test("indexes knowledge collections and searches documents", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const vault = path.join(workspace, "vault");
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, "agent-notes.md"), "# Agent Notes\n\nPrefer ripgrep for literal knowledge search.\n", "utf8");
  await writeFile(path.join(vault, "ignore.json"), "{\"skip\":true}", "utf8");
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const collection = createKnowledgeCollection({
    workspaceId: workspaceRecord.id,
    name: "Vault",
    root: vault,
    semanticEnabled: true
  });

  await store.saveKnowledgeCollection(collection);
  const result = await indexKnowledgeCollection({ collection, workspaceId: workspaceRecord.id });
  await store.saveKnowledgeDocuments(collection.id, result.documents);
  const updatedCollection = updateKnowledgeCollection(collection, { name: "Vault Updated" });
  await store.saveKnowledgeCollection(updatedCollection);
  await writeFile(path.join(vault, "agent-notes.md"), "# Agent Notes\n\nPrefer ripgrep for literal knowledge search.\n\nUpdated.\n", "utf8");

  const documents = await store.listKnowledgeDocuments();
  const search = searchKnowledgeDocuments(documents, { query: "ripgrep" });
  const report = await store.inspectKnowledge();
  const repaired = await store.repairKnowledge({ workspaceId: workspaceRecord.id });
  const semantic = await store.configureKnowledgeSemanticState({ model: "local-embed-test", cacheDir: path.join(workspace, ".cache", "qmd"), installed: true, status: "ready", reason: null });
  const semanticJob = await store.createKnowledgeSemanticJob({ collectionId: collection.id });
  const semanticResults = await store.searchKnowledgeSemantic({ query: "literal search", collectionId: collection.id });

  assert.equal(documents.length, 1);
  assert.equal(documents[0].title, "Agent Notes");
  assert.equal(search[0].path, "agent-notes.md");
  assert.equal(report.documentCount, 1);
  assert.equal(report.collections[0].semanticEnabled, true);
  assert.equal(report.inspections[0].stale.includes("agent-notes.md"), true);
  assert.equal(repaired.documentCount, 1);
  assert.equal(report.semanticEngine.status, "unavailable");
  assert.equal(semantic.model, "local-embed-test");
  assert.equal(semanticJob.job.status, "completed");
  assert.equal(semanticJob.job.documentCount, 1);
  assert.equal(semanticJob.index.documentCount, 1);
  assert.equal(semanticResults[0].title, "Agent Notes");
  assert.equal((await store.getKnowledgeReport()).semanticEngine.latestJob.id, semanticJob.job.id);
  assert.equal((await searchWorkspace({ store, query: "ripgrep" }))[0].type, "knowledge");
  await store.deleteKnowledgeCollection(collection.id);
  assert.equal((await store.listKnowledgeCollections()).length, 0);
  assert.equal((await store.listKnowledgeDocuments()).length, 0);
});

test("workspace tools prevent path traversal", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const runtime = testRuntime(workspace);

  await assert.rejects(
    () => runtime.tools.run("workspace.read", { file: "../outside.txt" }, { store: runtime.store }),
    /Path escapes workspace/
  );
});

test("matches observed default config fields", () => {
  const config = mergeConfig();

  assert.equal(config.defaults.colorTheme, "default");
  assert.equal(config.workspaceDefaults.permissionMode, "safe");
  assert.deepEqual(config.workspaceDefaults.cyclablePermissionModes, ["safe", "allow-all"]);
});

test("evaluates safe-mode permission rules", () => {
  assert.equal(validatePermissionRules(DEFAULT_PERMISSION_RULES).ok, true);
  assert.equal(evaluatePermission({ mode: "safe", kind: "bash", value: "ls -la" }).decision, "allow");
  assert.equal(evaluatePermission({ mode: "safe", kind: "bash", value: "rm -rf tmp" }).decision, "deny");
  assert.equal(evaluatePermission({ mode: "ask", kind: "bash", value: "ls" }).decision, "ask");
  const rules = {
    ...DEFAULT_PERMISSION_RULES,
    allowedApiEndpoints: [{ method: "GET", path: ".*" }],
    deniedApiEndpoints: [{ method: "GET", path: "/secrets/.*" }],
    allowedTools: ["workspace.read"],
    deniedTools: ["workspace.write"],
    allowedWritePaths: ["/workspace/tmp/**"],
    deniedWritePaths: ["/workspace/tmp/private/**"]
  };
  assert.equal(evaluatePermission({ mode: "safe", kind: "api", method: "GET", value: "/secrets/token", rules }).decision, "deny");
  assert.equal(evaluatePermission({ mode: "safe", kind: "api", method: "GET", value: "/public/status", rules }).decision, "allow");
  assert.equal(evaluatePermission({ mode: "safe", kind: "tool", value: "workspace.read", rules }).decision, "allow");
  assert.equal(evaluatePermission({ mode: "safe", kind: "tool", value: "workspace.write", rules }).decision, "deny");
  assert.equal(evaluatePermission({ mode: "safe", kind: "write", value: "/workspace/tmp/out.txt", rules }).decision, "allow");
  assert.equal(evaluatePermission({ mode: "safe", kind: "write", value: "/workspace/tmp/private/key.txt", rules }).decision, "deny");
  assert.equal(validatePermissionRules({ ...rules, allowedApiEndpoints: [{ method: "GET" }] }).ok, false);
  assert.equal(evaluateSourcePermission({
    source: {
      slug: "docs",
      permissions: {
        allowedMcpPatterns: [{ pattern: "^search" }],
        deniedMcpPatterns: [{ pattern: "secret" }],
        allowedApiEndpoints: [{ method: "GET", path: ".*" }],
        deniedApiEndpoints: [{ method: "GET", path: "/admin" }]
      }
    },
    kind: "mcp",
    value: "search_secret"
  }).decision, "deny");
  assert.equal(evaluateSourcePermission({
    source: {
      slug: "docs",
      permissions: {
        allowedApiEndpoints: [{ method: "GET", path: ".*" }],
        deniedApiEndpoints: [{ method: "GET", path: "/admin" }]
      }
    },
    kind: "api",
    method: "GET",
    value: "/admin"
  }).decision, "deny");
});

test("discovers Craft-compatible skills", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const skillDir = path.join(workspace, ".craft-agent", "skills", "review");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: "Review"
description: "Review code changes"
globs: ["*.js"]
---

# Review

Inspect behavior and tests.
`,
    "utf8"
  );

  const skills = await discoverSkills({ workspace, home: path.join(workspace, "home") });

  assert.equal(skills.length, 1);
  assert.equal(skills[0].slug, "review");
  assert.equal(skills[0].valid, true);
  assert.deepEqual(skills[0].metadata.globs, ["*.js"]);
});

test("discovers runnable workflow markdown", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const workflowDir = path.join(workspace, "workflow");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    path.join(workflowDir, "release.md"),
    `---
loop: v1
name: Release
trigger: manual
---

# Workflow: Release (release)

> Prepare and verify a release.

### Phase 1 - Discovery

### Phase 2 - CHECKPOINT
`,
    "utf8"
  );

  const workflows = await discoverWorkflows({ workspace, home: path.join(workspace, "home") });

  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].id, "release");
  assert.equal(workflows[0].runnable, true);
  assert.equal(workflows[0].phases.length, 2);
  assert.equal(workflows[0].phases[1].checkpoint, true);
});

test("validates observed default status configuration", () => {
  const result = validateStatusConfig(DEFAULT_STATUS_CONFIG);

  assert.equal(result.ok, true);
  assert.equal(DEFAULT_STATUS_CONFIG.defaultStatusId, "todo");
  assert.deepEqual(
    DEFAULT_STATUS_CONFIG.statuses.filter((status) => status.isFixed).map((status) => status.id),
    ["todo", "done", "cancelled"]
  );
});

test("creates, updates, defaults, and deletes custom statuses", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const runtime = testRuntime(workspace);
  let config = createStatus(DEFAULT_STATUS_CONFIG, { id: "blocked", label: "Blocked", color: "warning" });
  config = updateStatus(config, "blocked", { label: "Blocked Work", category: "open" });
  config = setDefaultStatus(config, "blocked");
  const deleted = deleteStatus(config, "blocked", { replacementStatusId: "todo" });

  assert.equal(config.statuses.find((status) => status.id === "blocked").label, "Blocked Work");
  assert.equal(config.defaultStatusId, "blocked");
  assert.equal(deleted.config.defaultStatusId, "todo");
  assert.equal(deleted.replacementStatusId, "todo");
  assert.throws(() => deleteStatus(config, "todo"), /Cannot delete fixed status/);

  await runtime.tools.run("statuses.create", { id: "triage", label: "Triage" }, { store: runtime.store });
  await runtime.tools.run("statuses.default", { id: "triage" }, { store: runtime.store });
  const stored = await runtime.store.getStatusConfig();
  assert.equal(stored.defaultStatusId, "triage");
});

test("parses and validates hierarchical labels", () => {
  let config = {
    version: 1,
    labels: [
      {
        id: "eng",
        name: "Engineering",
        color: "info",
        children: [{ id: "frontend", name: "Frontend", valueType: "link" }]
      }
    ]
  };

  assert.equal(validateLabelConfig(config).ok, true);
  assert.deepEqual(
    flattenLabels(config).map((label) => [label.id, label.depth, label.parentId]),
    [
      ["eng", 1, null],
      ["frontend", 2, "eng"]
    ]
  );
  config = createLabel(config, { id: "priority", name: "Priority", valueType: "number" });
  config = createLabel(config, { id: "backend", name: "Backend", parentId: "eng" });
  config = updateLabel(config, "backend", { id: "api", name: "API" });
  const deleted = deleteLabel(config, "eng");

  assert.deepEqual(filterLabels(config, { query: "api" }).map((label) => label.id), ["api"]);
  assert.deepEqual(filterLabels(config, { valueType: "number" }).map((label) => label.id), ["priority"]);
  assert.equal(flattenLabels(config).find((label) => label.id === "api").parentId, "eng");
  assert.deepEqual(deleted.removed.sort(), ["api", "eng", "frontend"]);
  assert.deepEqual(parseSessionLabel("priority::3"), { id: "priority", value: "3", valueType: "number" });
  assert.deepEqual(parseSessionLabel("due::2026-01-30"), { id: "due", value: "2026-01-30", valueType: "date" });
});

test("stores sessions and emits status/label domain events", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const session = createSession({
    workspaceId: workspaceRecord.id,
    prompt: "Investigate a bug",
    statusConfig: await store.getStatusConfig()
  });
  await store.saveSession(session);

  const { session: reviewed, event: statusEvent } = updateSessionStatus(
    await store.getSession(session.id),
    "needs-review",
    await store.getStatusConfig()
  );
  await store.saveSession(reviewed);
  await store.appendDomainEvent(statusEvent);
  const { session: labelled, event: labelEvent } = addSessionLabel(reviewed, "bug");
  await store.saveSession(labelled);
  await store.appendDomainEvent(labelEvent);

  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].statusId, "needs-review");
  assert.deepEqual(sessions[0].labels, ["bug"]);
  assert.equal(statusEvent.type, "SessionStatusChange");
  assert.equal(labelEvent.type, "LabelAdd");
});

test("runs prompt automations and records history", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const config = {
    version: 2,
    automations: {
      LabelAdd: [
        {
          matcher: "^urgent$",
          permissionMode: "safe",
          labels: ["scheduled"],
          actions: [{ type: "prompt", prompt: "Triage $CRAFT_LABEL for ${CRAFT_SESSION_NAME}" }]
        }
      ]
    }
  };
  await store.saveAutomationConfig(config);

  assert.equal(validateAutomationConfig(config).ok, true);
  const result = await runAutomations({
    config: await store.getAutomationConfig(),
    store,
    event: {
      type: "LabelAdd",
      label: "urgent",
      sessionId: "session_1",
      sessionName: "Incident"
    }
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].session.permissionMode, "safe");
  assert.deepEqual(result.results[0].session.labels, ["scheduled"]);
  assert.equal(result.results[0].session.events[0].prompt, "Triage urgent for Incident");
  assert.equal((await store.listAutomationHistory()).length, 1);
});

test("builds webhook automation requests without exposing unrelated env", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const config = {
    version: 2,
    automations: {
      SessionStatusChange: [
        {
          condition: { condition: "state", field: "sessionStatus", to: "done" },
          actions: [
            {
              type: "webhook",
              url: "https://example.com/${CRAFT_WH_PATH}",
              method: "POST",
              body: { event: "$CRAFT_EVENT", home: "$HOME" }
            }
          ]
        }
      ]
    }
  };

  const result = await runAutomations({
    config,
    store,
    env: { CRAFT_WH_PATH: "hook", HOME: "/should-not-expand" },
    event: {
      type: "SessionStatusChange",
      oldState: "todo",
      newState: "done",
      sessionId: "session_1"
    }
  });

  assert.equal(result.results[0].request.url, "https://example.com/hook");
  assert.deepEqual(result.results[0].request.body, { event: "SessionStatusChange", home: "$HOME" });
});

test("executes webhook automations with response capture and rate limiting", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const config = {
    version: 2,
    automations: {
      Notification: [
        {
          matcher: "build",
          actions: [
            {
              type: "webhook",
              url: "https://example.com/hooks/$CRAFT_EVENT",
              method: "POST",
              headers: { "x-event": "$CRAFT_EVENT" },
              body: { message: "$CRAFT_EVENT_DATA" },
              captureResponse: true,
              rateLimit: { count: 1, windowMs: 60000 }
            }
          ]
        }
      ]
    }
  };
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 202,
      statusText: "Accepted",
      async text() {
        return "queued";
      }
    };
  };

  assert.equal(validateAutomationConfig(config).ok, true);
  assert.equal(lintAutomationConfig(config).warnings.length, 0);
  const first = await runAutomations({
    config,
    store,
    executeWebhooks: true,
    fetchImpl,
    now: new Date("2026-08-07T00:00:00.000Z"),
    event: { type: "Notification", matchValue: "build finished" }
  });
  const second = await runAutomations({
    config,
    store,
    executeWebhooks: true,
    fetchImpl,
    now: new Date("2026-08-07T00:00:30.000Z"),
    event: { type: "Notification", matchValue: "build finished" }
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://example.com/hooks/Notification");
  assert.equal(fetchCalls[0].init.headers["content-type"], "application/json");
  assert.equal(first.results[0].response.status, 202);
  assert.equal(first.results[0].response.body, "queued");
  assert.equal(second.results[0].skipped, true);
  assert.equal(second.results[0].reason, "rate_limited");
  assert.equal((await store.listAutomationHistory()).length, 2);
});

test("runs scheduled automation ticks and exposes scheduler state", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  await store.saveAutomationConfig({
    version: 2,
    automations: {
      SchedulerTick: [
        {
          condition: { condition: "time", weekday: ["fri"] },
          labels: ["scheduled"],
          actions: [{ type: "prompt", prompt: "Scheduled maintenance at $CRAFT_EVENT_DATA" }]
        }
      ]
    }
  });

  const result = await runAutomationSchedulerTick({
    store,
    now: new Date("2026-08-07T09:30:00.000Z")
  });
  const session = (await store.listSessions())[0];
  const scheduler = new AutomationScheduler({ store, intervalMs: 500, onTick: async () => {} });

  assert.equal(result.history.eventType, "SchedulerTick");
  assert.equal(result.history.event.weekday, "fri");
  assert.equal(result.results[0].type, "prompt");
  assert.deepEqual(session.labels, ["scheduled"]);
  assert.match(session.events[0].prompt, /Scheduled maintenance/);
  assert.equal(scheduler.status().running, false);
  assert.equal(scheduler.start().running, true);
  assert.equal(scheduler.status().intervalMs, 1000);
  assert.equal(scheduler.stop().running, false);
});

test("discovers and validates source configs", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const sourceDir = path.join(workspace, ".craft-agent", "sources", "openai");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, "config.json"),
    JSON.stringify(
      {
        id: "openai_a1b2c3d4",
        name: "OpenAI",
        slug: "openai",
        enabled: true,
        provider: "openai",
        type: "api",
        api: {
          baseUrl: "https://api.openai.com/v1/",
          authType: "bearer",
          testEndpoint: { method: "GET", path: "models" }
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(sourceDir, "guide.md"), "# OpenAI\n\nUse model and file APIs carefully.\n", "utf8");

  const sources = await discoverSources({ workspace, home: path.join(workspace, "home") });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].slug, "openai");
  assert.equal(sources[0].validation.ok, true);
  assert.equal(validateSourceConfig({ slug: "bad source", type: "api", api: { baseUrl: "https://example.com" } }).ok, false);
});

test("caches source icons and records icon metadata during source tests", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const vault = path.join(workspace, "vault");
  await mkdir(vault, { recursive: true });
  const sourceDir = path.join(workspace, ".craft-agent", "sources", "notes");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, "config.json"),
    JSON.stringify({
      id: "notes_a1b2c3d4",
      name: "Notes",
      slug: "notes",
      enabled: true,
      provider: "obsidian",
      type: "local",
      iconUrl: "https://icons.example.com/notes.svg",
      local: { path: vault }
    }),
    "utf8"
  );
  const source = await readSource(sourceDir);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "image/svg+xml"]]),
    async arrayBuffer() {
      const bytes = Buffer.from("<svg/>", "utf8");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  });

  const cached = await cacheSourceIcon({ source, fetchImpl });
  const tested = await testSource({ source: await readSource(sourceDir), fetchImpl });
  const updated = await readSource(sourceDir);

  assert.equal(cached.icon.cachedPath, "icon.svg");
  assert.equal((await readFile(path.join(sourceDir, "icon.svg"), "utf8")).includes("<svg/>"), true);
  assert.equal(tested.connectionStatus, "connected");
  assert.equal(updated.icon.cachedPath, "icon.svg");
  assert.equal(updated.iconError, undefined);
});

test("stores credential summaries, backs up unreadable files, and derives source auth state", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const record = await store.saveCredential(createCredentialRecord({
    sourceSlug: "openai",
    provider: "openai",
    mode: "bearer",
    value: "sk-test-secret-value"
  }));

  const summaries = await store.listCredentialSummaries();
  assert.equal(record.value, "sk-test-secret-value");
  assert.equal(summaries[0].hasSecret, true);
  assert.equal(JSON.stringify(summaries).includes("sk-test"), false);

  await writeFile(store.credentialsFile, "{not-json", "utf8");
  const recovered = await store.readCredentials();
  assert.match(recovered.backupPath, /credentials\.json\.unreadable-/);
  assert.equal(await readFile(recovered.backupPath, "utf8"), "{not-json");
  assert.equal(store.credentialStorageInfo().backend, "json-file");
});

test("stores credential secrets in an external backend when configured", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const backend = createFakeCredentialBackend();
  const store = new JsonStore({ workspace, credentialBackend: backend });

  const saved = await store.saveCredential(createCredentialRecord({
    sourceSlug: "datadog",
    provider: "datadog",
    mode: "multi-header",
    value: { "DD-API-KEY": "api-secret", "DD-APPLICATION-KEY": "app-secret" },
    refreshToken: "refresh-secret"
  }));
  const persisted = await store.readCredentials();
  const raw = await readFile(store.credentialsFile, "utf8");
  const hydrated = await store.getCredential("datadog");
  const summaries = await store.listCredentialSummaries();

  assert.deepEqual(saved.value, { "DD-API-KEY": "api-secret", "DD-APPLICATION-KEY": "app-secret" });
  assert.equal(saved.refreshToken, "refresh-secret");
  assert.equal(persisted.credentials.datadog.value, undefined);
  assert.equal(persisted.credentials.datadog.refreshToken, undefined);
  assert.equal(persisted.credentials.datadog.secretRef.backend, "fake-secure");
  assert.equal(raw.includes("api-secret"), false);
  assert.equal(raw.includes("refresh-secret"), false);
  assert.deepEqual(hydrated.value, { "DD-API-KEY": "api-secret", "DD-APPLICATION-KEY": "app-secret" });
  assert.equal(hydrated.refreshToken, "refresh-secret");
  assert.equal(summaries[0].hasSecret, true);
  assert.equal(summaries[0].hasRefreshToken, true);
  assert.deepEqual(store.credentialStorageInfo(), {
    backend: "fake-secure",
    encrypted: true,
    credentialsFile: store.credentialsFile
  });
});

function createFakeCredentialBackend() {
  const secrets = new Map();
  return {
    name: "fake-secure",
    async saveSecret({ sourceSlug, field, value }) {
      const key = `${sourceSlug}:${field}`;
      secrets.set(key, value);
      return { backend: "fake-secure", key };
    },
    async readSecret(ref) {
      return secrets.get(ref.key) ?? null;
    }
  };
}

test("computes restart signatures from source config and credentials without exposing secrets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const source = {
    slug: "openai",
    provider: "openai",
    type: "api",
    enabled: true,
    iconUrl: "https://icons.example.com/openai.svg",
    api: {
      baseUrl: "https://api.openai.com/v1/",
      authType: "bearer",
      testEndpoint: { method: "GET", path: "models" },
      iconUrl: "https://icons.example.com/api.svg"
    },
    validation: { ok: true, issues: [] }
  };
  const firstCredential = await store.saveCredential(createCredentialRecord({
    sourceSlug: "openai",
    provider: "openai",
    mode: "bearer",
    value: "secret-a"
  }));
  const first = await getSourceRuntimeSignature({ source, store });
  await store.saveCredential(createCredentialRecord({
    sourceSlug: "openai",
    provider: "openai",
    mode: "bearer",
    value: "secret-b"
  }));
  const second = await getSourceRuntimeSignature({ source, store });
  const displayOnly = await getSourceRuntimeSignature({
    source: { ...source, iconUrl: "https://icons.example.com/changed.svg" },
    store
  });

  assert.equal(first.signature.length, 64);
  assert.equal(first.credentialSignature, credentialRestartSignature(firstCredential));
  assert.notEqual(first.signature, second.signature);
  assert.equal(second.signature, displayOnly.signature);
  assert.equal(JSON.stringify(second).includes("secret-b"), false);
});

test("applies source auth modes without mutating secrets into summaries", () => {
  const bearerSource = { slug: "openai", api: { baseUrl: "https://api.openai.com/v1/", authType: "bearer" } };
  const headerSource = { slug: "datadog", api: { baseUrl: "https://api.datadoghq.com/api/", authType: "header", headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"] } };
  const querySource = { slug: "weather", api: { baseUrl: "https://api.example.com/", authType: "query", queryParam: "apikey" } };
  const basicSource = { slug: "ashby", api: { baseUrl: "https://api.example.com/", authType: "basic", passwordRequired: false } };
  const multiHeader = credentialFromPromptInput(headerSource, { fields: { "DD-API-KEY": "a", "DD-APPLICATION-KEY": "b" } });
  const basic = credentialFromPromptInput(basicSource, { fields: { username: "u" } });

  assert.equal(applyApiAuth({ url: "https://api.openai.com/v1/models", source: bearerSource, credential: { value: "tok" } }).headers.authorization, "Bearer tok");
  assert.equal(applyApiAuth({ url: "https://api.example.com/current", source: querySource, credential: { value: "abc" } }).url, "https://api.example.com/current?apikey=abc");
  assert.equal(applyApiAuth({ url: "https://api.example.com/me", source: basicSource, credential: { value: { username: "u", password: "" } } }).headers.authorization, "Basic dTo=");
  assert.equal(applyApiAuth({ url: "https://api.datadoghq.com/api/v1/validate", source: headerSource, credential: { value: { "DD-API-KEY": "a", "DD-APPLICATION-KEY": "b" } } }).headers["DD-APPLICATION-KEY"], "b");
  assert.deepEqual(multiHeader.value, { "DD-API-KEY": "a", "DD-APPLICATION-KEY": "b" });
  assert.deepEqual(basic.value, { username: "u", password: "" });
  assert.throws(() => credentialFromPromptInput(headerSource, { fields: { "DD-API-KEY": "a" } }), /Missing credential field/);
  assert.deepEqual(credentialPromptSpec(headerSource).fields.map((field) => field.name), ["DD-API-KEY", "DD-APPLICATION-KEY"]);
  assert.equal(sourceAuthState(bearerSource, null).connectionStatus, "needs_auth");
  assert.equal(sourceAuthState(bearerSource, { value: "tok" }).isAuthenticated, true);
});

test("tests API sources, persists status, and redacts request auth", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const sourceDir = path.join(workspace, ".craft-agent", "sources", "openai");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "config.json"), JSON.stringify({
    id: "openai_a1b2c3d4",
    name: "OpenAI",
    slug: "openai",
    enabled: true,
    provider: "openai",
    type: "api",
    api: {
      baseUrl: "https://api.openai.com/v1/",
      authType: "bearer",
      testEndpoint: { method: "GET", path: "models" }
    }
  }), "utf8");
  const store = new JsonStore({ workspace });
  await store.saveCredential(createCredentialRecord({ sourceSlug: "openai", mode: "bearer", value: "tok" }));
  const source = await readSource(sourceDir);
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    return { ok: true, status: 200, async text() { return "{\"ok\":true}"; } };
  };

  const result = await testSource({ source, store, fetchImpl });
  const updated = await readSource(sourceDir);
  const request = await executeApiSourceRequest({ source: updated, endpointPath: "models", store, fetchImpl });

  assert.equal(result.connectionStatus, "connected");
  assert.equal(typeof updated.lastTestedAt, "number");
  assert.equal(calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(request.headers.authorization, "[REDACTED]");
});

test("initializes stdio MCP sources and calls listed tools", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const sourceDir = path.join(workspace, ".craft-agent", "sources", "mock-mcp");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "config.json"), JSON.stringify({
    id: "mock_mcp_a1b2c3d4",
    name: "Mock MCP",
    slug: "mock-mcp",
    enabled: true,
    provider: "mock",
    type: "mcp",
    mcp: {
      transport: "stdio",
      authType: "none",
      command: process.execPath,
      args: [path.join(process.cwd(), "fixtures", "mock-mcp-server.mjs")],
      credentialEnv: "MOCK_MCP_TOKEN"
    }
  }), "utf8");
  await writeFile(path.join(sourceDir, "permissions.json"), JSON.stringify({
    allowedTools: ["echo", "secret_env"]
  }), "utf8");
  const store = new JsonStore({ workspace });
  await store.saveCredential(createCredentialRecord({ sourceSlug: "mock-mcp", mode: "bearer", value: "mcp-secret" }));
  const source = await readSource(sourceDir);

  const status = await testSource({ source, store });
  const tools = await listMcpSourceTools({ source });
  const result = await callMcpSourceTool({ source, name: "echo", arguments: { text: "hello mcp" } });
  const secret = await callMcpSourceTool({ source, name: "secret_env", arguments: { name: "MOCK_MCP_TOKEN" }, store });
  await assert.rejects(
    () => callMcpSourceTool({ source, name: "blocked", arguments: {}, store }),
    /MCP tool denied/
  );

  assert.equal(status.connectionStatus, "connected");
  assert.equal((await readSource(sourceDir)).connectionStatus, "connected");
  assert.equal(tools[0].name, "echo");
  assert.deepEqual(result.content, [{ type: "text", text: "hello mcp" }]);
  assert.deepEqual(secret.content, [{ type: "text", text: "mcp-secret" }]);
});

test("initializes HTTP MCP sources with bearer credentials", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  await store.saveCredential(createCredentialRecord({ sourceSlug: "http-mcp", mode: "bearer", value: "http-secret" }));
  const source = {
    id: "http_mcp_a1b2c3d4",
    name: "HTTP MCP",
    slug: "http-mcp",
    enabled: true,
    provider: "mock",
    type: "mcp",
    path: workspace,
    permissions: { allowedTools: ["echo"] },
    validation: { ok: true, issues: [] },
    mcp: {
      transport: "http",
      url: "https://mcp.example.com/rpc",
      authType: "bearer"
    }
  };
  const calls = [];
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ url, request, body });
    const result = body.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} } }
      : body.method === "tools/list"
        ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
        : body.method === "tools/call"
          ? { content: [{ type: "text", text: body.params.arguments.text }], isError: false }
          : {};
    return {
      ok: true,
      status: 200,
      async text() {
        return body.id ? JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) : "";
      }
    };
  };

  const status = await testSource({ source, store, fetchImpl });
  const tools = await listMcpSourceTools({ source, store, fetchImpl });
  const result = await callMcpSourceTool({ source, name: "echo", arguments: { text: "hello http" }, store, fetchImpl });

  assert.equal(status.connectionStatus, "connected");
  assert.equal(tools[0].name, "echo");
  assert.deepEqual(result.content, [{ type: "text", text: "hello http" }]);
  assert.equal(calls[0].url, "https://mcp.example.com/rpc");
  assert.equal(calls[0].request.headers.authorization, "Bearer http-secret");
  assert.equal(calls.some((call) => call.body.method === "notifications/initialized"), true);
});

test("runs OAuth authorization, device, exchange, and refresh helpers", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const source = {
    id: "oauth_mcp_a1b2c3d4",
    name: "OAuth MCP",
    slug: "oauth-mcp",
    enabled: true,
    provider: "mock",
    type: "mcp",
    path: workspace,
    validation: { ok: true, issues: [] },
    mcp: {
      transport: "http",
      url: "https://mcp.example.com/rpc",
      authType: "oauth",
      oauth: {
        authorizationUrl: "https://auth.example.com/authorize",
        deviceAuthorizationUrl: "https://auth.example.com/device",
        tokenUrl: "https://auth.example.com/token",
        clientId: "client-a",
        redirectUri: "http://127.0.0.1/callback",
        scope: ["tools", "profile"]
      }
    }
  };
  const requests = [];
  let pollAttempts = 0;
  const fetchImpl = async (url, request) => {
    requests.push({ url, request, body: new URLSearchParams(request.body) });
    const grant = requests.at(-1).body.get("grant_type");
    if (grant === "urn:ietf:params:oauth:grant-type:device_code" && requests.at(-1).body.get("device_code") === "poll-code") {
      pollAttempts += 1;
      if (pollAttempts === 1) {
        return oauthError("authorization_pending");
      }
      if (pollAttempts === 2) {
        return oauthError("slow_down");
      }
      return oauthSuccess({ access_token: "polled-device-token", expires_in: 60, refresh_token: "refresh-polled" });
    }
    const payload = url.endsWith("/device")
      ? { device_code: "device-code", user_code: "USER", verification_uri: "https://auth.example.com/verify" }
      : grant === "refresh_token"
        ? { access_token: "refreshed", expires_in: 120, refresh_token: "refresh-2" }
        : { access_token: grant === "authorization_code" ? "code-token" : "device-token", expires_in: 60, refresh_token: "refresh-1" };
    return oauthSuccess(payload);
  };

  const authUrl = getSourceOAuthAuthorizationUrl({ source, state: "state-a", codeChallenge: "challenge-a" });
  const state = generateOAuthState();
  const pkce = generateOAuthPkcePair();
  const request = createOAuthAuthorizationRequest(source, { state: "auto", pkce: true, redirectUri: "http://127.0.0.1:3000/callback" });
  const opened = [];
  const openCommand = await openOAuthAuthorizationUrl("https://auth.example.com/start", {
    platform: "darwin",
    execFileImpl: async (file, openArgs) => opened.push({ file, openArgs })
  });
  const device = await startSourceOAuthDeviceFlow({ source, fetchImpl });
  const codeCredential = await exchangeSourceOAuthCode({ source, code: "auth-code", codeVerifier: "verifier", store, fetchImpl });
  const deviceCredential = await exchangeSourceOAuthDeviceCode({ source, deviceCode: device.device_code, store, fetchImpl });
  const sleeps = [];
  const polledCredential = await pollSourceOAuthDeviceCode({
    source,
    deviceCode: "poll-code",
    intervalSecs: 0,
    maxAttempts: 4,
    store,
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms)
  });
  await store.saveCredential({ ...deviceCredential, expiresAt: new Date(Date.now() + 1000).toISOString() });
  const refreshed = await refreshSourceOAuthCredential({ source, store, fetchImpl });

  assert.match(authUrl, /response_type=code/);
  assert.match(authUrl, /code_challenge=challenge-a/);
  assert.equal(state.length > 12, true);
  assert.equal(pkce.codeChallenge.length > 12, true);
  assert.match(request.url, /code_challenge=/);
  assert.match(request.url, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A3000%2Fcallback/);
  assert.equal(request.codeVerifier.length > 12, true);
  assert.deepEqual(opened, [{ file: "open", openArgs: ["https://auth.example.com/start"] }]);
  assert.deepEqual(openCommand, { file: "open", args: ["https://auth.example.com/start"] });
  assert.equal(device.user_code, "USER");
  assert.equal(codeCredential.value, "code-token");
  assert.equal(deviceCredential.value, "device-token");
  assert.equal(polledCredential.value, "polled-device-token");
  assert.deepEqual(sleeps, [0, 5000]);
  assert.equal(refreshed.value, "refreshed");
  assert.equal((await store.getCredential("oauth-mcp")).value, "refreshed");
  assert.equal(JSON.stringify(await store.listCredentialSummaries()).includes("refreshed"), false);
});

function oauthSuccess(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function oauthError(error) {
  return {
    ok: false,
    status: 400,
    async text() {
      return JSON.stringify({ error });
    }
  };
}

test("renews expiring bearer API credentials before source request", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const source = {
    slug: "refreshing",
    type: "api",
    api: {
      baseUrl: "https://api.example.com/",
      authType: "bearer",
      renewEndpoint: {
        path: "auth/refresh",
        method: "POST",
        body: { current: "{{token}}" },
        tokenField: "token",
        expiresInField: "ttl"
      }
    }
  };
  await store.saveCredential(createCredentialRecord({
    sourceSlug: "refreshing",
    mode: "bearer",
    value: "old",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 1000).toISOString()
  }));
  const seen = [];
  const fetchImpl = async (url, request) => {
    seen.push({ url, request });
    if (url.endsWith("/auth/refresh")) {
      return { ok: true, status: 200, async json() { return { token: "new", ttl: 3600 }; } };
    }
    return { ok: true, status: 200, async text() { return "{\"ok\":true}"; } };
  };

  const result = await executeApiSourceRequest({ source, endpointPath: "v1/me", store, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(seen[0].request.body, "{\"current\":\"old\"}");
  assert.equal(seen[1].request.headers.authorization, "Bearer new");
  assert.equal((await store.getCredential("refreshing")).value, "new");
});

test("stores tasks, views, and search records", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const project = createProject({ workspaceId: workspaceRecord.id, name: "Launch", root: workspace });
  await store.saveProject(project);
  const renamedProject = updateProject(project, { name: "Launch Ops" });
  await store.saveProject(renamedProject);
  const session = createSession({
    workspaceId: workspaceRecord.id,
    projectId: project.id,
    prompt: "Follow launch work",
    labels: ["feature"],
    labelConfig: await store.getLabelConfig(),
    statusConfig: await store.getStatusConfig()
  });
  await store.saveSession(session);
  const task = createTask({
    workspaceId: workspaceRecord.id,
    projectId: project.id,
    sessionId: session.id,
    title: "Ship project search",
    description: "Implement searchable task records",
    labels: ["feature::dashboard"],
    statusConfig: await store.getStatusConfig()
  });
  await store.saveTask(task);
  const updated = updateTask(task, { title: "Ship saved views", statusId: "done", labels: ["feature::dashboard", "urgent"] }, await store.getStatusConfig());
  await store.saveTask(updated);
  const done = updateTaskStatus(updated, "done", await store.getStatusConfig());
  await store.saveTask(done);

  const view = createView({
    workspaceId: workspaceRecord.id,
    name: "Done tasks",
    entity: "tasks",
    filters: { statusId: "done" }
  });
  await store.saveView(view);
  const updatedView = updateView(view, { filters: { label: "feature" }, sort: "title:asc" });
  await store.saveView(updatedView);

  assert.equal((await store.listTasks())[0].completedAt !== null, true);
  assert.equal((await store.listTasks({ label: "feature" })).length, 1);
  assert.equal((await store.listTasks({ query: "saved views" }))[0].id, task.id);
  assert.equal((await store.listViews())[0].name, "Done tasks");
  assert.equal(applyView(await store.listTasks(), updatedView).length, 1);
  await store.deleteProject(project.id);
  await assert.rejects(() => store.getProject(project.id), /ENOENT/);
  await store.saveSession({ ...session, projectId: null });
  await store.saveTask({ ...done, projectId: null });
  await store.deleteTask(task.id);
  await store.deleteView(view.id);
  assert.equal((await store.listTasks()).length, 0);
  assert.equal((await store.listViews()).length, 0);
});

test("parses git status and history records", () => {
  const entries = parseGitStatusPorcelain(" M src/app.js\nA  src/new.js\nR  old.txt -> new.txt\n?? notes.md\nUU conflict.txt");
  const summary = summarizeGitStatus(entries);

  assert.deepEqual(
    entries.map((entry) => [entry.category, entry.path, entry.originalPath]),
    [
      ["modified", "src/app.js", null],
      ["added", "src/new.js", null],
      ["renamed", "new.txt", "old.txt"],
      ["untracked", "notes.md", null],
      ["conflicted", "conflict.txt", null]
    ]
  );
  assert.equal(summary.total, 5);
  assert.equal(summary.renamed, 1);

  const log = `abc123\x1fAda\x1f2026-08-07 12:00:00 +0800\x1fInitial clone\x1e`;
  assert.deepEqual(parseGitLog(log), [
    {
      hash: "abc123",
      shortHash: "abc123",
      author: "Ada",
      date: "2026-08-07 12:00:00 +0800",
      subject: "Initial clone"
    }
  ]);
  assert.match(gitLogPrettyFormat(), /%x1f/);
});

test("runs git status, history, diff, branch, and stash helpers", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-git-"));
  await gitExec(workspace, ["init"]);
  await gitExec(workspace, ["config", "user.name", "YuuMira Test"]);
  await gitExec(workspace, ["config", "user.email", "yuumira-test@example.invalid"]);
  await writeFile(path.join(workspace, "note.txt"), "initial\n", "utf8");

  assert.equal((await gitStage({ cwd: workspace, pathspecs: ["note.txt"] })).ok, true);
  await gitExec(workspace, ["commit", "-m", "Initial commit"]);
  await writeFile(path.join(workspace, "note.txt"), "initial\nchanged\n", "utf8");
  await writeFile(path.join(workspace, "draft.txt"), "draft\n", "utf8");

  const status = await gitStatus({ cwd: workspace });
  assert.equal(status.ok, true);
  assert.equal(status.summary.modified, 1);
  assert.equal(status.summary.untracked, 1);
  assert.match(await gitDiff({ cwd: workspace, pathspecs: ["note.txt"] }), /changed/);
  assert.equal((await gitGenerateCommitMessage({ cwd: workspace })).startsWith("Update 2 files"), true);

  assert.equal((await gitCreateBranch({ cwd: workspace, name: "feature/git-rpc", checkout: true })).ok, true);
  assert.equal((await gitBranches({ cwd: workspace })).some((branch) => branch.name === "feature/git-rpc" && branch.current), true);
  assert.equal((await gitHistory({ cwd: workspace, limit: 5 }))[0].subject, "Initial commit");
  assert.equal((await gitSaveStash({ cwd: workspace, message: "stash rpc changes", includeUntracked: true })).ok, true);
  assert.equal((await gitStashes({ cwd: workspace }))[0].subject.includes("stash rpc changes"), true);
});

test("stores terminal history and resolves tool icons", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const record = createTerminalRecord({
    workspaceId: workspaceRecord.id,
    command: "npm test",
    cwd: workspace,
    exitCode: 0,
    output: "ok",
    startedAt: "2026-08-07T00:00:00.000Z",
    endedAt: "2026-08-07T00:00:02.000Z"
  });

  await store.saveTerminalRecord(record);
  const session = createTerminalSession({
    workspaceId: workspaceRecord.id,
    name: "Build",
    cwd: workspace,
    dimensions: { cols: 100, rows: 30 }
  });
  await store.saveTerminalSession(session);
  const attached = await store.attachTerminalRecordToSession(session.id, record.id);

  assert.equal((await store.listTerminalHistory({ query: "npm" })).length, 1);
  assert.equal((await store.getTerminalRecord(record.id)).sessionId, session.id);
  assert.deepEqual(attached.session.recordIds, [record.id]);
  assert.equal((await store.listTerminalSessions({ status: "open" })).length, 1);
  const closed = await store.closeTerminalSession(session.id, { closedAt: "2026-08-07T00:00:03.000Z" });
  assert.equal(closed.status, "closed");
  assert.equal((await store.listTerminalSessions({ status: "closed" })).length, 1);
  assert.equal(filterTerminalHistory([record], { exitCode: 0 })[0].durationMs, 2000);
  assert.equal(resolveToolIcon("npm run test").tool.id, "npm");
  assert.match(resolveToolIcon("npm run test").tool.path, /^\/resources\/tool-icons\/npm\.png$/);
  assert.equal(resourceManifest().toolIcons.count > 10, true);
  assert.equal(resourceManifest().themes.some((theme) => theme.id === "default"), true);
  assert.equal(resourceManifest().docs.some((document) => document.fileName === "permissions.md"), true);
  assert.equal(resourceManifest().releaseNotes.some((note) => note.fileName === "0.11.11.md"), true);
  assert.equal(resourceManifest().permissions.some((permission) => permission.fileName === "default.json"), true);
  assert.equal(resourceManifest().logos.some((logo) => logo.fileName === "craft_app_icon.png"), true);
  assert.equal(resourceManifest().bins.some((bin) => bin.fileName === "docx-tool"), true);
  assert.equal(resourceManifest().scripts.some((script) => script.fileName === "docx_tool.py"), true);
  assert.equal(resourceManifest().scriptTests.some((script) => script.fileName === "test_docx_tool_smoke.py"), true);
  assert.equal(resourceManifest().files.some((file) => file.fileName === "config-defaults.json"), true);
  const npmIcon = resolveResource("/resources/tool-icons/npm.png");
  assert.equal(npmIcon.contentType, "image/png");
  assert.deepEqual([...npmIcon.body.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(resolveResource("/resources/docs/permissions.md").contentType, "text/markdown; charset=utf-8");
  assert.equal(resolveResource("/resources/permissions/default.json").contentType, "application/json; charset=utf-8");
  assert.equal(resolveResource("/resources/bin/docx-tool").contentType, "text/x-shellscript; charset=utf-8");
  assert.equal(resolveResource("/resources/scripts/docx_tool.py").contentType, "text/x-python; charset=utf-8");
  assert.equal(resolveResource("/resources/scripts/sharp-worker.mjs").contentType, "text/javascript; charset=utf-8");
  assert.equal(resolveResource("/resources/source.png").contentType, "image/png");
  const runtime = testRuntime(workspace);
  const helperList = await runtime.tools.run("helpers.list", {}, { store: runtime.store });
  const helperPlan = await runtime.tools.run("helpers.plan", { name: "docx-tool", args: ["--help"] }, { store: runtime.store });
  const helperProfiles = await runtime.tools.run("helpers.smoke_profiles", {}, { store: runtime.store });
  const helperBehaviorProfiles = await runtime.tools.run("helpers.behavior_profiles", {}, { store: runtime.store });
  const helperSmoke = await runtime.tools.run("helpers.smoke", { names: ["docx-tool"], profile: "help", timeoutMs: 1 }, { store: runtime.store });
  const bundleAudit = await runtime.tools.run("audit.bundle", { appPath: "/missing/YuuMira.app" }, { store: runtime.store });
  const providerRequest = await runtime.tools.run("provider.model_request", {
    provider: { id: "ollama", type: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
    useOllamaTags: true
  }, { store: runtime.store });
  assert.equal(helperList.bins.some((helper) => helper.name === "docx-tool"), true);
  assert.equal(helperList.bins.find((helper) => helper.name === "docx-tool").script.dependencies.some((dependency) => dependency.startsWith("python-docx")), true);
  assert.equal(helperPlan.env.CRAFT_SCRIPTS.endsWith("/resources/scripts"), true);
  assert.equal(helperPlan.script.name, "docx_tool.py");
  assert.match(helperPlan.command, /docx-tool/);
  assert.equal(helperProfiles.some((profile) => profile.id === "help"), true);
  assert.equal(helperBehaviorProfiles.some((profile) => profile.id === "ical-basic"), true);
  assert.equal(helperBehaviorProfiles.some((profile) => profile.id === "xlsx-basic"), true);
  assert.equal(helperBehaviorProfiles.some((profile) => profile.id === "docx-basic"), true);
  assert.equal(helperBehaviorProfiles.some((profile) => profile.id === "img-basic"), true);
  assert.equal(helperBehaviorProfiles.some((profile) => profile.id === "markitdown-basic"), true);
  assert.equal(helperBehaviorProfiles.some((profile) => profile.id === "pdf-basic"), true);
  assert.equal(helperBehaviorProfiles.some((profile) => profile.id === "pptx-basic"), true);
  assert.equal(helperBehaviorProfiles.some((profile) => profile.id === "doc-diff-basic"), true);
  assert.deepEqual(helperSmoke.args, ["--help"]);
  assert.equal(helperSmoke.count, 1);
  assert.equal(helperSmoke.results[0].name, "docx-tool");
  assert.equal(typeof helperSmoke.results[0].diagnosis.status, "string");
  assert.equal(bundleAudit.app.exists, false);
  assert.equal(bundleAudit.comparisons.ok, false);
  assert.equal(providerRequest.url, "http://127.0.0.1:11434/api/tags");
  assert.equal(providerRequest.parser, "ollama-tags");
});

test("records terminal chunks and replays terminal events", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  let record = createTerminalRecord({
    workspaceId: workspaceRecord.id,
    command: "npm test",
    cwd: workspace,
    startedAt: "2026-08-07T00:00:00.000Z"
  });

  record = recordTerminalChunk(record, { stream: "stdout", data: "ok\n", createdAt: "2026-08-07T00:00:01.000Z" });
  record = recordTerminalChunk(record, { stream: "stderr", data: "warn\n", createdAt: "2026-08-07T00:00:02.000Z" });
  record = finishTerminalRecord(record, { exitCode: 1, endedAt: "2026-08-07T00:00:03.000Z" });
  await store.saveTerminalRecord(record);

  const saved = await store.getTerminalRecord(record.id);
  const replay = replayTerminalRecord(saved);
  assert.equal(saved.status, "failed");
  assert.equal(saved.durationMs, 3000);
  assert.equal(replay.output, "ok\nwarn\n");
  assert.deepEqual(replay.frames.map((frame) => frame.type), ["output", "output", "exit"]);
});

test("runs terminal commands and captures stdout and stderr", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('hello'); console.error('warn')")}`;

  const record = await executeTerminalCommand({
    workspaceId: workspaceRecord.id,
    command,
    cwd: workspace,
    saveRecord: (recordToSave) => store.saveTerminalRecord(recordToSave)
  });

  const saved = await store.getTerminalRecord(record.id);
  const replay = replayTerminalRecord(saved);
  assert.equal(saved.status, "completed");
  assert.equal(saved.exitCode, 0);
  assert.match(replay.output, /hello/);
  assert.match(replay.output, /warn/);
  assert.equal(saved.events.some((event) => event.stream === "stderr"), true);
});

test("starts and cancels managed terminal processes", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const manager = new TerminalProcessManager({
    saveRecord: (recordToSave) => store.saveTerminalRecord(recordToSave)
  });
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => console.log('tick'), 20)")}`;

  const record = await manager.start({ workspaceId: workspaceRecord.id, command, cwd: workspace });
  assert.equal(manager.status(record.id).running, true);
  await waitFor(() => store.getTerminalRecord(record.id).then((item) => item.output.includes("tick")));
  await manager.cancel(record.id);
  await waitFor(() => store.getTerminalRecord(record.id).then((item) => item.status === "cancelled"));
  await waitFor(() => manager.status(record.id).running === false);

  const saved = await store.getTerminalRecord(record.id);
  assert.equal(saved.status, "cancelled");
  assert.equal(manager.status(record.id).running, false);
});

test("writes input to managed terminal processes", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const manager = new TerminalProcessManager({
    saveRecord: (recordToSave) => store.saveTerminalRecord(recordToSave)
  });
  const script = "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { console.log('input:' + data.trim()); if (data.includes('done')) process.exit(0); });";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

  const record = await manager.start({ workspaceId: workspaceRecord.id, command, cwd: workspace });
  await manager.write(record.id, { data: "done\n" });
  await waitFor(() => store.getTerminalRecord(record.id).then((item) => item.status === "completed"));

  const replay = replayTerminalRecord(await store.getTerminalRecord(record.id));
  assert.equal(replay.frames.some((frame) => frame.type === "input" && frame.data === "done\n"), true);
  assert.match(replay.output, /input:done/);
  assert.equal(manager.status(record.id).running, false);
});

test("records terminal resize dimensions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  const workspaceRecord = await store.getWorkspace();
  const manager = new TerminalProcessManager({
    saveRecord: (recordToSave) => store.saveTerminalRecord(recordToSave)
  });
  const script = "setInterval(() => {}, 1000);";
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

  const record = await manager.start({ workspaceId: workspaceRecord.id, command, cwd: workspace, dimensions: { cols: 100, rows: 30 } });
  try {
    assert.deepEqual(record.dimensions, { cols: 100, rows: 30 });
    assert.deepEqual(manager.status(record.id).dimensions, { cols: 100, rows: 30 });
    const resized = await manager.resize(record.id, { cols: 120, rows: 40 });
    assert.deepEqual(resized.dimensions, { cols: 120, rows: 40 });
    assert.deepEqual(manager.status(record.id).dimensions, { cols: 120, rows: 40 });

    const replay = replayTerminalRecord(await store.getTerminalRecord(record.id));
    assert.equal(replay.frames.some((frame) => frame.type === "resize" && frame.data === "{\"cols\":120,\"rows\":40}"), true);
  } finally {
    if (manager.status(record.id).running) {
      await manager.cancel(record.id);
      await waitFor(() => manager.status(record.id).running === false);
    }
  }
});

test("knowledge tools create, index, report, and search", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const vault = path.join(workspace, "vault");
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, "qmd.md"), "# QMD\n\nSemantic search can be unavailable while literal search works.\n", "utf8");
  const runtime = testRuntime(workspace);
  const collection = await runtime.tools.run("knowledge.create_collection", { name: "Notes", root: vault }, { store: runtime.store });
  const report = await runtime.tools.run("knowledge.index", { collectionId: collection.id }, { store: runtime.store });
  const results = await runtime.tools.run("knowledge.search", { query: "literal" }, { store: runtime.store });
  const updated = await runtime.tools.run("knowledge.update_collection", { collectionId: collection.id, name: "Notes Updated" }, { store: runtime.store });
  const inspection = await runtime.tools.run("knowledge.inspect", {}, { store: runtime.store });
  const repaired = await runtime.tools.run("knowledge.repair", {}, { store: runtime.store });
  const semanticConfigured = await runtime.tools.run("knowledge.semantic_configure", { model: "tool-embed-test", installed: true, status: "ready", reason: null }, { store: runtime.store });
  const semanticJob = await runtime.tools.run("knowledge.semantic_job", { collectionId: collection.id }, { store: runtime.store });
  const semanticStatus = await runtime.tools.run("knowledge.semantic_status", {}, { store: runtime.store });
  const semanticResults = await runtime.tools.run("knowledge.search", { query: "semantic search", semantic: true }, { store: runtime.store });

  assert.equal(report.documentCount, 1);
  assert.equal((await runtime.tools.run("knowledge.report", {}, { store: runtime.store })).collectionCount, 1);
  assert.equal(results[0].title, "QMD");
  assert.equal(updated.name, "Notes Updated");
  assert.equal(inspection.collectionCount, 1);
  assert.equal(repaired.documentCount, 1);
  assert.equal(semanticConfigured.state.model, "tool-embed-test");
  assert.equal(semanticJob.job.status, "completed");
  assert.equal(semanticResults[0].title, "QMD");
  assert.equal(semanticStatus.semanticEngine.latestJob.id, semanticJob.job.id);
  assert.equal((await runtime.tools.run("knowledge.delete_collection", { collectionId: collection.id }, { store: runtime.store })).id, collection.id);
});

test("runtime injects memory context only when requested", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-test-"));
  const store = new JsonStore({ workspace });
  await store.appendMemoryRecord(createMemoryRecord({ text: "Use compact implementation notes." }));
  const systems = [];
  const provider = {
    name: "capture",
    async complete({ system }) {
      systems.push(system);
      return { content: "done", toolCalls: [] };
    }
  };
  const runtime = createRuntime({
    workspace,
    store,
    provider,
    tools: createDefaultTools({ workspace })
  });

  await runtime.runTask({ prompt: "implementation notes" });
  await runtime.runTask({ prompt: "implementation notes", includeMemory: true });

  assert.equal(systems[0].includes("<memory_context>"), false);
  assert.equal(systems[1].includes("<memory_context>"), true);
});

function testRuntime(workspace) {
  return createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider: new DeterministicProvider(),
    tools: createDefaultTools({ workspace })
  });
}

function gitExec(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function waitFor(check, { timeoutMs = 1000, intervalMs = 20 } = {}) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error("Timed out waiting for condition.");
}
