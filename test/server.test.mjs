import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeterministicProvider } from "../src/provider.js";
import { createOAuthCallbackServer } from "../src/oauth.js";
import { createRuntime } from "../src/runtime.js";
import { buildCraftServer, craftServerBuildCommand, parseBuildOptions } from "../src/server-build.js";
import { createServer } from "../src/server.js";
import { CRAFT_SERVER_MANIFEST, parseServerOptions, startHeadlessServer } from "../src/server-entry.js";
import { JsonStore } from "../src/store.js";
import { createDefaultTools } from "../src/tools.js";

test("serves health, sessions, and run endpoints", async () => {
  const { app, baseUrl } = await testServer();
  try {
    assert.deepEqual(await getJson(`${baseUrl}/health`), { ok: true });
    const config = await getJson(`${baseUrl}/api/config`);
    assert.match(config.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    assert.equal(config.httpUrl, baseUrl);
    assert.equal(config.webSocketPath, "/ws");
    assert.equal(config.defaultWorkspaceId, config.workspace.id);
    assert.equal(config.workspace.root, app.workspace);
    assert.equal(config.workspace.path, app.workspace);
    const workspaces = await getJson(`${baseUrl}/api/config/workspaces`);
    assert.equal(workspaces.defaultWorkspaceId, config.workspace.id);
    assert.equal(workspaces.activeWorkspace.id, config.workspace.id);
    assert.deepEqual(workspaces.workspaces.map((workspace) => workspace.id), [config.workspace.id]);
    assert.deepEqual(await postJson(`${baseUrl}/api/auth`, { password: "local-test" }), { ok: true, authenticated: true, mode: "none" });
    assert.deepEqual(await postJson(`${baseUrl}/api/auth/logout`, {}), { ok: true });
    const pushKey = await getJson(`${baseUrl}/api/push/vapid-public-key`);
    assert.equal(pushKey.available, true);
    assert.match(pushKey.publicKey, /^[A-Za-z0-9_-]+$/);
    const pushSubscription = await postJson(`${baseUrl}/api/push/subscribe`, {
      endpoint: "https://push.example.invalid/subscription/1",
      keys: { p256dh: "p256dh-test", auth: "auth-test" }
    });
    assert.equal(pushSubscription.subscription.endpoint, "https://push.example.invalid/subscription/1");
    assert.equal(pushSubscription.subscriptions.length, 1);
    const updatedPushSubscription = await postJson(`${baseUrl}/api/push/subscribe`, {
      endpoint: "https://push.example.invalid/subscription/1",
      keys: { p256dh: "p256dh-test-2", auth: "auth-test-2" }
    });
    assert.equal(updatedPushSubscription.subscriptions.length, 1);
    assert.equal(updatedPushSubscription.subscription.keys.auth, "auth-test-2");
    assert.equal((await getJson(`${baseUrl}/api/push/subscriptions`)).length, 1);
    const deletedPushSubscription = await deleteJson(`${baseUrl}/api/push/subscribe`, { endpoint: "https://push.example.invalid/subscription/1" });
    assert.equal(deletedPushSubscription.deleted, true);
    assert.equal((await getJson(`${baseUrl}/api/push/subscriptions`)).length, 0);
    assert.equal((await getJson(`${baseUrl}/api/provider`)).name, "deterministic");
    assert.equal((await getJson(`${baseUrl}/api/provider/profiles`)).some((profile) => profile.id === "openrouter"), true);
    const powerLease = await postJson(`${baseUrl}/api/power/prevent-sleep`, { reason: "server-test" });
    assert.equal(powerLease.state.preventSleep, true);
    assert.equal((await getJson(`${baseUrl}/api/power`)).leaseCount >= 1, true);
    assert.equal((await postJson(`${baseUrl}/api/power/allow-sleep`, { id: powerLease.token.id })).released.id, powerLease.token.id);
    const modelRequest = await getJson(`${baseUrl}/api/provider/model-request?profile=anthropic&apiKey=test-key`);
    assert.equal(modelRequest.url, "https://api.anthropic.com/v1/models");
    assert.equal(modelRequest.headers["x-api-key"], "test-key");
    assert.match(await getText(`${baseUrl}/`), /<title>Peng<\/title>/);
    const loginHtml = await getText(`${baseUrl}/login`);
    assert.match(loginHtml, /<title>Peng/);
    assert.match(loginHtml, /id="login-form"/);
    assert.equal((await getJson(`${baseUrl}/manifest.json`)).name, "Peng");

    const session = await postJson(`${baseUrl}/api/sessions`, {
      prompt: "Investigate server API",
      labels: ["api"]
    });
    assert.equal(session.statusId, "todo");
    assert.deepEqual(session.labels, ["api"]);

    const statusResult = await patchJson(`${baseUrl}/api/sessions/${session.id}/status`, {
      statusId: "needs-review"
    });
    assert.equal(statusResult.event.type, "SessionStatusChange");
    assert.equal(statusResult.session.statusId, "needs-review");

    const run = await postJson(`${baseUrl}/api/run`, { prompt: "List workspace files" });
    assert.equal(run.thread.status, "completed");
    assert.match(run.output, /workspace\.list/);
    const protocolEvents = await getJson(`${baseUrl}/api/protocol/events?threadId=${run.thread.id}`);
    assert.equal(protocolEvents[0].type, "run.started");
    assert.equal(protocolEvents.some((event) => event.type === "tool.completed"), true);
    assert.equal((await getJson(`${baseUrl}/api/protocol/events?type=run.completed`)).some((event) => event.threadId === run.thread.id), true);
    const queued = await postJson(`${baseUrl}/api/threads/${run.thread.id}/messages`, { content: "Summarize the previous run" });
    assert.equal(queued.status, "pending");
    assert.equal((await getJson(`${baseUrl}/api/queued-messages?threadId=${run.thread.id}`))[0].id, queued.id);
    const replayed = await postJson(`${baseUrl}/api/threads/${run.thread.id}/replay-queue`, {});
    assert.equal(replayed.replayed[0].status, "applied");
    assert.equal((await getJson(`${baseUrl}/api/run-control`)).some((control) => control.threadId === run.thread.id), true);
    const stopped = await postJson(`${baseUrl}/api/threads/${run.thread.id}/stop`, { reason: "server_test" });
    assert.equal(stopped.status, "stop_requested");
    assert.equal((await postJson(`${baseUrl}/api/run-control/watchdog`, { staleAfterMs: 1 })).stale.length >= 0, true);

    const project = await postJson(`${baseUrl}/api/projects`, { name: "Server Project" });
    const renamedProject = await patchJson(`${baseUrl}/api/projects/${project.id}`, { name: "Server Project Updated" });
    assert.equal(renamedProject.name, "Server Project Updated");
    const task = await postJson(`${baseUrl}/api/tasks`, {
      title: "Server task",
      projectId: project.id,
      labels: ["api"]
    });
    const updatedTask = await patchJson(`${baseUrl}/api/tasks/${task.id}`, { title: "Server task updated", labels: ["api", "urgent"] });
    assert.equal(updatedTask.title, "Server task updated");
    assert.equal((await getJson(`${baseUrl}/api/tasks?label=api`))[0].id, task.id);
    const doneTask = await patchJson(`${baseUrl}/api/tasks/${task.id}/status`, { statusId: "done" });
    assert.equal(doneTask.statusId, "done");

    assert.equal((await postJson(`${baseUrl}/api/labels`, { id: "api", name: "API", valueType: "string" })).labels[0].id, "api");
    assert.equal((await patchJson(`${baseUrl}/api/labels/api`, { id: "area", name: "Area" })).migrated.sessions, 1);
    assert.deepEqual((await getJson(`${baseUrl}/api/labels?q=area`)).labels.map((label) => label.id), ["area"]);
    assert.deepEqual((await getJson(`${baseUrl}/api/sessions/${session.id}`)).labels, ["area"]);
    assert.deepEqual((await getJson(`${baseUrl}/api/tasks/${task.id}`)).labels, ["area", "urgent"]);

    const view = await postJson(`${baseUrl}/api/views`, {
      name: "Done tasks",
      entity: "tasks",
      filters: { statusId: "done" }
    });
    const updatedView = await patchJson(`${baseUrl}/api/views/${view.id}`, { filters: { label: "area" }, sort: "title:asc" });
    assert.deepEqual(updatedView.filters, { label: "area" });
    assert.equal((await getJson(`${baseUrl}/api/views/${view.id}`)).items.length, 1);
    assert.equal((await getJson(`${baseUrl}/api/search?q=Server%20task%20updated`))[0].type, "task");
    assert.equal((await deleteJson(`${baseUrl}/api/labels/area`)).migrated.tasks, 1);
    assert.deepEqual((await getJson(`${baseUrl}/api/sessions/${session.id}`)).labels, []);

    const blockedConfig = await postJson(`${baseUrl}/api/statuses`, { id: "blocked", label: "Blocked", color: "warning" });
    assert.equal(blockedConfig.statuses.some((status) => status.id === "blocked"), true);
    assert.equal((await patchJson(`${baseUrl}/api/statuses/default`, { statusId: "blocked" })).defaultStatusId, "blocked");
    assert.equal((await patchJson(`${baseUrl}/api/sessions/${session.id}/status`, { statusId: "blocked" })).session.statusId, "blocked");
    assert.equal((await patchJson(`${baseUrl}/api/tasks/${task.id}/status`, { statusId: "blocked" })).statusId, "blocked");
    const deletedStatus = await deleteJson(`${baseUrl}/api/statuses/blocked`, { replacementStatusId: "todo" });
    assert.deepEqual(deletedStatus.migrated, { sessions: 1, tasks: 1 });
    assert.equal((await getJson(`${baseUrl}/api/sessions/${session.id}`)).statusId, "todo");
    assert.equal((await getJson(`${baseUrl}/api/tasks/${task.id}`)).statusId, "todo");
    assert.equal((await deleteJson(`${baseUrl}/api/views/${view.id}`)).id, view.id);
    assert.equal((await deleteJson(`${baseUrl}/api/projects/${project.id}`)).detached.tasks, 1);
    assert.equal((await getJson(`${baseUrl}/api/tasks/${task.id}`)).projectId, null);
    assert.equal((await deleteJson(`${baseUrl}/api/tasks/${task.id}`)).id, task.id);

    const memory = await postJson(`${baseUrl}/api/memory`, {
      text: "Server tests should cover memory context with password=hidden-secret"
    });
    assert.match(memory.id, /^memory_/);
    assert.match(memory.text, /password=\[REDACTED\]/);
    assert.equal((await getJson(`${baseUrl}/api/memory/search?q=context`))[0].id, memory.id);
    assert.match((await postJson(`${baseUrl}/api/memory/context`, { query: "server tests" })).context, /<memory_context>/);
    const citations = await postJson(`${baseUrl}/api/memory/citations`, { text: `[memory:${memory.id}]` });
    assert.deepEqual(citations.ids, [memory.id]);
    assert.equal(citations.records[0].usageCount, 1);
    assert.equal((await postJson(`${baseUrl}/api/memory/extract`, { text: "Remember prefer compact status updates.", persist: true })).persisted, 1);
    assert.match((await postJson(`${baseUrl}/api/memory/maintain`, { maxRecords: 10 })).markdownPath, /MEMORIES\.md$/);

    const vault = path.join(app.workspace, "vault");
    await mkdir(vault, { recursive: true });
    await writeFile(path.join(vault, "server-knowledge.md"), "# Server Knowledge\n\nHTTP routes index knowledge collections.\n", "utf8");
    const collection = await postJson(`${baseUrl}/api/knowledge/collections`, { name: "Server Vault", root: vault });
    assert.equal((await patchJson(`${baseUrl}/api/knowledge/collections/${collection.id}`, { name: "Server Vault Updated" })).name, "Server Vault Updated");
    const report = await postJson(`${baseUrl}/api/knowledge/index`, { collectionId: collection.id });
    assert.equal(report.documentCount, 1);
    assert.equal((await getJson(`${baseUrl}/api/knowledge/semantic`)).semanticEngine.status, "unavailable");
    const semanticConfigured = await patchJson(`${baseUrl}/api/knowledge/semantic`, { model: "local-embed-test", installed: true, status: "ready", reason: null });
    assert.equal(semanticConfigured.state.model, "local-embed-test");
    const semanticJob = await postJson(`${baseUrl}/api/knowledge/semantic/jobs`, { collectionId: collection.id });
    assert.equal(semanticJob.job.status, "completed");
    assert.equal(semanticJob.job.documentCount, 1);
    assert.equal((await getJson(`${baseUrl}/api/knowledge/search?q=routes`))[0].title, "Server Knowledge");
    assert.equal((await getJson(`${baseUrl}/api/knowledge/search?q=http%20routes&semantic=true`))[0].title, "Server Knowledge");
    assert.equal((await getJson(`${baseUrl}/api/knowledge/report`)).collectionCount, 1);
    assert.equal((await getJson(`${baseUrl}/api/knowledge/inspect`)).collectionCount, 1);
    assert.equal((await getJson(`${baseUrl}/api/messaging/status`)).gateway.running, false);
    const inboundMessage = await postJson(`${baseUrl}/api/messaging/inbound`, { platform: "telegram", chatId: "chat-1", text: "Hello from Telegram" });
    assert.equal(inboundMessage.session.messages[0].content, "Hello from Telegram");
    const whatsAppMessage = await postJson(`${baseUrl}/api/messaging/inbound`, { platform: "whatsapp", chatId: "wa-chat-1", text: "Hello from WhatsApp", createSession: false });
    assert.equal(whatsAppMessage.event.payload.platform, "whatsapp");
    assert.equal(whatsAppMessage.session, null);
    assert.equal((await getJson(`${baseUrl}/api/messaging/events`))[0].type, "inboundMessage");
    assert.equal((await postJson(`${baseUrl}/api/knowledge/repair`, {})).documentCount, 1);
    assert.equal((await deleteJson(`${baseUrl}/api/knowledge/collections/${collection.id}`)).id, collection.id);
    assert.equal((await getJson(`${baseUrl}/api/knowledge/documents?collectionId=${collection.id}`)).length, 0);

    const sourceDir = path.join(app.workspace, ".craft-agent", "sources", "openai");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      path.join(sourceDir, "config.json"),
      JSON.stringify({
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
      }),
      "utf8"
    );
    assert.equal((await getJson(`${baseUrl}/api/sources`))[0].connectionStatus, "needs_auth");
    assert.equal((await getJson(`${baseUrl}/api/sources/openai/auth-help`)).mode, "bearer");
    const credential = await postJson(`${baseUrl}/api/credentials`, { sourceSlug: "openai", mode: "bearer", value: "test-token" });
    assert.equal(credential.hasSecret, true);
    const promptedCredential = await postJson(`${baseUrl}/api/sources/openai/credentials`, { fields: { token: "prompt-token" } });
    assert.equal(promptedCredential.hasSecret, true);
    assert.equal((await getJson(`${baseUrl}/api/sources/openai/auth-state`)).isAuthenticated, true);
    assert.equal((await getJson(`${baseUrl}/api/sources/openai/runtime-signature`)).signature.length, 64);
    assert.equal((await postJson(`${baseUrl}/api/sources/openai/apply-api-auth`, { url: "https://api.openai.com/v1/models" })).headers.authorization, "Bearer prompt-token");

    const localSourceDir = path.join(app.workspace, ".craft-agent", "sources", "notes");
    await mkdir(localSourceDir, { recursive: true });
    await writeFile(
      path.join(localSourceDir, "config.json"),
      JSON.stringify({
        id: "notes_a1b2c3d4",
        name: "Notes",
        slug: "notes",
        enabled: true,
        provider: "obsidian",
        type: "local",
        local: { path: vault }
      }),
      "utf8"
    );
    assert.equal((await postJson(`${baseUrl}/api/sources/notes/test`, {})).connectionStatus, "connected");

    const mcpSourceDir = path.join(app.workspace, ".craft-agent", "sources", "mock-mcp");
    await mkdir(mcpSourceDir, { recursive: true });
    await writeFile(
      path.join(mcpSourceDir, "config.json"),
      JSON.stringify({
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
          args: [path.join(process.cwd(), "fixtures", "mock-mcp-server.mjs")]
        }
      }),
      "utf8"
    );
    await writeFile(path.join(mcpSourceDir, "permissions.json"), JSON.stringify({ allowedTools: ["echo"] }), "utf8");
    assert.equal((await postJson(`${baseUrl}/api/sources/mock-mcp/test`, {})).connectionStatus, "connected");
    assert.equal((await getJson(`${baseUrl}/api/sources/mock-mcp/mcp-tools`))[0].name, "echo");
    assert.deepEqual((await postJson(`${baseUrl}/api/sources/mock-mcp/mcp-call`, { name: "echo", arguments: { text: "hello api" } })).content[0].text, "hello api");

    const status = await postJson(`${baseUrl}/api/git/status/parse`, { text: " M src/server.js\n?? notes.md" });
    assert.equal(status.summary.modified, 1);
    assert.equal(status.summary.untracked, 1);

    const terminal = await postJson(`${baseUrl}/api/terminal/history`, { command: "npm test", exitCode: 0, output: "ok" });
    assert.equal(terminal.command, "npm test");
    assert.equal((await getJson(`${baseUrl}/api/terminal/history?q=npm`))[0].id, terminal.id);
    const terminalSession = await postJson(`${baseUrl}/api/terminal/sessions`, { name: "Server Shell", dimensions: { cols: 100, rows: 30 } });
    assert.equal(terminalSession.status, "open");
    const eventedTerminal = await postJson(`${baseUrl}/api/terminal/history`, { command: "node build.mjs", startedAt: "2026-08-07T00:00:00.000Z" });
    await postJson(`${baseUrl}/api/terminal/history/${eventedTerminal.id}/events`, { stream: "stdout", data: "building\n", createdAt: "2026-08-07T00:00:01.000Z" });
    const finishedTerminal = await postJson(`${baseUrl}/api/terminal/history/${eventedTerminal.id}/finish`, { exitCode: 0, endedAt: "2026-08-07T00:00:02.000Z" });
    assert.equal(finishedTerminal.status, "completed");
    assert.equal((await getJson(`${baseUrl}/api/terminal/history/${eventedTerminal.id}/replay`)).output, "building\n");
    const runTerminal = await postJson(`${baseUrl}/api/terminal/run`, {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('from server')")}`,
      sessionId: terminalSession.id
    });
    assert.equal(runTerminal.exitCode, 0);
    assert.equal(runTerminal.sessionId, terminalSession.id);
    assert.deepEqual((await getJson(`${baseUrl}/api/terminal/sessions/${terminalSession.id}`)).recordIds, [runTerminal.id]);
    assert.equal((await getJson(`${baseUrl}/api/terminal/sessions?status=open`)).some((session) => session.id === terminalSession.id), true);
    assert.match((await getJson(`${baseUrl}/api/terminal/history/${runTerminal.id}/replay`)).output, /from server/);
    const startedTerminal = await postJson(`${baseUrl}/api/terminal/start`, {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => console.log('server tick'), 20)")}`
    });
    assert.equal(startedTerminal.status, "running");
    assert.equal((await getJson(`${baseUrl}/api/terminal/history/${startedTerminal.id}/process`)).running, true);
    await waitFor(() => getJson(`${baseUrl}/api/terminal/history/${startedTerminal.id}/replay`).then((item) => item.output.includes("server tick")));
    assert.equal((await postJson(`${baseUrl}/api/terminal/history/${startedTerminal.id}/cancel`, {})).status, "cancelled");
    await waitFor(() => getJson(`${baseUrl}/api/terminal/history/${startedTerminal.id}`).then((item) => item.status === "cancelled"));
    const inputScript = "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { console.log('server input:' + data.trim()); if (data.includes('done')) process.exit(0); });";
    const inputTerminal = await postJson(`${baseUrl}/api/terminal/start`, {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(inputScript)}`
    });
    await postJson(`${baseUrl}/api/terminal/history/${inputTerminal.id}/input`, { data: "done\n" });
    await waitFor(() => getJson(`${baseUrl}/api/terminal/history/${inputTerminal.id}/replay`).then((item) => item.output.includes("server input:done")));
    const inputReplay = await getJson(`${baseUrl}/api/terminal/history/${inputTerminal.id}/replay`);
    assert.equal(inputReplay.frames.some((frame) => frame.type === "input" && frame.data === "done\n"), true);
    const resizeTerminal = await postJson(`${baseUrl}/api/terminal/start`, {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      dimensions: { cols: 90, rows: 25 }
    });
    const resizedTerminal = await postJson(`${baseUrl}/api/terminal/history/${resizeTerminal.id}/resize`, { cols: 132, rows: 43 });
    assert.deepEqual(resizedTerminal.dimensions, { cols: 132, rows: 43 });
    assert.deepEqual((await getJson(`${baseUrl}/api/terminal/history/${resizeTerminal.id}/process`)).dimensions, { cols: 132, rows: 43 });
    assert.equal((await getJson(`${baseUrl}/api/terminal/history/${resizeTerminal.id}/replay`)).frames.some((frame) => frame.type === "resize"), true);
    await postJson(`${baseUrl}/api/terminal/history/${resizeTerminal.id}/cancel`, {});
    assert.equal((await postJson(`${baseUrl}/api/terminal/sessions/${terminalSession.id}/close`, {})).status, "closed");
    assert.equal((await getJson(`${baseUrl}/api/automations/lint`)).ok, true);
    assert.equal((await postJson(`${baseUrl}/api/automations/run`, { event: { type: "Notification", matchValue: "noop" } })).history.eventType, "Notification");
    await app.runtime.store.saveAutomationConfig({
      version: 2,
      automations: {
        SchedulerTick: [
          {
            matcher: "2026-08-07",
            actions: [{ type: "prompt", prompt: "Server scheduled tick at $CRAFT_EVENT_DATA" }]
          }
        ]
      }
    });
    const schedulerTick = await postJson(`${baseUrl}/api/automations/scheduler/tick`, { now: "2026-08-07T09:30:00.000Z" });
    assert.equal(schedulerTick.history.eventType, "SchedulerTick");
    assert.equal(schedulerTick.results[0].type, "prompt");
    assert.equal((await getJson(`${baseUrl}/api/automations/scheduler`)).running, false);
    assert.equal((await postJson(`${baseUrl}/api/automations/scheduler/start`, { intervalMs: 1000 })).running, true);
    assert.equal((await postJson(`${baseUrl}/api/automations/scheduler/stop`, {})).running, false);
    const toolIcon = await getJson(`${baseUrl}/api/tool-icons?command=npm%20test`);
    assert.equal(toolIcon.tool.id, "npm");
    assert.equal(toolIcon.tool.path, "/resources/tool-icons/npm.png");
    const resources = await getJson(`${baseUrl}/api/resources`);
    assert.equal(resources.toolIcons.count > 10, true);
    assert.equal(resources.themes.some((theme) => theme.id === "default"), true);
    assert.equal(resources.docs.some((document) => document.fileName === "permissions.md"), true);
    assert.equal(resources.releaseNotes.some((note) => note.fileName === "0.11.11.md"), true);
    assert.equal(resources.permissions.some((permission) => permission.fileName === "default.json"), true);
    assert.equal(resources.logos.some((logo) => logo.fileName === "craft_app_icon.png"), true);
    assert.equal(resources.bins.some((bin) => bin.fileName === "docx-tool"), true);
    assert.equal(resources.scripts.some((script) => script.fileName === "docx_tool.py"), true);
    assert.equal(resources.scriptTests.some((script) => script.fileName === "test_docx_tool_smoke.py"), true);
    assert.equal(resources.webui.some((file) => file.relativePath === "index.html"), true);
    assert.equal(resources.webui.some((file) => file.relativePath.startsWith("assets/") && file.fileName.endsWith(".js")), true);
    assert.equal(resources.webuiEntrypoints.ok, true);
    assert.equal(resources.webuiEntrypoints.checkedCount > 0, true);
    assert.equal(resources.files.some((file) => file.fileName === "source.png"), true);
    const bundleAudit = await getJson(`${baseUrl}/api/audit/bundle?appPath=/missing/Peng.app`);
    assert.equal(bundleAudit.app.exists, false);
    assert.equal(bundleAudit.comparisons.ok, false);
    const npmIconResponse = await fetch(`${baseUrl}/resources/tool-icons/npm.png`);
    assert.equal(npmIconResponse.headers.get("content-type"), "image/png");
    const npmIconBytes = new Uint8Array(await npmIconResponse.arrayBuffer());
    assert.deepEqual([...npmIconBytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await getJson(`${baseUrl}/resources/tool-icons/tool-icons.json`)).tools.some((tool) => tool.id === "npm"), true);
    assert.equal((await getJson(`${baseUrl}/resources/themes/default.json`)).name, "Default");
    assert.match(await getText(`${baseUrl}/resources/docs/permissions.md`), /Permissions/);
    assert.equal((await getJson(`${baseUrl}/resources/permissions/default.json`)).version, "2026-03-07");
    assert.match(await getText(`${baseUrl}/resources/bin/docx-tool`), /CRAFT_UV/);
    assert.match(await getText(`${baseUrl}/resources/scripts/docx_tool.py`), /Word document/);
    assert.match(await getText(`${baseUrl}/resources/scripts/tests/test_docx_tool_smoke.py`), /test_create/);
    assert.match(await getText(`${baseUrl}/resources/webui/index.html`), /root|script/);
    const webuiAsset = resources.webui.find((file) => file.relativePath.startsWith("assets/") && file.fileName.endsWith(".js"));
    assert.equal((await fetch(`${baseUrl}${webuiAsset.path}`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    const rootHtml = await getText(`${baseUrl}/`);
    assert.match(rootHtml, /Peng/);
    assert.equal((await getJson(`${baseUrl}/manifest.json`)).name, "Peng");
    const rootAssetPath = `/${webuiAsset.relativePath}`;
    assert.equal((await fetch(`${baseUrl}${rootAssetPath}`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    const rootScript = rootHtml.match(/\bsrc=["']\.\/(assets\/[^"']+\.js)["']/)?.[1];
    const rootStyle = rootHtml.match(/\bhref=["']\.\/(assets\/[^"']+\.css)["']/)?.[1];
    assert.ok(rootScript);
    assert.ok(rootStyle);
    assert.equal((await fetch(`${baseUrl}/${rootScript}`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await fetch(`${baseUrl}/${rootStyle}`)).headers.get("content-type"), "text/css; charset=utf-8");
    const sourceImageResponse = await fetch(`${baseUrl}/resources/source.png`);
    assert.equal(sourceImageResponse.headers.get("content-type"), "image/png");
    const helpers = await getJson(`${baseUrl}/api/helpers`);
    assert.equal(helpers.bins.some((helper) => helper.name === "docx-tool"), true);
    assert.equal(helpers.bins.find((helper) => helper.name === "docx-tool").script.dependencies.some((dependency) => dependency.startsWith("python-docx")), true);
    const helperPlan = await postJson(`${baseUrl}/api/helpers/docx-tool/plan`, { args: ["--help"] });
    assert.equal(helperPlan.name, "docx-tool");
    assert.equal(helperPlan.script.name, "docx_tool.py");
    assert.equal(helperPlan.env.CRAFT_SCRIPTS.endsWith("/resources/scripts"), true);
    assert.equal((await getJson(`${baseUrl}/api/helpers/smoke-profiles`)).some((profile) => profile.id === "help"), true);
    const behaviorProfiles = await getJson(`${baseUrl}/api/helpers/behavior-profiles`);
    assert.equal(behaviorProfiles.some((profile) => profile.id === "ical-basic"), true);
    assert.equal(behaviorProfiles.some((profile) => profile.id === "xlsx-basic"), true);
    assert.equal(behaviorProfiles.some((profile) => profile.id === "docx-basic"), true);
    assert.equal(behaviorProfiles.some((profile) => profile.id === "img-basic"), true);
    assert.equal(behaviorProfiles.some((profile) => profile.id === "markitdown-basic"), true);
    assert.equal(behaviorProfiles.some((profile) => profile.id === "pdf-basic"), true);
    assert.equal(behaviorProfiles.some((profile) => profile.id === "pptx-basic"), true);
    assert.equal(behaviorProfiles.some((profile) => profile.id === "doc-diff-basic"), true);
    const helperSmoke = await postJson(`${baseUrl}/api/helpers/smoke`, { names: ["docx-tool"], profile: "help", timeoutMs: 1 });
    assert.deepEqual(helperSmoke.args, ["--help"]);
    assert.equal(helperSmoke.count, 1);
    assert.equal(helperSmoke.results[0].name, "docx-tool");
    assert.equal(typeof helperSmoke.results[0].diagnosis.status, "string");
  } finally {
    await app.close();
  }
});

test("streams server-sent events", async () => {
  const { app, baseUrl } = await testServer();
  try {
    const eventPromise = waitForEvent(`${baseUrl}/events`, "session.created");
    const session = await postJson(`${baseUrl}/api/sessions`, { prompt: "Watch events" });
    const event = await eventPromise;

    assert.equal(event.session.id, session.id);
  } finally {
    await app.close();
  }
});

test("streams and controls runs over WebSocket", async () => {
  const { app, baseUrl } = await testServer();
  const socket = await connectWebSocket(baseUrl);
  try {
    const ready = await socket.nextMessage();
    assert.equal(ready.type, "ready");

    socket.send({ id: "ping-1", type: "ping" });
    const pong = await socket.waitForType("pong");
    assert.equal(pong.id, "ping-1");
    assert.deepEqual(pong.payload, { ok: true });
    socket.send({ requestId: "ping-2", event: "ping" });
    const aliasPong = await socket.waitForType("pong");
    assert.equal(aliasPong.requestId, "ping-2");
    assert.equal(aliasPong.ok, true);

    socket.send({ id: "run-1", type: "run.start", payload: { prompt: "List workspace files" } });
    const protocolStarted = await socket.waitForType("protocol.event");
    assert.equal(protocolStarted.payload.type, "run.started");
    const result = await socket.waitForType("run.result");
    assert.equal(result.id, "run-1");
    assert.equal(result.payload.thread.status, "completed");
    assert.match(result.payload.output, /workspace\.list/);

    const completed = await socket.waitForType("thread.completed");
    assert.equal(completed.payload.thread.id, result.payload.thread.id);

    socket.send({ requestId: "message-1", action: "message.queue", data: { threadId: result.payload.thread.id, content: "Queue via alias" } });
    const queued = await socket.waitForType("thread.message.result");
    assert.equal(queued.requestId, "message-1");
    assert.equal(queued.ok, true);
    assert.equal(queued.data.status, "pending");

    socket.send({
      id: "rpc-handshake-1",
      type: "handshake",
      protocolVersion: "1.0",
      workspaceId: app.workspace,
      clientCapabilities: ["basic-session-flow"]
    });
    const handshake = await socket.waitForType("handshake_ack");
    assert.equal(handshake.id, "rpc-handshake-1");
    assert.equal(handshake.protocolVersion, "1.0");
    assert.match(handshake.clientId, /^client_/);
	    const rpc = async (id, channel, args = []) => {
	      socket.send({ id, type: "request", channel, args });
	      return socket.nextMessage((message) => message.type === "response" && message.id === id).catch((error) => {
	        error.message = `${error.message} (${id} ${channel})`;
	        throw error;
	      });
	    };

    const rpcWorkspaces = await rpc("rpc-workspaces-1", "workspaces:get");
    assert.equal(rpcWorkspaces.channel, "workspaces:get");
    assert.equal(rpcWorkspaces.result[0].root, app.workspace);

    const rpcSessionCreated = await rpc("rpc-session-create-1", "sessions:create", [{ prompt: "RPC session prompt" }]);
    assert.equal(rpcSessionCreated.result.messages[0].role, "user");
    assert.equal(rpcSessionCreated.result.messages[0].content, "RPC session prompt");

    const rpcMessages = await rpc("rpc-session-messages-1", "sessions:getMessages", [rpcSessionCreated.result.id]);
    assert.equal(rpcMessages.result.messages.length, 1);

    const rpcSent = await rpc("rpc-session-send-1", "sessions:sendMessage", [{ sessionId: rpcSessionCreated.result.id, content: "Follow-up over RPC" }]);
    assert.equal(rpcSent.result.messages.at(-1).content, "Follow-up over RPC");

    assert.equal((await rpc("rpc-preferences-1", "preferences:read")).result.sendMessageKey, "enter");
    assert.equal((await rpc("rpc-input-1", "input:setSendMessageKey", ["shift-enter"])).result, "shift-enter");
    assert.equal((await rpc("rpc-input-2", "input:getSendMessageKey")).result, "shift-enter");
    assert.equal((await rpc("rpc-draft-set-1", "drafts:set", [{ key: "session:draft", value: "hello draft" }])).result.value, "hello draft");
    assert.equal((await rpc("rpc-draft-get-1", "drafts:get", ["session:draft"])).result.value, "hello draft");
    assert.equal((await rpc("rpc-draft-all-1", "drafts:getAll")).result.length, 1);
		    assert.equal((await rpc("rpc-theme-1", "theme:getPresets")).result.some((theme) => theme.id === "default"), true);
		    assert.equal((await rpc("rpc-theme-broadcast-1", "theme:broadcastPreferences", [{ theme: "default" }])).result.status, "recorded");
		    assert.equal((await rpc("rpc-power-1", "power:setKeepAwake", [true])).result, true);
	    assert.equal((await rpc("rpc-memory-1", "memory:setEnabled", [false])).result, false);
	    assert.equal((await rpc("rpc-memory-2", "memory:getEnabled")).result, false);
		    assert.equal((await rpc("rpc-cache-1", "caching:setExtendedPromptCache", [true])).result, true);
		    assert.equal((await rpc("rpc-tools-1", "tools:getSmartSnapshotSettings")).result.enabled, true);
		    const rpcTrace = (await rpc("rpc-observability-trace-1", "observability:getSessionTrace", [rpcSessionCreated.result.id])).result;
		    assert.equal(rpcTrace.events.some((event) => event.type === "session.message.created"), true);
		    assert.equal(rpcTrace.mode, "local-protocol-events");
		    const rpcUsage = (await rpc("rpc-observability-usage-1", "observability:getSessionUsage", [rpcSessionCreated.result.id])).result;
		    assert.equal(rpcUsage.totalTokens > 0, true);
		    assert.equal((await rpc("rpc-usage-quota-1", "usageQuota:get")).result.sessions.some((usage) => usage.sessionId === rpcSessionCreated.result.id), true);
		    const llmMissingKeyTest = (await rpc("rpc-llm-test-1", "settings:testLlmConnectionSetup", [{ provider: "anthropic" }])).result;
	    assert.equal(llmMissingKeyTest.status, "needs_credentials");
	    assert.equal(llmMissingKeyTest.models.length, 0);
	    assert.equal((await rpc("rpc-llm-save-1", "settings:setupLlmConnection", [{ provider: "anthropic", model: "claude-test" }])).result.connection.model, "claude-test");
	    assert.equal((await rpc("rpc-pi-base-1", "pi:getProviderBaseUrl", ["anthropic"])).result, "https://api.anthropic.com/v1");
	    assert.equal((await rpc("rpc-pi-models-1", "pi:getProviderModels", [{ provider: "anthropic", planOnly: true }])).result.request.parser, "anthropic");
	    const savedLlmConnection = (await rpc("rpc-llm-connection-save-1", "LLM_Connection:save", [{ id: "local-openai", provider: "openai-compatible", baseUrl: "https://llm.example.invalid/v1", model: "gpt-test", hasApiKey: true, setDefault: true }])).result;
	    assert.equal(savedLlmConnection.connection.id, "local-openai");
	    assert.equal((await rpc("rpc-llm-connection-list-1", "LLM_Connection:list")).result.some((connection) => connection.id === "local-openai"), true);
	    assert.equal((await rpc("rpc-llm-connection-status-1", "LLM_Connection:listWithStatus")).result.find((connection) => connection.id === "local-openai").status, "configured");
	    assert.equal((await rpc("rpc-llm-connection-get-1", "LLM_Connection:get", ["local-openai"])).result.model, "gpt-test");
	    assert.equal((await rpc("rpc-llm-connection-key-1", "LLM_Connection:getApiKey", ["local-openai"])).result.redacted, "***");
		    assert.equal((await rpc("rpc-llm-connection-default-1", "LLM_Connection:setDefault", ["local-openai"])).result.defaultId, "local-openai");
		    assert.equal((await rpc("rpc-llm-connection-workspace-1", "LLM_Connection:setWorkspaceDefault", ["local-openai"])).result.workspaceDefaultId, "local-openai");
			    assert.equal((await rpc("rpc-llm-connection-test-1", "LLM_Connection:test", [{ provider: "openai-compatible", baseUrl: "https://llm.example.invalid/v1" }])).result.status, "needs_credentials");
		    assert.equal((await rpc("rpc-llm-connection-changed-1", "LLM_Connection:changed", [{ connectionId: "local-openai" }])).result.event.channel, "LLM_Connection:changed");
		    await rpc("rpc-llm-connection-save-2", "LLM_Connection:save", [{ id: "delete-me", provider: "ollama" }]);
	    assert.equal((await rpc("rpc-llm-connection-delete-1", "LLM_Connection:delete", ["delete-me"])).result.deletedId, "delete-me");
	    assert.equal((await rpc("rpc-goal-set-1", "goal:set", [{ title: "RPC Goal", description: "exercise loop state" }])).result.title, "RPC Goal");
	    assert.equal((await rpc("rpc-goal-get-1", "goal:get")).result.status, "active");
	    const rpcLoop = (await rpc("rpc-loop-design-1", "loop:designStart", [{ id: "rpc-loop", name: "RPC Loop", steps: ["plan", "run"] }])).result;
	    assert.equal(rpcLoop.id, "rpc-loop");
	    assert.equal((await rpc("rpc-loop-list-1", "loop:list")).result.some((loop) => loop.id === "rpc-loop"), true);
	    assert.equal((await rpc("rpc-loop-get-1", "loop:get", ["rpc-loop"])).result.name, "RPC Loop");
	    const rpcLoopRun = (await rpc("rpc-loop-start-1", "loop:start", [{ loopId: "rpc-loop", prompt: "Run the RPC loop" }])).result.run;
	    assert.equal(rpcLoopRun.status, "running");
	    assert.equal((await rpc("rpc-loop-runs-1", "loop:runs", [{ loopId: "rpc-loop" }])).result.some((run) => run.id === rpcLoopRun.id), true);
	    assert.equal((await rpc("rpc-loop-action-1", "loop:action", [{ runId: rpcLoopRun.id, type: "approve", payload: { ok: true } }])).result.action.type, "approve");
	    assert.equal((await rpc("rpc-loop-event-1", "loop:event", [{ runId: rpcLoopRun.id, type: "checkpoint" }])).result.event.type, "checkpoint");
	    assert.equal((await rpc("rpc-goal-clear-1", "goal:clear")).result, null);
		    assert.equal((await rpc("rpc-onboarding-1", "onboarding:getAuthState")).result.authenticated, true);
		    const onboardingOAuth = (await rpc("rpc-onboarding-oauth-start-1", "onboarding:startClaudeOAuth", [{ state: "state-rpc", codeVerifier: "verifier-rpc" }])).result;
		    assert.equal(onboardingOAuth.status, "pending");
		    assert.equal(onboardingOAuth.state, "state-rpc");
		    assert.match(onboardingOAuth.authorizationUrl, /^https:\/\/claude\.ai\/oauth\/authorize/);
		    assert.equal((await rpc("rpc-onboarding-oauth-has-1", "onboarding:hasClaudeOAuthState")).result, true);
		    const onboardingExchange = (await rpc("rpc-onboarding-oauth-exchange-1", "onboarding:exchangeClaudeCode", [{ state: "state-rpc", code: "claude-code-rpc" }])).result;
		    assert.equal(onboardingExchange.status, "exchanged");
		    assert.equal(onboardingExchange.session.code, "cl***pc");
		    assert.equal((await rpc("rpc-onboarding-2", "onboarding:getAuthState")).result.claudeOAuth.status, "exchanged");
		    assert.equal((await rpc("rpc-onboarding-oauth-clear-1", "onboarding:clearClaudeOAuthState")).result.claudeOAuthState, null);
		    assert.equal((await rpc("rpc-session-model-1", "session:setModel", [{ sessionId: rpcSessionCreated.result.id, model: "claude-test" }])).result.model, "claude-test");
	    assert.equal((await rpc("rpc-session-model-2", "session:getModel", [rpcSessionCreated.result.id])).result.model, "claude-test");
		    const rpcSessionEvent = (await rpc("rpc-session-event-1", "session:event", [{ sessionId: rpcSessionCreated.result.id, type: "focused", payload: { pane: "chat" } }])).result;
		    assert.equal(rpcSessionEvent.status, "recorded");
		    assert.equal(rpcSessionEvent.mode, "local-state");
		    assert.equal(rpcSessionEvent.event.command, "focused");
		    assert.equal(rpcSessionEvent.event.sessionId, rpcSessionCreated.result.id);
		    const rpcSessionCommand = (await rpc("rpc-session-command-1", "sessions:command", [{ sessionId: rpcSessionCreated.result.id, command: "retry-last-turn" }])).result;
		    assert.equal(rpcSessionCommand.status, "recorded");
		    assert.equal(rpcSessionCommand.event.command, "retry-last-turn");
	    assert.equal((await rpc("rpc-workspace-settings-1", "workspaceSettings:update", [{ defaultModel: "claude-test" }])).result.config.defaultModel, "claude-test");
	    const latestReleaseVersion = (await rpc("rpc-release-1", "releaseNotes:getLatestVersion")).result;
	    assert.match(latestReleaseVersion, /^\d+\.\d+\.\d+$/);
	    const releaseNote = (await rpc("rpc-release-2", "releaseNotes:get", [{ version: latestReleaseVersion }])).result;
	    assert.equal(releaseNote.selected.id, latestReleaseVersion);
	    assert.match(releaseNote.content, /## Features/);
	    assert.match((await rpc("rpc-logo-1", "logo:getUrl")).result, /^\/resources\//);
	    assert.equal(typeof (await rpc("rpc-system-debug-1", "system:isDebugMode")).result, "boolean");
	    assert.equal((await rpc("rpc-terminal-1", "terminal:getFrequentCommands")).result.length, 0);
	    const rpcTerminalRecord = (await rpc("rpc-terminal-record-1", "terminal:recordCommand", [{ command: "npm test", output: "ok" }])).result.recorded;
	    assert.equal(rpcTerminalRecord.command, "npm test");
	    await rpc("rpc-terminal-record-2", "terminal:recordCommand", [{ command: "npm test" }]);
	    assert.equal((await rpc("rpc-terminal-2", "terminal:getFrequentCommands")).result.find((item) => item.command === "npm test").count, 2);
	    assert.equal((await rpc("rpc-terminal-delete-1", "terminal:deleteFrequent", [{ command: "npm test" }])).result.frequentCommands.some((item) => item.command === "npm test"), false);
	    await writeFile(path.join(app.workspace, "rpc-note.txt"), "RPC file read", "utf8");
	    assert.equal((await rpc("rpc-file-1", "file:read", ["rpc-note.txt"])).result, "RPC file read");
	    const fileWrite = (await rpc("rpc-file-write-1", "file:writeText", [{ path: "generated/rpc-write.txt", text: "written over RPC" }])).result;
	    assert.equal(fileWrite.written, true);
	    assert.equal(fileWrite.file.path, "generated/rpc-write.txt");
	    assert.equal((await rpc("rpc-file-stat-1", "file:stat", [{ path: "generated/rpc-write.txt" }])).result.file.size, 16);
	    assert.equal((await rpc("rpc-file-exists-1", "file:exists", [{ path: "generated/rpc-write.txt" }])).result.exists, true);
	    assert.equal((await rpc("rpc-file-read-written-1", "file:read", ["generated/rpc-write.txt"])).result, "written over RPC");
	    assert.equal((await rpc("rpc-file-delete-1", "file:delete", [{ path: "generated/rpc-write.txt" }])).result.deleted, true);
	    assert.equal((await rpc("rpc-file-exists-2", "file:exists", [{ path: "generated/rpc-write.txt" }])).result.exists, false);
	    assert.match((await rpc("rpc-file-thumbnail-1", "file:generateThumbnail", [{ path: "rpc-note.txt" }])).result.dataUrl, /^data:application\/octet-stream;base64,/);
	    assert.equal((await rpc("rpc-file-store-attachment-1", "file:storeAttachment", [{ fileName: "stored.txt", content: Buffer.from("stored attachment").toString("base64") }])).result.fileName, "stored.txt");
	    assert.equal((await rpc("rpc-file-read-attachment-1", "file:readAttachment", [{ path: ".peng/attachments/stored.txt" }])).result.base64, Buffer.from("stored attachment").toString("base64"));
	    const fileDialog = (await rpc("rpc-file-dialog-1", "file:openDialog", [{ defaultPath: ".", filters: [{ extensions: ["txt"] }] }])).result;
	    assert.equal(fileDialog.cancelled, false);
	    assert.equal(fileDialog.selected, "rpc-note.txt");
	    await gitExec(app.workspace, ["init"]);
	    await gitExec(app.workspace, ["config", "user.name", "Peng RPC Test"]);
	    await gitExec(app.workspace, ["config", "user.email", "peng-rpc@example.invalid"]);
	    assert.equal((await rpc("rpc-git-status-1", "git:getStatus")).result.ok, true);
	    assert.equal((await rpc("rpc-git-stage-1", "git:stage", [{ paths: ["rpc-note.txt"] }])).result.ok, true);
	    assert.equal((await rpc("rpc-git-message-1", "git:generateCommitMessage")).result.message.includes("Update"), true);
	    assert.equal((await rpc("rpc-git-branches-1", "git:listBranches")).result.length >= 0, true);
	    assert.equal((await rpc("rpc-fs-1", "fs:listDirectory", ["."])).result.some((entry) => entry.name === "rpc-note.txt"), true);
	    assert.equal((await rpc("rpc-workspace-permissions-1", "workspace:getPermissions")).result.permissionMode, "safe");
	    assert.equal((await rpc("rpc-workspace-files-1", "workspace:getFiles", [{ path: "." }])).result.files.some((entry) => entry.name === "rpc-note.txt"), true);
	    const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
	    assert.equal((await rpc("rpc-workspace-image-write-1", "workspace:writeImage", [{ path: "images/rpc.png", dataUrl: imageDataUrl }])).result.contentType, "image/png");
	    assert.match((await rpc("rpc-workspace-image-read-1", "workspace:readImage", ["images/rpc.png"])).result.dataUrl, /^data:image\/png;base64,/);
	    const watchResult = (await rpc("rpc-workspace-watch-1", "workspace:watchFiles", [{ paths: ["."] }])).result;
	    assert.equal(watchResult.watched, true);
	    assert.deepEqual(watchResult.watchers, ["."]);
	    await writeFile(path.join(app.workspace, "watched-rpc.txt"), "watch me", "utf8");
	    await waitFor(async () => {
	      const events = await getJson(`${baseUrl}/api/workspace/file-events`);
	      return events.some((event) => event.path === "watched-rpc.txt" && event.source === "fs.watch");
	    }, { timeoutMs: 3000 });
	    const manualChange = (await rpc("rpc-workspace-files-changed-1", "workspace:filesChanged", [{ path: "manual-watch.txt" }])).result;
	    assert.equal(manualChange.ok, true);
	    assert.equal(manualChange.event.path, "manual-watch.txt");
	    assert.equal((await rpc("rpc-workspace-unwatch-1", "workspace:unwatchFiles", [{ paths: ["."] }])).result.watched, false);
	    assert.equal((await rpc("rpc-menu-new-chat-1", "menu:newChat", [{ name: "Menu Chat" }])).result.session.name, "Menu Chat");
	    assert.equal(typeof (await rpc("rpc-menu-sidebar-1", "menu:toggleSidebar")).result.sidebarVisible, "boolean");
	    assert.equal((await rpc("rpc-menu-zoom-1", "menu:zoomIn")).result.zoom > 1, true);
	    const menuCopy = (await rpc("rpc-menu-copy-1", "menu:copy")).result;
	    assert.equal(menuCopy.status, "registered");
	    assert.equal(menuCopy.mode, "local-intent");
	    assert.equal(menuCopy.intent.kind, "edit");
	    assert.equal("reason" in menuCopy, false);
	    const menuSettings = (await rpc("rpc-menu-settings-1", "menu:openSettings")).result;
	    assert.equal(menuSettings.status, "registered");
	    assert.equal(menuSettings.intent.kind, "window");
	    const shellUrl = (await rpc("rpc-shell-open-url-1", "shell:openUrl", [{ url: "https://example.invalid" }])).result;
	    assert.equal(shellUrl.status, "registered");
	    assert.equal(shellUrl.mode, "local-intent");
	    assert.equal(shellUrl.nativeExecuted, false);
	    assert.equal("reason" in shellUrl, false);
	    const shellFile = (await rpc("rpc-shell-open-file-1", "shell:openFile", [{ path: "rpc-note.txt" }])).result;
	    assert.equal(shellFile.path, "rpc-note.txt");
	    assert.equal(shellFile.kind, "workspace-path");
	    assert.equal((await rpc("rpc-auth-dialog-1", "auth:showLogoutConfirmation", [{ title: "Logout?" }])).result.shown, true);
	    assert.equal((await rpc("rpc-auth-logout-1", "auth:logout")).result.status, "signed_out");
	    const folderDialog = (await rpc("rpc-dialog-folder-1", "dialog:openFolder", [{ defaultPath: "." }])).result;
	    assert.equal(folderDialog.cancelled, false);
	    assert.equal(folderDialog.selected, ".");
	    assert.equal((await rpc("rpc-deeplink-1", "deeplink:navigate", [{ route: "settings" }])).result.deeplink.route, "settings");
		    assert.equal((await rpc("rpc-debug-log-1", "debug:log", [{ message: "rpc debug" }])).result.entry.message, "rpc debug");
		    assert.equal((await rpc("rpc-credentials-health-1", "credentials:healthCheck")).result.ok, true);
		    assert.equal((await rpc("rpc-permissions-defaults-1", "permissions:getDefaults")).result.version, "2026-03-07");
		    const rpcPermissionsChanged = (await rpc("rpc-permissions-changed-1", "permissions:defaultsChanged", [{ source: "test" }])).result;
		    assert.equal(rpcPermissionsChanged.status, "recorded");
		    assert.equal(rpcPermissionsChanged.event.channel, "permissions:defaultsChanged");
	    const resourcesExport = (await rpc("rpc-resources-export-1", "resources:export")).result;
	    assert.equal(resourcesExport.exported, true);
	    assert.equal(resourcesExport.manifest.toolIcons.count > 0, true);
	    assert.equal(resourcesExport.target, ".peng/resource-exports/resource-manifest.json");
	    const resourcesImport = (await rpc("rpc-resources-import-1", "resources:import", [{ includeWebui: true, out: "imported-resources" }])).result;
	    assert.equal(resourcesImport.imported, true);
	    assert.equal(resourcesImport.outputRoot, "imported-resources");
	    assert.equal(resourcesImport.manifest.directories.some((item) => item.directory === "webui"), true);
	    assert.equal((await rpc("rpc-gitbash-check-1", "gitbash:check")).result.status, "unconfigured");
	    assert.equal((await rpc("rpc-gitbash-set-1", "gitbash:setPath", [{ path: "C:/Program Files/Git/bin/bash.exe" }])).result.path, "C:/Program Files/Git/bin/bash.exe");
	    const gitbashBrowse = (await rpc("rpc-gitbash-browse-1", "gitbash:browse")).result;
	    assert.equal(gitbashBrowse.cancelled, false);
	    assert.equal(gitbashBrowse.selected, "C:/Program Files/Git/bin/bash.exe");
	    assert.equal(gitbashBrowse.nativeOpened, false);
	    const oauthSession = (await rpc("rpc-oauth-start-1", "oauth:start", [{ provider: "rpc-provider" }])).result;
	    assert.equal(oauthSession.status, "pending");
	    assert.equal((await rpc("rpc-oauth-revoke-1", "oauth:revoke", [{ id: oauthSession.id }])).result.sessions.some((session) => session.status === "revoked"), true);
	    const badgeIcon = (await rpc("rpc-badge-set-icon-1", "badge:setIcon", [{ icon: "source.png" }])).result;
	    assert.equal(badgeIcon.badge.icon, "source.png");
	    assert.equal(badgeIcon.mode, "local-state");
	    assert.equal(badgeIcon.nativeApplied, false);
	    const badgeDraw = (await rpc("rpc-badge-draw-1", "badge:draw", [{ count: 3, text: "3" }])).result;
	    assert.equal(badgeDraw.badge.count, 3);
	    assert.equal(badgeDraw.event.command, "draw");
	    assert.equal((await rpc("rpc-badge-windows-1", "badge:draw-windows", [{ count: 4 }])).result.badge.platform, "windows");
	    const badgeRefresh = (await rpc("rpc-badge-refresh-1", "badge:refresh")).result;
	    assert.equal(badgeRefresh.ok, true);
	    assert.equal(badgeRefresh.events.length, 4);
	    assert.equal("reason" in badgeRefresh, false);
		    assert.equal((await rpc("rpc-window-focus-1", "window:getFocusState")).result.state.focused, true);
		    assert.equal((await rpc("rpc-window-focus-2", "window:focusState", [{ focused: false }])).result.event.focused, false);
		    const sessionWindow = (await rpc("rpc-window-session-1", "window:openSessionInNewWindow", [{ sessionId: rpcSessionCreated.result.id }])).result;
		    assert.equal(sessionWindow.state.openedSessions[0].sessionId, rpcSessionCreated.result.id);
		    assert.equal(sessionWindow.state.openedSessions[0].nativeOpened, false);
		    const workspaceWindow = (await rpc("rpc-window-workspace-1", "window:openWorkspace", [{ path: app.workspace }])).result;
		    assert.equal(workspaceWindow.state.openedWorkspaces[0].status, "registered");
		    const closeRequest = (await rpc("rpc-window-close-1", "window:closeRequested", [{ source: "window-button" }])).result;
		    assert.equal(closeRequest.state.closeRequested, true);
		    assert.equal(closeRequest.state.closeRequest.source, "window-button");
		    assert.equal((await rpc("rpc-window-cancel-close-1", "window:cancelClose")).result.state.closeCancelled, true);
		    assert.equal((await rpc("rpc-window-confirm-close-1", "window:confirmClose")).result.events.some((event) => event.command === "confirmClose"), true);
		    assert.equal((await rpc("rpc-theme-create-1", "theme:createSkin", [{ id: "rpc-skin", name: "RPC Skin" }])).result.skin.name, "RPC Skin");
	    assert.equal((await rpc("rpc-theme-event-1", "theme:preferencesChanged", [{ source: "test" }])).result.ok, true);
	    const deleteSkillDir = path.join(app.workspace, ".craft-agent", "skills", "delete-me");
	    await mkdir(deleteSkillDir, { recursive: true });
	    await writeFile(path.join(deleteSkillDir, "SKILL.md"), "---\nname: Delete Me\ndescription: temporary RPC delete target\n---\n\nDelete body\n", "utf8");
	    assert.equal((await rpc("rpc-skills-changed-1", "skills:changed")).result.skills.some((skill) => skill.slug === "delete-me"), true);
	    const skillEditor = (await rpc("rpc-skills-open-editor-1", "skills:openEditor", [{ path: ".agents/skills" }])).result;
	    assert.equal(skillEditor.opened, true);
	    assert.equal(skillEditor.nativeOpened, false);
	    assert.equal(skillEditor.target, ".agents/skills");
	    const skillFinder = (await rpc("rpc-skills-open-finder-1", "skills:openFinder", [{ path: "." }])).result;
	    assert.equal(skillFinder.opened, true);
	    assert.equal(skillFinder.intent.mode, "folder");
	    const deletedSkill = (await rpc("rpc-skills-delete-1", "skills:delete", [{ slug: "delete-me" }])).result;
	    assert.equal(deletedSkill.deleted, true);
	    assert.equal(deletedSkill.softDeleted, true);
	    assert.match(deletedSkill.archivedPath, /^\.peng\/deleted-skills\//);
	    assert.equal((await rpc("rpc-skills-changed-2", "skills:changed")).result.skills.some((skill) => skill.slug === "delete-me"), false);
		    const rpcNotificationShow = (await rpc("rpc-notification-show-1", "notification:show", [{ title: "RPC notice", body: "Notification body", route: "session" }])).result;
		    assert.equal(rpcNotificationShow.status, "recorded");
		    assert.equal(rpcNotificationShow.mode, "local-state");
		    assert.equal(rpcNotificationShow.nativeExecuted, false);
		    assert.equal(rpcNotificationShow.event.title, "RPC notice");
		    const rpcNotificationNavigate = (await rpc("rpc-notification-navigate-1", "notification:navigate", [{ route: "session" }])).result;
		    assert.equal(rpcNotificationNavigate.route, "session");
		    assert.equal(rpcNotificationNavigate.event.command, "navigate");

	    assert.equal((await rpc("rpc-workspace-slug-1", "workspaces:checkSlug", ["RPC Workspace"])).result.slug, "rpc-workspace");
	    assert.equal((await rpc("rpc-workspace-remote-1", "workspaces:updateRemote", [{ url: "https://example.invalid/repo.git" }])).result.remote.url, "https://example.invalid/repo.git");

	    const rpcProject = (await rpc("rpc-project-create-1", "projects:create", [{ name: "RPC Project" }])).result;
	    assert.equal((await rpc("rpc-project-one-1", "projects:getOne", [rpcProject.id])).result.name, "RPC Project");
	    assert.equal((await rpc("rpc-project-update-1", "projects:update", [{ id: rpcProject.id, name: "RPC Project Updated" }])).result.name, "RPC Project Updated");
	    assert.equal((await rpc("rpc-project-asset-1", "projects:uploadAsset", [{ projectId: rpcProject.id, fileName: "note.txt", content: "asset body" }])).result.size, 10);
	    assert.equal((await rpc("rpc-project-assets-1", "projects:listAssets", [{ projectId: rpcProject.id }])).result[0].fileName, "note.txt");
	    assert.equal((await rpc("rpc-project-asset-delete-1", "projects:deleteAsset", [{ projectId: rpcProject.id, fileName: "note.txt" }])).result.ok, true);

	    await app.runtime.store.saveAutomationConfig({
	      version: 2,
	      automations: {
	        Notification: [
	          {
	            id: "rpc-auto",
	            name: "RPC Automation",
	            matcher: "rpc-auto",
	            actions: [{ type: "prompt", prompt: "Automation saw $CRAFT_EVENT_DATA" }]
	          }
	        ],
	        SchedulerTick: [
	          {
	            id: "rpc-schedule",
	            matcher: "2026-08-07",
	            actions: [{ type: "prompt", prompt: "Scheduled RPC automation" }]
	          }
	        ]
	      }
	    });
	    assert.equal((await rpc("rpc-automation-get-1", "automations:get")).result.automations.some((automation) => automation.id === "rpc-auto"), true);
	    assert.equal((await rpc("rpc-automation-disable-1", "automations:setEnabled", [{ id: "rpc-auto", enabled: false }])).result.enabled, false);
	    assert.equal((await rpc("rpc-automation-enable-1", "automations:setEnabled", [{ id: "rpc-auto", enabled: true }])).result.enabled, true);
	    const duplicatedAutomation = (await rpc("rpc-automation-duplicate-1", "automations:duplicate", [{ id: "rpc-auto" }])).result.automation;
	    assert.match(duplicatedAutomation.id, /^automation_/);
	    const automationRun = (await rpc("rpc-automation-test-1", "automations:test", [{ event: { type: "Notification", matchValue: "rpc-auto" } }])).result;
	    assert.equal(automationRun.history.eventType, "Notification");
	    assert.equal((await rpc("rpc-automation-history-1", "automations:getHistory")).result.length > 0, true);
	    assert.equal((await rpc("rpc-automation-last-1", "automations:getLastExecuted", [{ eventName: "Notification" }])).result.eventType, "Notification");
	    assert.equal((await rpc("rpc-automation-replay-1", "automations:replay", [{ historyId: automationRun.history.id }])).result.replayedFrom, automationRun.history.id);
	    assert.equal((await rpc("rpc-automation-replay-schedule-1", "automations:replay", [{ now: "2026-08-07T09:30:00.000Z" }])).result.history.eventType, "SchedulerTick");
	    assert.equal((await rpc("rpc-automation-delete-1", "automations:delete", [{ id: duplicatedAutomation.id }])).result.deleted, true);

	    assert.equal((await rpc("rpc-label-create-1", "labels:create", [{ id: "rpc-label", name: "RPC Label" }])).result.labels.some((label) => label.id === "rpc-label"), true);
	    const rpcTask = (await rpc("rpc-task-create-1", "tasks:create", [{ title: "RPC Task", projectId: rpcProject.id, labels: ["rpc-label"] }])).result;
	    assert.equal((await rpc("rpc-task-get-1", "tasks:get", [rpcTask.id])).result.title, "RPC Task");
	    assert.equal((await rpc("rpc-task-list-1", "tasks:list", [{ label: "rpc-label" }])).result.some((task) => task.id === rpcTask.id), true);
	    assert.equal((await rpc("rpc-task-validate-1", "tasks:validate", [{ title: "Valid task" }])).result.ok, true);
	    assert.equal((await rpc("rpc-task-run-1", "tasks:run", [rpcTask.id])).result.status, "running");
	    assert.match((await rpc("rpc-task-output-1", "tasks:getOutput", [rpcTask.id])).result.output, /RPC Task: running/);
	    assert.equal((await rpc("rpc-task-results-1", "tasks:getResults", [rpcTask.id])).result.results[0].type, "task-run");
	    assert.equal((await rpc("rpc-task-stop-1", "tasks:stop", [rpcTask.id])).result.task.runState.status, "stopped");
	    const generatedTasks = (await rpc("rpc-task-generate-1", "tasks:generate", [{ prompt: "- Draft clone audit\n- Verify RPC parity", labels: ["rpc-label"] }])).result;
	    assert.equal(generatedTasks.generated, 2);
	    assert.equal(generatedTasks.tasks[0].title, "Draft clone audit");

	    const reorderedStatuses = (await rpc("rpc-status-reorder-1", "statuses:reorder", [["done", "todo", "cancelled", "backlog", "needs-review"]])).result;
	    assert.equal(reorderedStatuses.statuses[0].id, "done");

	    const rpcView = (await rpc("rpc-view-save-1", "views:save", [{ name: "RPC Tasks", entity: "tasks", filters: { label: "rpc-label" } }])).result;
	    assert.equal((await rpc("rpc-view-list-1", "views:list", [{ entity: "tasks" }])).result.some((view) => view.id === rpcView.id), true);

	    const rpcSource = (await rpc("rpc-source-create-1", "sources:create", [{ slug: "rpc-local", name: "RPC Local", type: "local", root: app.workspace, permissions: { allowedTools: ["echo"] } }])).result;
	    assert.equal(rpcSource.validation.ok, true);
	    assert.equal((await rpc("rpc-source-permissions-1", "sources:getPermissions", ["rpc-local"])).result.allowedTools[0], "echo");
	    assert.equal((await rpc("rpc-source-delete-1", "sources:delete", ["rpc-local"])).result.ok, true);

	    const rpcVaultRoot = path.join(app.workspace, "rpc-vault");
	    const rpcVault = (await rpc("rpc-knowledge-vault-1", "knowledge:initVault", [{ name: "RPC Vault", root: rpcVaultRoot }])).result;
	    assert.equal(rpcVault.name, "RPC Vault");
	    assert.equal((await rpc("rpc-knowledge-enabled-1", "knowledge:setEnabled", [false])).result, false);
	    assert.equal((await rpc("rpc-knowledge-enabled-2", "knowledge:getEnabled")).result, false);
	    assert.equal((await rpc("rpc-knowledge-default-1", "knowledge:getDefaultVault")).result.id, rpcVault.id);
	    const rpcDocument = (await rpc("rpc-knowledge-doc-1", "knowledge:addRawDocument", [{ collectionId: rpcVault.id, title: "RPC Knowledge", content: "# RPC Knowledge\n\nsearchable archive text" }])).result;
	    assert.equal(rpcDocument.title, "RPC Knowledge");
	    assert.equal((await rpc("rpc-knowledge-pages-1", "knowledge:listPages", [{ collectionId: rpcVault.id }])).result.length, 1);
	    assert.equal((await rpc("rpc-knowledge-search-1", "knowledge:searchVault", [{ collectionId: rpcVault.id, query: "archive" }])).result[0].title, "RPC Knowledge");
	    assert.equal((await rpc("rpc-knowledge-graph-1", "knowledge:getKnowledgeGraph")).result.edges[0].type, "contains");
	    assert.equal((await rpc("rpc-knowledge-qmd-1", "knowledge:getQmdStatus")).result.ready, false);
	    assert.equal((await rpc("rpc-knowledge-install-1", "knowledge:installQmd")).result.installed, true);
	    assert.equal((await rpc("rpc-knowledge-qmd-model-1", "knowledge:setQmdEmbedModel", [{ model: "embed-test" }])).result.model, "embed-test");
	    assert.equal((await rpc("rpc-knowledge-embed-1", "knowledge:embedQmdIndex", [{ collectionId: rpcVault.id }])).result.job.status, "completed");
	    assert.equal((await rpc("rpc-knowledge-semantic-search-1", "knowledge:searchVault", [{ collectionId: rpcVault.id, query: "archive text", semantic: true }])).result[0].title, "RPC Knowledge");
	    const wikiSkillInstall = (await rpc("rpc-knowledge-install-wiki-skills-1", "knowledge:installWikiSkills")).result;
	    assert.equal(wikiSkillInstall.installed.some((skill) => skill.slug === "wiki-knowledge-index" && skill.installed), true);
	    assert.equal((await rpc("rpc-skills-get-after-knowledge-1", "skills:get")).result.some((skill) => skill.slug === "wiki-knowledge-index"), true);
	    assert.equal((await rpc("rpc-knowledge-task-settings-1", "knowledge:setTaskSettings", [{ review: true }])).result.review, true);
	    assert.equal((await rpc("rpc-knowledge-schedule-1", "knowledge:setSchedule", [{ enabled: true }])).result.enabled, true);
	    const confirmedTaskPlan = (await rpc("rpc-knowledge-confirm-task-plan-1", "knowledge:confirmTaskPlan", [{ taskId: "task-plan-rpc", decision: "accepted" }])).result;
	    assert.equal(confirmedTaskPlan.accepted, true);
	    assert.equal(confirmedTaskPlan.event.kind, "task-plan");
	    assert.equal((await rpc("rpc-knowledge-task-reports-1", "knowledge:listTaskReports")).result.some((report) => report.eventId === confirmedTaskPlan.event.id), true);
	    assert.equal((await rpc("rpc-knowledge-delete-1", "knowledge:deleteDocuments", [{ collectionId: rpcVault.id, ids: [rpcDocument.id] }])).result.deleted, 1);

	    assert.equal((await rpc("rpc-messaging-config-1", "messaging:updateConfig", [{ enabled: true }])).result.enabled, true);
	    assert.equal((await rpc("rpc-messaging-telegram-1", "messaging:saveTelegram", [{ botToken: "secret-token" }])).result.hasBotToken, true);
	    assert.equal((await rpc("rpc-messaging-telegram-test-1", "messaging:testTelegram")).result.status, "configured");
	    assert.equal((await rpc("rpc-messaging-lark-1", "messaging:saveLark", [{ appId: "app", appSecret: "secret" }])).result.hasAppSecret, true);
	    const larkMessagingStatus = (await rpc("rpc-messaging-status-1", "messaging:platformStatus", ["lark"])).result;
	    assert.equal(larkMessagingStatus.configured, true);
	    assert.equal(larkMessagingStatus.worker.running, true);
	    const whatsappConnect = (await rpc("rpc-messaging-wa-start-1", "messaging:wa:startConnect", [{ phone: "+15551234567" }])).result;
	    assert.equal(whatsappConnect.status, "awaiting_phone");
	    const whatsappPhone = (await rpc("rpc-messaging-wa-phone-1", "messaging:wa:submitPhone", [{ connectId: whatsappConnect.connect.id, phone: "+15551234567" }])).result;
	    assert.equal(whatsappPhone.status, "phone_submitted");
	    assert.equal((await rpc("rpc-messaging-wa-status-1", "messaging:platformStatus", ["whatsapp"])).result.worker.running, true);
	    assert.equal((await rpc("rpc-messaging-wa-ui-1", "messaging:wa:uiEvent", [{ type: "overlayOpened" }])).result.event.type, "overlayOpened");
	    assert.equal((await rpc("rpc-messaging-access-mode-1", "messaging:access:setMode", [{ mode: "owners" }])).result, "owners");
	    const pendingAccess = (await rpc("rpc-messaging-pending-1", "messaging:pendingChanged", [{ id: "pending-wa-1", platform: "whatsapp", chatId: "wa-chat-1", label: "Phone" }])).result;
	    assert.equal(pendingAccess.pending[0].platform, "whatsapp");
	    assert.equal((await rpc("rpc-messaging-access-pending-1", "messaging:access:getPending")).result.length, 1);
	    assert.equal((await rpc("rpc-messaging-access-allow-1", "messaging:access:allowPending", [{ id: "pending-wa-1" }])).result.access.owners[0].platform, "whatsapp");
	    assert.equal((await rpc("rpc-messaging-access-owners-1", "messaging:access:getOwners")).result[0].platform, "whatsapp");
	    const bindingCode = (await rpc("rpc-messaging-code-1", "messaging:generateCode", [{ platform: "telegram", code: "ABCD1234" }])).result;
	    assert.equal(bindingCode.code, "ABCD1234");
	    assert.equal((await rpc("rpc-messaging-bindings-1", "messaging:getBindings")).result.length, 0);
	    const bindingChanged = (await rpc("rpc-messaging-binding-changed-1", "messaging:bindingChanged", [{ platform: "telegram", code: "ABCD1234", chatId: "chat-rpc" }])).result;
	    assert.equal(bindingChanged.binding.status, "bound");
	    assert.equal((await rpc("rpc-messaging-binding-access-1", "messaging:access:setBindingAccess", [{ id: bindingChanged.binding.id, access: "owners" }])).result.binding.access, "owners");
	    assert.equal((await rpc("rpc-messaging-bindings-2", "messaging:getBindings")).result[0].chatId, "chat-rpc");
	    assert.equal((await rpc("rpc-messaging-super-code-1", "messaging:generateSupergroupCode", [{ platform: "telegram", code: "GROUP123" }])).result.kind, "supergroup");
	    assert.equal((await rpc("rpc-messaging-super-1", "messaging:getSupergroup")).result.code, "GROUP123");
	    assert.equal((await rpc("rpc-messaging-unbind-super-1", "messaging:unbindSupergroup")).result, null);
	    const disconnectedMessaging = (await rpc("rpc-messaging-disconnect-1", "messaging:disconnect", ["telegram"])).result;
	    assert.equal(disconnectedMessaging.config.platforms.telegram.enabled, false);
		    assert.equal(disconnectedMessaging.gateway.workers.telegram.running, false);
		    assert.equal((await rpc("rpc-chatgpt-auth-1", "chatgpt:getAuthStatus")).result.status, "signed_out");
		    const chatgptOAuth = (await rpc("rpc-chatgpt-oauth-1", "chatgpt:startOAuth")).result;
		    assert.equal(chatgptOAuth.status, "pending");
		    assert.equal(chatgptOAuth.mode, "local-state");
		    assert.match(chatgptOAuth.authorizationUrl, /^https:\/\/chatgpt\.com\/oauth\/authorize/);
		    assert.equal("reason" in chatgptOAuth, false);
		    assert.equal((await rpc("rpc-chatgpt-auth-2", "chatgpt:getAuthStatus")).result.pending.state, chatgptOAuth.state);
		    assert.equal((await rpc("rpc-chatgpt-cancel-1", "chatgpt:cancelOAuth")).result.status, "cancelled");
	    const copilotDevice = (await rpc("rpc-copilot-device-1", "copilot:deviceCode", [{ code: "C0P1L0T", userCode: "COPI-LOT" }])).result;
	    assert.equal(copilotDevice.status, "pending");
	    assert.equal(copilotDevice.userCode, "COPI-LOT");
	    assert.equal(copilotDevice.verificationUri, "https://github.com/login/device");
	    assert.equal((await rpc("rpc-copilot-auth-1", "copilot:getAuthStatus")).result.pending.deviceCode, "C0P1L0T");
	    assert.equal((await rpc("rpc-xai-logout-1", "xai:logout")).result.status, "signed_out");

	    const browserOne = `data:text/html,${encodeURIComponent("<title>Pane One</title><main>First browser snapshot body</main>")}`;
	    const browserTwo = `data:text/html,${encodeURIComponent("<title>Pane Two</title><main>Second browser snapshot body</main>")}`;
	    const browserPane = (await rpc("rpc-browser-pane-create-1", "browser-pane:create", [{ url: browserOne, snapshot: true }])).result;
	    assert.match(browserPane.id, /^browser_pane_/);
	    assert.equal(browserPane.title, "Pane One");
	    assert.match(browserPane.snapshot.excerpt, /First browser snapshot body/);
	    assert.equal((await rpc("rpc-browser-pane-list-1", "browser-pane:list")).result.activePaneId, browserPane.id);
	    const navigatedPane = (await rpc("rpc-browser-pane-navigate-1", "browser-pane:navigate", [{ paneId: browserPane.id, url: browserTwo, snapshot: true }])).result;
	    assert.equal(navigatedPane.canGoBack, true);
	    assert.equal(navigatedPane.title, "Pane Two");
	    assert.equal((await rpc("rpc-browser-pane-back-1", "browser-pane:go-back", [browserPane.id])).result.url, browserOne);
	    assert.equal((await rpc("rpc-browser-pane-forward-1", "browser-pane:go-forward", [browserPane.id])).result.url, browserTwo);
	    assert.equal((await rpc("rpc-browser-pane-focus-1", "browser-pane:focus", [browserPane.id])).result.focused, true);
	    const reloadedPane = (await rpc("rpc-browser-pane-reload-1", "browser-pane:reload", [{ paneId: browserPane.id, snapshot: true }])).result;
	    assert.equal(reloadedPane.loading, false);
	    assert.equal(reloadedPane.snapshotStatus, "loaded");
	    assert.equal((await rpc("rpc-browser-pane-stop-1", "browser-pane:stop", [browserPane.id])).result.loading, false);
	    assert.equal(typeof (await rpc("rpc-browser-pane-interacted-1", "browser-pane:interacted", [browserPane.id])).result.lastInteractedAt, "string");
	    const emptyPane = (await rpc("rpc-browser-empty-launch-1", "browser-empty-state:launch", [{ url: "about:blank" }])).result;
	    assert.equal(emptyPane.url, "about:blank");
	    assert.equal((await rpc("rpc-browser-pane-destroy-1", "browser-pane:destroy", [browserPane.id])).result.removed.id, browserPane.id);
	    const computerUseInitial = (await rpc("rpc-computer-use-status-1", "computerUse:getStatus")).result;
	    assert.equal(computerUseInitial.permission, "prompt");
	    assert.equal(computerUseInitial.status, "not_requested");
	    const computerUseRequested = (await rpc("rpc-computer-use-request-1", "computerUse:requestPermissions")).result;
	    assert.equal(computerUseRequested.requested, true);
	    assert.equal(computerUseRequested.status, "requested");
	    const computerUseOpened = (await rpc("rpc-computer-use-open-1", "computerUse:openPermissionPane")).result;
	    assert.equal(computerUseOpened.opened, true);
	    assert.equal(computerUseOpened.status, "opened");
	    assert.equal((await rpc("rpc-computer-use-grant-1", "computerUse:requestPermissions", [{ permission: "granted" }])).result.status, "ready");
	    const remoteConnected = (await rpc("rpc-remote-test-1", "remote:testConnection", [{ url: `${baseUrl}/health` }])).result;
	    assert.equal(remoteConnected.status, "connected");
	    assert.equal(remoteConnected.statusCode, 200);
	    assert.equal(remoteConnected.available, true);
	    const remoteFailed = (await rpc("rpc-remote-test-2", "remote:testConnection", [{ url: `${baseUrl}/missing-remote-target` }])).result;
	    assert.equal(remoteFailed.status, "http_error");
	    assert.equal(remoteFailed.statusCode, 404);
	    assert.equal((await rpc("rpc-rtk-set-1", "rtk:setEnabled", [true])).result, true);
	    const rtkEnabled = (await rpc("rpc-rtk-status-1", "rtk:getStatus")).result;
	    assert.equal(rtkEnabled.enabled, true);
	    assert.equal(rtkEnabled.status, "local");
	    assert.equal(typeof rtkEnabled.enabledAt, "string");
	    assert.equal((await rpc("rpc-rtk-gain-1", "rtk:getGain")).result, 1);
	    assert.equal((await rpc("rpc-rtk-disable-1", "rtk:setEnabled", [false])).result, false);
	    const rtkDisabled = (await rpc("rpc-rtk-status-2", "rtk:getStatus")).result;
	    assert.equal(rtkDisabled.status, "disabled");
	    assert.equal(typeof rtkDisabled.disabledAt, "string");
	    assert.equal((await rpc("rpc-update-info-1", "update:getInfo")).result.status, "current");
	    const checkedUpdate = (await rpc("rpc-update-check-1", "update:check", [{ latestVersion: "0.11.13", totalBytes: 2048 }])).result;
	    assert.equal(checkedUpdate.available, true);
	    assert.equal(checkedUpdate.status, "available");
	    const downloadedUpdate = (await rpc("rpc-update-download-1", "update:download", [{ totalBytes: 2048, artifactPath: ".peng/update/0.11.13.app.tar" }])).result;
	    assert.equal(downloadedUpdate.status, "downloaded");
	    assert.equal(downloadedUpdate.downloadProgress.percent, 100);
	    assert.equal((await rpc("rpc-update-progress-1", "update:downloadProgress")).result.status, "completed");
	    assert.equal((await rpc("rpc-update-dismiss-1", "update:dismiss", [{ version: "0.11.12" }])).result.version, "0.11.12");
	    assert.equal((await rpc("rpc-update-dismissed-1", "update:getDismissed")).result.version, "0.11.12");
	    const installedUpdate = (await rpc("rpc-update-install-1", "update:install")).result;
	    assert.equal(installedUpdate.ok, true);
	    assert.equal(installedUpdate.status, "installed");
	    assert.equal(installedUpdate.currentVersion, "0.11.13");
	    assert.equal((await rpc("rpc-pilot-status-1", "pilot:getStatus")).result.status, "unavailable");
	    const installedPilot = (await rpc("rpc-pilot-install-1", "pilot:install", [{ version: "local-test" }])).result;
	    assert.equal(installedPilot.installed, true);
	    assert.equal(installedPilot.status, "stopped");
	    assert.equal(installedPilot.version, "local-test");
	    assert.equal((await rpc("rpc-pilot-start-1", "pilot:start")).result.status, "running");
	    assert.equal((await rpc("rpc-pilot-stop-1", "pilot:stop")).result.status, "stopped");
	    const openedPilot = (await rpc("rpc-pilot-open-1", "pilot:openDashboard", [{ route: "runs" }])).result;
	    assert.equal(openedPilot.opened, true);
	    assert.equal(openedPilot.dashboard.route, "runs");

	    assert.equal((await rpc("rpc-label-delete-1", "labels:delete", ["rpc-label"])).result.migrated.tasks, 1);
	    assert.equal((await rpc("rpc-project-delete-1", "projects:delete", [rpcProject.id])).result.detached.tasks, 1);

	    const rpcMissing = await rpc("rpc-missing-1", "unknown:channel");
    assert.equal(rpcMissing.error.code, "CHANNEL_NOT_FOUND");
  } finally {
    socket.close();
    await app.close();
  }
});

test("starts through the craft-server compatible entrypoint", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-craft-server-test-"));
  const lines = [];
  const { app, info } = await startHeadlessServer({
    args: ["--port", "0", "--workspace", workspace, "--json"],
    env: {},
    cwd: workspace,
    stdout: (line) => lines.push(line)
  });
  try {
    assert.equal(CRAFT_SERVER_MANIFEST.packageName, "@craft-agent/server");
    assert.equal(parseServerOptions(["--host", "0.0.0.0", "--port", "4821"], {}, workspace).port, 4821);
    assert.equal(info.name, "craft-server");
    assert.equal(info.workspace, workspace);
    assert.deepEqual(await getJson(`${info.url}/health`), { ok: true });
    assert.equal(JSON.parse(lines[0]).protocolVersion, 1);
  } finally {
    await app.close();
  }
});

test("plans Bun compile packaging for craft-server", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-craft-server-build-test-"));
  const options = parseBuildOptions(["--outfile", "dist/server-bin", "--target", "bun-darwin-arm64", "--verify"], workspace, { BUN_BINARY: "bun-test" });
  const lines = [];
  const result = await buildCraftServer({
    args: ["--outfile", "dist/server-bin", "--target", "bun-darwin-arm64", "--dry-run"],
    cwd: workspace,
    env: { BUN_BINARY: "bun-test" },
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line)
  });

  assert.equal(options.bun, "bun-test");
  assert.equal(options.verify, true);
  assert.equal(options.outfile, path.join(workspace, "dist", "server-bin"));
  assert.deepEqual(craftServerBuildCommand(options), [
    "bun-test",
    "build",
    "--compile",
    "--target",
    "bun-darwin-arm64",
    path.join(workspace, "bin", "craft-server.mjs"),
    "--outfile",
    path.join(workspace, "dist", "server-bin")
  ]);
  assert.equal(result.skipped, true);
  assert.match(lines[0], /bun-test build --compile --target bun-darwin-arm64/);
});

test("captures OAuth callback codes", async () => {
  const callback = await createOAuthCallbackServer({ expectedState: "state-a", timeoutMs: 1000 });
  try {
    const response = await fetch(`${callback.redirectUri}?code=auth-code&state=state-a`);
    assert.equal(response.ok, true);
    const result = await callback.waitForCallback;

    assert.equal(result.code, "auth-code");
    assert.equal(result.state, "state-a");
    assert.match(result.url, /code=auth-code/);
  } finally {
    await callback.close();
  }
});

async function testServer() {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-server-test-"));
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider: new DeterministicProvider(),
    tools: createDefaultTools({ workspace })
  });
  const app = createServer({ runtime, workspace });
  const address = await app.listen({ port: 0 });
  app.workspace = workspace;
  app.runtime = runtime;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function getText(url) {
  const response = await fetch(url);
  if (!response.ok) assert.fail(await response.text());
  return response.text();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function deleteJson(url, body = {}) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function waitForEvent(url, eventName) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.ok, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value } = await reader.read();
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (!event.includes(`event: ${eventName}`)) continue;
        const dataLine = event.split("\n").find((line) => line.startsWith("data: "));
        return JSON.parse(dataLine.slice("data: ".length));
      }
    }
  } finally {
    controller.abort();
  }
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

function gitExec(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function connectWebSocket(baseUrl) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
  const messages = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex === -1) {
      messages.push(message);
    } else {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const nextMessage = (predicate = () => true, timeoutMs = 1000) => {
    const index = messages.findIndex(predicate);
    if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
        reject(new Error("Timed out waiting for WebSocket message."));
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
  };

  return {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    nextMessage,
    waitForType(type) {
      return nextMessage((message) => message.type === type);
    },
    close() {
      socket.close();
    }
  };
}
