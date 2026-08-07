import path from "node:path";
import { createId } from "./id.js";
import { mergeConfig } from "./config.js";
import { EMPTY_LABEL_CONFIG } from "./labels.js";
import { DEFAULT_STATUS_CONFIG, normalizeStatusId } from "./statuses.js";

export function createWorkspace({ root, id = workspaceSlug(root), name = path.basename(root) }) {
  const now = new Date().toISOString();
  return {
    id,
    name,
    root,
    createdAt: now,
    updatedAt: now,
    config: mergeConfig().workspaceDefaults,
    statuses: DEFAULT_STATUS_CONFIG,
    labels: EMPTY_LABEL_CONFIG
  };
}

export function createProject({ workspaceId, name, root }) {
  const now = new Date().toISOString();
  return {
    id: createId("project"),
    workspaceId,
    name: name || path.basename(root || ""),
    root,
    createdAt: now,
    updatedAt: now
  };
}

export function updateProject(project, patch = {}) {
  const next = {
    ...project,
    ...(patch.name !== undefined ? { name: requiredProjectName(patch.name) } : {}),
    ...(patch.root !== undefined ? { root: patch.root || null } : {}),
    updatedAt: new Date().toISOString()
  };
  return next;
}

export function createSession({
  workspaceId,
  projectId = null,
  name,
  prompt = "",
  permissionMode = "safe",
  statusId,
  labels = [],
  labelConfig = EMPTY_LABEL_CONFIG,
  statusConfig = DEFAULT_STATUS_CONFIG
}) {
  const now = new Date().toISOString();
  return {
    id: createId("session"),
    workspaceId,
    projectId,
    name: name || titleFromPrompt(prompt),
    statusId: normalizeStatusId(statusConfig, statusId),
    labels: normalizeLabels(labels, labelConfig),
    permissionMode,
    isFlagged: false,
    createdAt: now,
    updatedAt: now,
    events: prompt ? [{ type: "UserPromptSubmit", prompt, createdAt: now }] : []
  };
}

export function updateSessionStatus(session, statusId, statusConfig = DEFAULT_STATUS_CONFIG) {
  const nextStatusId = normalizeStatusId(statusConfig, statusId);
  const oldStatusId = session.statusId;
  const updated = { ...session, statusId: nextStatusId, updatedAt: new Date().toISOString() };
  return {
    session: updated,
    event: {
      type: "SessionStatusChange",
      sessionId: session.id,
      oldState: oldStatusId,
      newState: nextStatusId,
      createdAt: updated.updatedAt
    }
  };
}

export function addSessionLabel(session, label) {
  if (session.labels.includes(label)) {
    return { session, event: null };
  }
  const updated = {
    ...session,
    labels: [...session.labels, label],
    updatedAt: new Date().toISOString()
  };
  return {
    session: updated,
    event: {
      type: "LabelAdd",
      sessionId: session.id,
      label,
      createdAt: updated.updatedAt
    }
  };
}

function titleFromPrompt(prompt) {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 80) || "Untitled session";
}

function requiredProjectName(name) {
  const value = String(name ?? "").trim();
  if (!value) throw new Error("Project name is required.");
  return value;
}

function normalizeLabels(labels, labelConfig) {
  if (!Array.isArray(labels)) return [];
  if ((labelConfig.labels ?? []).length === 0) return [...labels];
  return labels;
}

function workspaceSlug(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
}
