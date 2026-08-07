export const DEFAULT_STATUS_CONFIG = {
  version: 1,
  statuses: [
    {
      id: "backlog",
      label: "Backlog",
      color: "foreground/50",
      category: "open",
      isFixed: false,
      isDefault: true,
      order: 0
    },
    {
      id: "todo",
      label: "Todo",
      color: "foreground/50",
      category: "open",
      isFixed: true,
      isDefault: false,
      order: 1
    },
    {
      id: "needs-review",
      label: "Needs Review",
      color: "info",
      category: "open",
      isFixed: false,
      isDefault: true,
      order: 2
    },
    {
      id: "done",
      label: "Done",
      color: "accent",
      category: "closed",
      isFixed: true,
      isDefault: false,
      order: 3
    },
    {
      id: "cancelled",
      label: "Cancelled",
      color: "foreground/50",
      category: "closed",
      isFixed: true,
      isDefault: false,
      order: 4
    }
  ],
  defaultStatusId: "todo"
};

export function validateStatusConfig(config = DEFAULT_STATUS_CONFIG) {
  const issues = [];
  const statuses = Array.isArray(config.statuses) ? config.statuses : [];
  const ids = new Set();

  for (const status of statuses) {
    if (!isSlug(status.id)) issues.push(`invalid status id: ${status.id}`);
    if (ids.has(status.id)) issues.push(`duplicate status id: ${status.id}`);
    ids.add(status.id);
    if (!status.label) issues.push(`missing label for status: ${status.id}`);
    if (!["open", "closed"].includes(status.category)) {
      issues.push(`invalid category for status ${status.id}: ${status.category}`);
    }
  }

  for (const fixedId of ["todo", "done", "cancelled"]) {
    const status = statuses.find((item) => item.id === fixedId);
    if (!status) issues.push(`missing fixed status: ${fixedId}`);
    if (status && status.isFixed !== true) issues.push(`fixed status must set isFixed=true: ${fixedId}`);
  }

  if (!ids.has(config.defaultStatusId)) {
    issues.push(`defaultStatusId does not reference a status: ${config.defaultStatusId}`);
  }
  if (!statuses.some((status) => status.category === "open")) issues.push("missing open status");
  if (!statuses.some((status) => status.category === "closed")) issues.push("missing closed status");

  return { ok: issues.length === 0, issues };
}

export function createStatus(config, input = {}) {
  const status = normalizeStatus(input, nextOrder(config), false);
  if (getStatus(config, status.id)) throw new Error(`Status already exists: ${status.id}`);
  const next = validateNextConfig({
    ...config,
    statuses: [...config.statuses, status]
  });
  return status.isDefault ? setDefaultStatus(next, status.id) : next;
}

export function updateStatus(config, statusId, patch = {}) {
  const current = getStatus(config, statusId);
  if (!current) throw new Error(`Unknown status: ${statusId}`);
  const cleanPatch = withoutEmptyPatchValues(patch);
  if (current.isFixed && cleanPatch.id && cleanPatch.id !== current.id) throw new Error(`Cannot rename fixed status: ${statusId}`);
  const nextStatus = normalizeStatus({ ...current, ...cleanPatch, isFixed: current.isFixed }, current.order, current.isFixed);
  if (nextStatus.id !== current.id && getStatus(config, nextStatus.id)) throw new Error(`Status already exists: ${nextStatus.id}`);
  let next = {
    ...config,
    defaultStatusId: config.defaultStatusId === current.id ? nextStatus.id : config.defaultStatusId,
    statuses: config.statuses.map((status) => (status.id === current.id ? nextStatus : status))
  };
  if (cleanPatch.default === true || cleanPatch.isDefault === true) next = setDefaultStatus(next, nextStatus.id);
  return validateNextConfig(sortStatuses(next));
}

export function deleteStatus(config, statusId, { replacementStatusId = config.defaultStatusId } = {}) {
  const current = getStatus(config, statusId);
  if (!current) throw new Error(`Unknown status: ${statusId}`);
  if (current.isFixed) throw new Error(`Cannot delete fixed status: ${statusId}`);
  const replacement = getStatus(config, replacementStatusId);
  if (!replacement || replacement.id === statusId) throw new Error(`Invalid replacement status: ${replacementStatusId}`);
  return {
    config: validateNextConfig(sortStatuses({
      ...config,
      defaultStatusId: config.defaultStatusId === statusId ? replacement.id : config.defaultStatusId,
      statuses: config.statuses.filter((status) => status.id !== statusId)
    })),
    replacementStatusId: replacement.id
  };
}

export function setDefaultStatus(config, statusId) {
  if (!getStatus(config, statusId)) throw new Error(`Unknown status: ${statusId}`);
  return validateNextConfig({
    ...config,
    defaultStatusId: statusId,
    statuses: config.statuses.map((status) => ({
      ...status,
      isDefault: status.id === statusId
    }))
  });
}

export function getStatus(config, statusId) {
  return config.statuses.find((status) => status.id === statusId) ?? null;
}

export function normalizeStatusId(config, statusId) {
  return getStatus(config, statusId)?.id ?? config.defaultStatusId;
}

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function normalizeStatus(input, fallbackOrder, fixed) {
  const id = input.id ?? slugFromLabel(input.label);
  return {
    id,
    label: input.label ?? id,
    color: input.color ?? "foreground/50",
    category: input.category ?? "open",
    isFixed: fixed,
    isDefault: input.isDefault === true || input.default === true,
    order: Number(input.order ?? fallbackOrder)
  };
}

function nextOrder(config) {
  return Math.max(-1, ...config.statuses.map((status) => Number(status.order ?? 0))) + 1;
}

function sortStatuses(config) {
  return {
    ...config,
    statuses: [...config.statuses]
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
      .map((status, index) => ({ ...status, order: index }))
  };
}

function validateNextConfig(config) {
  const result = validateStatusConfig(config);
  if (!result.ok) throw new Error(`Invalid status config: ${result.issues.join("; ")}`);
  return config;
}

function slugFromLabel(label) {
  return String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function withoutEmptyPatchValues(patch) {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}
