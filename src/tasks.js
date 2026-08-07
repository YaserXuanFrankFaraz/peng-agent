import { createId } from "./id.js";
import { normalizeStatusId, DEFAULT_STATUS_CONFIG } from "./statuses.js";

export function createTask({
  workspaceId,
  projectId = null,
  sessionId = null,
  title,
  description = "",
  statusId,
  labels = [],
  assignee = null,
  dueDate = null,
  statusConfig = DEFAULT_STATUS_CONFIG
}) {
  const now = new Date().toISOString();
  return {
    id: createId("task"),
    workspaceId,
    projectId,
    sessionId,
    title: requiredTitle(title),
    description,
    statusId: normalizeStatusId(statusConfig, statusId),
    labels: Array.isArray(labels) ? labels : [],
    assignee,
    dueDate,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

export function updateTaskStatus(task, statusId, statusConfig = DEFAULT_STATUS_CONFIG) {
  const nextStatusId = normalizeStatusId(statusConfig, statusId);
  const now = new Date().toISOString();
  const isClosed = statusConfig.statuses.find((status) => status.id === nextStatusId)?.category === "closed";
  return {
    ...task,
    statusId: nextStatusId,
    completedAt: isClosed ? task.completedAt ?? now : null,
    updatedAt: now
  };
}

export function updateTask(task, patch = {}, statusConfig = DEFAULT_STATUS_CONFIG) {
  const nextStatusId = patch.statusId === undefined ? task.statusId : normalizeStatusId(statusConfig, patch.statusId);
  const isClosed = statusConfig.statuses.find((status) => status.id === nextStatusId)?.category === "closed";
  const now = new Date().toISOString();
  return {
    ...task,
    ...(patch.title !== undefined ? { title: requiredTitle(patch.title) } : {}),
    ...(patch.description !== undefined ? { description: patch.description ?? "" } : {}),
    ...(patch.projectId !== undefined ? { projectId: patch.projectId || null } : {}),
    ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId || null } : {}),
    ...(patch.labels !== undefined ? { labels: Array.isArray(patch.labels) ? patch.labels : [] } : {}),
    ...(patch.assignee !== undefined ? { assignee: patch.assignee || null } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate || null } : {}),
    statusId: nextStatusId,
    completedAt: isClosed ? task.completedAt ?? now : null,
    updatedAt: now
  };
}

export function matchesTask(task, filter = {}) {
  if (filter.projectId && task.projectId !== filter.projectId) return false;
  if (filter.sessionId && task.sessionId !== filter.sessionId) return false;
  if (filter.statusId && task.statusId !== filter.statusId) return false;
  if (filter.label && !(task.labels ?? []).some((label) => label === filter.label || String(label).split("::")[0] === filter.label)) return false;
  if (filter.query) {
    const haystack = `${task.title}\n${task.description}\n${task.labels.join(" ")}`.toLowerCase();
    if (!haystack.includes(filter.query.toLowerCase())) return false;
  }
  return true;
}

function requiredTitle(title) {
  const value = String(title ?? "").trim();
  if (!value) throw new Error("Task title is required.");
  return value;
}
