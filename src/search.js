export async function searchWorkspace({ store, query, limit = 50 }) {
  const normalized = String(query ?? "").trim().toLowerCase();
  if (!normalized) return [];

  const [sessions, projects, tasks, threads, knowledgeDocuments] = await Promise.all([
    store.listSessions(),
    store.listProjects(),
    store.listTasks(),
    store.listThreads(),
    typeof store.listKnowledgeDocuments === "function" ? store.listKnowledgeDocuments() : []
  ]);

  return [
    ...sessions.map((item) => result("session", item.id, item.name, item)),
    ...projects.map((item) => result("project", item.id, item.name, item)),
    ...tasks.map((item) => result("task", item.id, item.title, item)),
    ...threads.map((item) => result("thread", item.id, item.title, item)),
    ...knowledgeDocuments.map((item) => result("knowledge", item.id, item.title, item))
  ]
    .filter((item) => JSON.stringify(item.data).toLowerCase().includes(normalized))
    .slice(0, limit);
}

function result(type, id, title, data) {
  return { type, id, title, data };
}
