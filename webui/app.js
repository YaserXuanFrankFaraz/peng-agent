const state = {
  view: "run",
  events: [],
  selectedTerminalId: null
};

const titles = {
  run: ["Run", "Create an agent run and inspect tool output."],
  sessions: ["Sessions", "Track workspace sessions, statuses, and labels."],
  projects: ["Projects", "Organize workspaces with projects and saved views."],
  tasks: ["Tasks", "Track actionable work and search workspace records."],
  threads: ["Threads", "Inspect persisted agent thread transcripts."],
  memory: ["Memory", "Inspect citable user memory records and context blocks."],
  knowledge: ["Knowledge", "Manage indexed vaults, literal search, and index reports."],
  terminal: ["Terminal", "Review command history and command resource mappings."],
  extensions: ["Extensions", "Review skills, workflows, sources, and automations."],
  events: ["Events", "Watch live server events from the SSE stream."]
};

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
document.querySelector("#refresh").addEventListener("click", refresh);
document.querySelector("#run-form").addEventListener("submit", runTask);
document.querySelector("#search-button").addEventListener("click", searchRecords);
document.querySelector("#remember-memory").addEventListener("click", rememberMemory);
document.querySelector("#render-memory-context").addEventListener("click", renderMemoryContextBlock);
document.querySelector("#create-knowledge").addEventListener("click", createKnowledgeCollection);
document.querySelector("#search-knowledge").addEventListener("click", searchKnowledge);
document.querySelector("#save-credential").addEventListener("click", saveCredential);
document.querySelector("#record-terminal").addEventListener("click", recordTerminal);
document.querySelector("#start-terminal").addEventListener("click", startTerminal);
document.querySelector("#run-terminal").addEventListener("click", runTerminal);
document.querySelector("#write-terminal").addEventListener("click", writeTerminalInput);
document.querySelector("#resize-terminal").addEventListener("click", resizeTerminal);
document.querySelector("#cancel-terminal").addEventListener("click", cancelTerminal);
document.querySelector("#resolve-icon").addEventListener("click", resolveIcon);

connectEvents();
refresh();

function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((panel) => panel.classList.toggle("active", panel.id === view));
  document.querySelector("#view-title").textContent = titles[view][0];
  document.querySelector("#view-subtitle").textContent = titles[view][1];
}

async function refresh() {
  const [workspace, provider, sessions, statuses, projects, tasks, views, threads, protocolEvents, queuedMessages, runControls, memories, knowledgeCollections, knowledgeReport, terminal, skills, workflows, sources, credentials, automations] = await Promise.all([
    api("/api/workspace"),
    api("/api/provider"),
    api("/api/sessions"),
    api("/api/statuses"),
    api("/api/projects"),
    api("/api/tasks"),
    api("/api/views"),
    api("/api/threads"),
    api("/api/protocol/events"),
    api("/api/queued-messages"),
    api("/api/run-control"),
    api("/api/memory"),
    api("/api/knowledge/collections"),
    api("/api/knowledge/report"),
    api("/api/terminal/history"),
    api("/api/skills"),
    api("/api/workflows"),
    api("/api/sources"),
    api("/api/credentials"),
    api("/api/automations/history")
  ]);

  document.querySelector("#workspace").textContent = workspace.name || workspace.id;
  renderProvider(provider);
  renderSessions(sessions);
  renderStatuses(statuses.statuses || []);
  renderProjects(projects);
  renderTasks(tasks);
  renderViews(views);
  renderThreads(threads);
  renderProtocol(protocolEvents);
  renderQueue(queuedMessages);
  renderRunControl(runControls);
  renderMemories(memories);
  renderKnowledgeCollections(knowledgeCollections);
  renderKnowledgeReport(knowledgeReport);
  renderTerminal(terminal);
  renderList("#skills-list", skills, (skill) => [skill.metadata?.name || skill.slug, skill.valid ? "valid" : "invalid", skill.metadata?.description || skill.path]);
  renderList("#workflows-list", workflows, (workflow) => [workflow.title, workflow.runnable ? "runnable" : "document", workflow.summary || workflow.path]);
  renderSources(sources);
  renderList("#credentials-list", credentials, (credential) => [
    credential.sourceSlug,
    credential.mode,
    `${credential.hasSecret ? "saved" : "empty"} · ${credential.expired ? "expired" : "valid"}`
  ]);
  renderList("#automations-list", automations, (item) => [item.eventType, `${item.resultCount} result(s)`, item.createdAt]);
}

async function runTask(event) {
  event.preventDefault();
  const prompt = document.querySelector("#prompt").value.trim();
  if (!prompt) return;
  const output = document.querySelector("#run-output");
  output.textContent = "Running...";
  const result = await api("/api/run", {
    method: "POST",
    body: { prompt }
  });
  output.textContent = result.output;
  await refresh();
}

function renderProvider(provider) {
  document.querySelector("#provider").innerHTML = fields({
    Name: provider.displayName || provider.name,
    Profile: provider.profile || provider.name,
    Model: provider.model || "local",
    URL: provider.baseUrl || "none"
  });
}

function renderSessions(sessions) {
  renderList("#sessions-list", sessions, (session) => [
    session.name,
    session.statusId,
    `${session.permissionMode} · ${session.labels?.join(", ") || "no labels"}`
  ]);
}

function renderStatuses(statuses) {
  renderList("#statuses-list", statuses.sort((a, b) => a.order - b.order), (status) => [
    status.label,
    status.category,
    status.isFixed ? "fixed" : status.isDefault ? "default" : "custom"
  ]);
}

function renderProjects(projects) {
  renderList("#projects-list", projects, (project) => [
    project.name,
    project.id,
    project.root
  ]);
}

function renderTasks(tasks) {
  renderList("#tasks-list", tasks, (task) => [
    task.title,
    task.statusId,
    `${task.projectId || "no project"} · ${task.labels?.join(", ") || "no labels"}`
  ]);
}

function renderViews(views) {
  renderList("#views-list", views, (view) => [
    view.name,
    view.entity,
    JSON.stringify(view.filters || {})
  ]);
}

async function searchRecords() {
  const query = document.querySelector("#search-input").value.trim();
  if (!query) return;
  const results = await api(`/api/search?q=${encodeURIComponent(query)}`);
  renderList("#search-list", results, (result) => [
    result.title,
    result.type,
    result.id
  ]);
}

function renderThreads(threads) {
  renderList("#threads-list", threads, (thread) => [
    thread.title,
    thread.status,
    `${thread.events?.length || 0} event(s)`
  ]);
}

function renderProtocol(events) {
  renderList("#protocol-list", events.slice(-50).reverse(), (event) => [
    event.type,
    event.step === null || event.step === undefined ? "run" : `step ${event.step}`,
    `${event.threadId || "no thread"} · ${event.createdAt}`
  ]);
}

function renderQueue(messages) {
  renderList("#queue-list", messages.slice(-50).reverse(), (message) => [
    message.content,
    message.status,
    `${message.threadId} · ${message.updatedAt}`
  ]);
}

function renderRunControl(controls) {
  renderList("#run-control-list", controls, (control) => [
    control.threadId,
    control.status,
    `${control.heartbeatAt || "no heartbeat"} · ${control.reason || "no reason"}`
  ]);
}

async function rememberMemory() {
  const text = document.querySelector("#memory-text").value.trim();
  if (!text) return;
  await api("/api/memory", {
    method: "POST",
    body: { text }
  });
  document.querySelector("#memory-text").value = "";
  await refresh();
}

async function renderMemoryContextBlock() {
  const query = document.querySelector("#memory-query").value.trim();
  const result = await api("/api/memory/context", {
    method: "POST",
    body: { query }
  });
  document.querySelector("#memory-context").textContent = result.context || "No matching memory context.";
}

function renderMemories(memories) {
  renderList("#memory-list", memories, (memory) => [
    memory.text,
    memory.source,
    `[memory:${memory.id}] · ${(memory.tags || []).join(", ") || "no tags"}`
  ]);
}

async function createKnowledgeCollection() {
  const name = document.querySelector("#knowledge-name").value.trim();
  const root = document.querySelector("#knowledge-root").value.trim();
  if (!name || !root) return;
  await api("/api/knowledge/collections", {
    method: "POST",
    body: { name, root }
  });
  document.querySelector("#knowledge-name").value = "";
  document.querySelector("#knowledge-root").value = "";
  await refresh();
}

async function indexKnowledge(collectionId) {
  const report = await api("/api/knowledge/index", {
    method: "POST",
    body: { collectionId }
  });
  renderKnowledgeReport(report);
  await refresh();
}

async function searchKnowledge() {
  const query = document.querySelector("#knowledge-query").value.trim();
  if (!query) return;
  const results = await api(`/api/knowledge/search?q=${encodeURIComponent(query)}`);
  renderList("#knowledge-search-list", results, (result) => [
    result.title,
    String(result.score),
    `${result.path} · ${result.excerpt}`
  ]);
}

function renderKnowledgeCollections(collections) {
  const root = document.querySelector("#knowledge-collections-list");
  if (!collections || collections.length === 0) {
    root.innerHTML = `<div class="item"><p class="meta">No items found.</p></div>`;
    return;
  }
  root.innerHTML = collections.map((collection) => `<div class="item">
    <div class="item-title"><span>${escapeHtml(collection.name)}</span><button class="mini-button" data-index-knowledge="${escapeHtml(collection.id)}">Index</button></div>
    <p class="meta">${escapeHtml(collection.root)} · ${collection.semanticEnabled ? "semantic requested" : "literal"}</p>
  </div>`).join("");
  root.querySelectorAll("[data-index-knowledge]").forEach((button) => {
    button.addEventListener("click", () => indexKnowledge(button.dataset.indexKnowledge));
  });
}

function renderKnowledgeReport(report) {
  document.querySelector("#knowledge-report").textContent = JSON.stringify(report, null, 2);
}

function renderSources(sources) {
  const root = document.querySelector("#sources-list");
  if (!sources || sources.length === 0) {
    root.innerHTML = `<div class="item"><p class="meta">No items found.</p></div>`;
    return;
  }
  root.innerHTML = sources.map((source) => `<div class="item">
    <div class="item-title"><span>${escapeHtml(source.name)}</span><button class="mini-button" data-test-source="${escapeHtml(source.slug)}">Test</button></div>
    <p class="meta">${escapeHtml(source.type)} · ${escapeHtml(source.connectionStatus || "untested")} · ${escapeHtml(source.validation?.ok ? source.provider : source.validation?.issues?.join(", "))}</p>
  </div>`).join("");
  root.querySelectorAll("[data-test-source]").forEach((button) => {
    button.addEventListener("click", () => testSource(button.dataset.testSource));
  });
}

async function testSource(sourceSlug) {
  await api(`/api/sources/${encodeURIComponent(sourceSlug)}/test`, {
    method: "POST",
    body: {}
  });
  await refresh();
}

async function saveCredential() {
  const sourceSlug = document.querySelector("#credential-source").value.trim();
  const mode = document.querySelector("#credential-mode").value.trim();
  const value = document.querySelector("#credential-value").value.trim();
  if (!sourceSlug || !mode || !value) return;
  await api("/api/credentials", {
    method: "POST",
    body: { sourceSlug, mode, value }
  });
  document.querySelector("#credential-value").value = "";
  await refresh();
}

async function recordTerminal() {
  const command = document.querySelector("#terminal-command").value.trim();
  if (!command) return;
  const exitValue = document.querySelector("#terminal-exit").value.trim();
  await api("/api/terminal/history", {
    method: "POST",
    body: {
      command,
      exitCode: exitValue === "" ? null : Number(exitValue)
    }
  });
  document.querySelector("#terminal-command").value = "";
  document.querySelector("#terminal-exit").value = "";
  await refresh();
}

async function startTerminal() {
  const command = document.querySelector("#terminal-command").value.trim();
  if (!command) return;
  const record = await api("/api/terminal/start", {
    method: "POST",
    body: {
      command,
      dimensions: terminalDimensions()
    }
  });
  state.selectedTerminalId = record.id;
  await refresh();
  await renderTerminalReplay(record.id);
}

async function runTerminal() {
  const command = document.querySelector("#terminal-command").value.trim();
  if (!command) return;
  const record = await api("/api/terminal/run", {
    method: "POST",
    body: {
      command,
      dimensions: terminalDimensions()
    }
  });
  state.selectedTerminalId = record.id;
  await refresh();
  await renderTerminalReplay(record.id);
}

async function writeTerminalInput() {
  if (!state.selectedTerminalId) return;
  const data = document.querySelector("#terminal-input").value;
  if (!data) return;
  await api(`/api/terminal/history/${encodeURIComponent(state.selectedTerminalId)}/input`, {
    method: "POST",
    body: { data: data.endsWith("\n") ? data : `${data}\n` }
  });
  document.querySelector("#terminal-input").value = "";
  await refresh();
  await renderTerminalReplay(state.selectedTerminalId);
}

async function resizeTerminal() {
  if (!state.selectedTerminalId) return;
  await api(`/api/terminal/history/${encodeURIComponent(state.selectedTerminalId)}/resize`, {
    method: "POST",
    body: terminalDimensions()
  });
  await refresh();
  await renderTerminalReplay(state.selectedTerminalId);
}

async function cancelTerminal() {
  if (!state.selectedTerminalId) return;
  await api(`/api/terminal/history/${encodeURIComponent(state.selectedTerminalId)}/cancel`, {
    method: "POST",
    body: {}
  });
  await refresh();
  await renderTerminalReplay(state.selectedTerminalId);
}

async function resolveIcon() {
  const command = document.querySelector("#tool-icon-command").value.trim();
  if (!command) return;
  const result = await api(`/api/tool-icons?command=${encodeURIComponent(command)}`);
  renderList("#tool-icon-result", [result], (item) => [
    item.tool?.displayName || item.command || "Unknown",
    item.matched ? "matched" : "none",
    item.tool ? `${item.tool.icon} · ${item.tool.commands.join(", ")}` : "No icon mapping"
  ]);
}

function renderTerminal(history) {
  const root = document.querySelector("#terminal-list");
  if (!history || history.length === 0) {
    root.innerHTML = `<div class="item"><p class="meta">No items found.</p></div>`;
    document.querySelector("#terminal-replay").textContent = "No terminal records.";
    return;
  }
  if (!state.selectedTerminalId || !history.some((record) => record.id === state.selectedTerminalId)) {
    state.selectedTerminalId = history[0].id;
  }
  root.innerHTML = history.map((record) => `<div class="item ${record.id === state.selectedTerminalId ? "selected" : ""}">
    <div class="item-title">
      <span>${escapeHtml(record.command || "Untitled")}</span>
      <span class="pill">${escapeHtml(record.status || (record.exitCode === null ? "running" : String(record.exitCode)))}</span>
    </div>
    <p class="meta">${escapeHtml(terminalDetail(record))}</p>
    <div class="item-actions">
      <button class="mini-button" data-select-terminal="${escapeHtml(record.id)}">Replay</button>
      ${record.status === "running" ? `<button class="mini-button" data-cancel-terminal="${escapeHtml(record.id)}">Cancel</button>` : ""}
    </div>
  </div>`).join("");
  root.querySelectorAll("[data-select-terminal]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedTerminalId = button.dataset.selectTerminal;
      renderTerminal(history);
      await renderTerminalReplay(state.selectedTerminalId);
    });
  });
  root.querySelectorAll("[data-cancel-terminal]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedTerminalId = button.dataset.cancelTerminal;
      await cancelTerminal();
    });
  });
  renderTerminalReplay(state.selectedTerminalId);
}

async function renderTerminalReplay(recordId) {
  if (!recordId) return;
  const replay = await api(`/api/terminal/history/${encodeURIComponent(recordId)}/replay`);
  const lines = replay.frames.map((frame) => {
    if (frame.type === "output") return frame.data;
    if (frame.type === "input") return `$ ${frame.data}`;
    if (frame.type === "resize") return `\n[resize ${frame.data}]\n`;
    if (frame.type === "exit") return `\n[exit ${frame.data}]\n`;
    return `\n[${frame.type} ${frame.data || ""}]\n`;
  }).join("");
  document.querySelector("#terminal-replay").textContent = lines || replay.output || "No terminal output.";
}

function terminalDimensions() {
  return {
    cols: Number(document.querySelector("#terminal-cols").value || 80),
    rows: Number(document.querySelector("#terminal-rows").value || 24)
  };
}

function terminalDetail(record) {
  const dimensions = record.dimensions ? `${record.dimensions.cols}x${record.dimensions.rows}` : "no size";
  const eventCount = `${record.events?.length || 0} event(s)`;
  return `${record.cwd || "unknown cwd"} · ${dimensions} · ${eventCount} · ${record.startedAt}`;
}

function renderList(selector, items, mapItem) {
  const root = document.querySelector(selector);
  if (!items || items.length === 0) {
    root.innerHTML = `<div class="item"><p class="meta">No items found.</p></div>`;
    return;
  }
  root.innerHTML = items.map((item) => {
    const [title, pill, detail] = mapItem(item);
    return `<div class="item">
      <div class="item-title"><span>${escapeHtml(title || "Untitled")}</span><span class="pill">${escapeHtml(pill || "")}</span></div>
      <p class="meta">${escapeHtml(detail || "")}</p>
    </div>`;
  }).join("");
}

function connectEvents() {
  const stream = new EventSource("/events");
  for (const name of ["ready", "thread.completed", "thread.message.queued", "thread.queue.replayed", "thread.stop.requested", "thread.resumed", "protocol.event", "run.started", "run.step.started", "run.heartbeat", "run.stop_requested", "run.stopping", "run.stopped", "run.resume_requested", "run.watchdog.stale", "assistant.delta", "assistant.message", "tool.delta", "tool.repaired", "provider.diagnostic", "tool.started", "tool.completed", "run.max_steps", "run.completed", "run.failed", "message.queued", "message.acknowledged", "message.replay.started", "message.replay.completed", "message.replay.failed", "session.created", "session.status.changed", "session.label.added", "project.created", "task.created", "task.status.changed", "memory.recorded", "knowledge.collection.created", "knowledge.indexed", "credential.saved", "source.tested", "terminal.recorded", "terminal.event", "terminal.input", "terminal.resize", "terminal.finished", "terminal.cancelled", "automation.ran"]) {
    stream.addEventListener(name, (event) => {
      state.events.push({ name, data: JSON.parse(event.data), at: new Date().toISOString() });
      renderEvents();
      if (name !== "ready") refresh();
    });
  }
}

function renderEvents() {
  const root = document.querySelector("#events-list");
  root.innerHTML = state.events.slice(-50).map((event) => `<div class="item">
    <div class="item-title"><span>${escapeHtml(event.name)}</span><span class="pill">${escapeHtml(event.at.slice(11, 19))}</span></div>
    <p class="meta">${escapeHtml(JSON.stringify(event.data))}</p>
  </div>`).join("");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}

function fields(values) {
  return Object.entries(values).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}
