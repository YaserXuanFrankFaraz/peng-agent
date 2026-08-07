import { createId } from "./id.js";

export function createView({ workspaceId, name, entity = "sessions", filters = {}, sort = "updatedAt:desc" }) {
  const now = new Date().toISOString();
  return {
    id: createId("view"),
    workspaceId,
    name: requiredName(name),
    entity: normalizeEntity(entity),
    filters,
    sort,
    createdAt: now,
    updatedAt: now
  };
}

export function updateView(view, patch = {}) {
  return {
    ...view,
    ...(patch.name !== undefined ? { name: requiredName(patch.name) } : {}),
    ...(patch.entity !== undefined ? { entity: normalizeEntity(patch.entity) } : {}),
    ...(patch.filters !== undefined ? { filters: patch.filters ?? {} } : {}),
    ...(patch.sort !== undefined ? { sort: patch.sort || "updatedAt:desc" } : {}),
    updatedAt: new Date().toISOString()
  };
}

export function applyView(items, view) {
  const filtered = items.filter((item) => matchesFilters(item, view.filters ?? {}));
  return sortItems(filtered, view.sort ?? "updatedAt:desc");
}

function matchesFilters(item, filters) {
  for (const [key, expected] of Object.entries(filters)) {
    if (expected === undefined || expected === null || expected === "") continue;
    if (key === "query") {
      const haystack = JSON.stringify(item).toLowerCase();
      if (!haystack.includes(String(expected).toLowerCase())) return false;
    } else if (key === "label") {
      if (!(item.labels ?? []).some((label) => label === expected || String(label).split("::")[0] === expected)) return false;
    } else if (Array.isArray(item[key])) {
      if (!item[key].includes(expected)) return false;
    } else if (item[key] !== expected) {
      return false;
    }
  }
  return true;
}

function sortItems(items, sort) {
  const [field, direction] = sort.split(":");
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * sign);
}

function requiredName(name) {
  const value = String(name ?? "").trim();
  if (!value) throw new Error("View name is required.");
  return value;
}

function normalizeEntity(entity) {
  const value = entity ?? "sessions";
  if (!["sessions", "tasks", "projects", "threads"].includes(value)) throw new Error(`Unsupported view entity: ${value}`);
  return value;
}
