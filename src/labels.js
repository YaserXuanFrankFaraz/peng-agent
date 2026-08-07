export const EMPTY_LABEL_CONFIG = {
  version: 1,
  labels: []
};

export function validateLabelConfig(config = EMPTY_LABEL_CONFIG) {
  const issues = [];
  const ids = new Set();
  visitLabels(config.labels ?? [], 1, (label) => {
    if (!isSlug(label.id)) issues.push(`invalid label id: ${label.id}`);
    if (ids.has(label.id)) issues.push(`duplicate label id: ${label.id}`);
    ids.add(label.id);
    if (!label.name) issues.push(`missing name for label: ${label.id}`);
    if (label.valueType && !["string", "number", "date", "link"].includes(label.valueType)) {
      issues.push(`invalid valueType for label ${label.id}: ${label.valueType}`);
    }
  }, issues);
  return { ok: issues.length === 0, issues };
}

export function flattenLabels(config = EMPTY_LABEL_CONFIG) {
  const labels = [];
  visitLabels(config.labels ?? [], 1, (label, depth, parentId) => {
    labels.push({ ...label, depth, parentId, children: undefined });
  }, []);
  return labels;
}

export function parseSessionLabel(value) {
  const [id, rawValue] = splitFirst(value, "::");
  if (rawValue === undefined) return { id, value: null, valueType: "boolean" };
  return { id, value: rawValue, valueType: inferValueType(rawValue) };
}

export function filterValidSessionLabels(labels, config = EMPTY_LABEL_CONFIG) {
  const ids = new Set(flattenLabels(config).map((label) => label.id));
  return labels.filter((label) => ids.has(parseSessionLabel(label).id));
}

export function filterLabels(config = EMPTY_LABEL_CONFIG, filter = {}) {
  const query = String(filter.query ?? "").trim().toLowerCase();
  return flattenLabels(config).filter((label) => {
    if (filter.parentId !== undefined && filter.parentId !== null && label.parentId !== filter.parentId) return false;
    if (filter.valueType && label.valueType !== filter.valueType) return false;
    if (query && !`${label.id} ${label.name}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function createLabel(config = EMPTY_LABEL_CONFIG, input = {}) {
  const label = normalizeLabel(input);
  if (findLabel(config.labels, label.id)) throw new Error(`Label already exists: ${label.id}`);
  const nextLabels = input.parentId
    ? updateLabelTree(config.labels ?? [], input.parentId, (parent) => ({
        ...parent,
        children: [...(parent.children ?? []), label]
      }))
    : [...(config.labels ?? []), label];
  return validateNextConfig({ ...config, labels: nextLabels });
}

export function updateLabel(config = EMPTY_LABEL_CONFIG, labelId, patch = {}) {
  const current = findLabel(config.labels, labelId);
  if (!current) throw new Error(`Unknown label: ${labelId}`);
  const cleanPatch = withoutEmptyPatchValues(patch);
  const nextLabel = normalizeLabel({ ...current, ...cleanPatch, id: cleanPatch.id ?? current.id });
  if (nextLabel.id !== labelId && findLabel(config.labels, nextLabel.id)) throw new Error(`Label already exists: ${nextLabel.id}`);
  let labels = updateLabelTree(config.labels ?? [], labelId, () => ({ ...nextLabel, children: current.children }));
  if (cleanPatch.parentId !== undefined) {
    const removed = removeLabelFromTree(labels, nextLabel.id);
    labels = cleanPatch.parentId
      ? updateLabelTree(removed.labels, cleanPatch.parentId, (parent) => ({ ...parent, children: [...(parent.children ?? []), removed.label] }))
      : [...removed.labels, removed.label];
  }
  return validateNextConfig({ ...config, labels });
}

export function deleteLabel(config = EMPTY_LABEL_CONFIG, labelId) {
  const current = findLabel(config.labels, labelId);
  if (!current) throw new Error(`Unknown label: ${labelId}`);
  const removed = removeLabelFromTree(config.labels ?? [], labelId);
  return {
    config: validateNextConfig({ ...config, labels: removed.labels }),
    removed: flattenLabels({ version: config.version, labels: [removed.label] }).map((label) => label.id)
  };
}

function visitLabels(labels, depth, visit, issues, parentId = null) {
  if (depth > 5) {
    issues.push("label nesting depth exceeds 5");
    return;
  }
  for (const label of labels) {
    visit(label, depth, parentId);
    if (Array.isArray(label.children)) {
      visitLabels(label.children, depth + 1, visit, issues, label.id);
    }
  }
}

function inferValueType(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (Number.isFinite(Number(value)) && value.trim() !== "") return "number";
  return "string";
}

function splitFirst(value, separator) {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function normalizeLabel(input) {
  const id = input.id ?? slugFromName(input.name);
  return {
    id,
    name: input.name ?? id,
    color: input.color ?? "foreground/50",
    ...(input.valueType ? { valueType: input.valueType } : {}),
    ...(Array.isArray(input.children) && input.children.length > 0 ? { children: input.children.map(normalizeLabel) } : {})
  };
}

function findLabel(labels = [], labelId) {
  for (const label of labels) {
    if (label.id === labelId) return label;
    const found = findLabel(label.children ?? [], labelId);
    if (found) return found;
  }
  return null;
}

function updateLabelTree(labels = [], labelId, updater) {
  const { labels: next, found } = updateLabelTreeInner(labels, labelId, updater);
  if (!found) throw new Error(`Unknown label: ${labelId}`);
  return next;
}

function updateLabelTreeInner(labels = [], labelId, updater) {
  let found = false;
  const next = labels.map((label) => {
    if (label.id === labelId) {
      found = true;
      return updater(label);
    }
    if (Array.isArray(label.children)) {
      const child = updateLabelTreeInner(label.children, labelId, updater);
      if (child.found) found = true;
      return { ...label, children: child.labels };
    }
    return label;
  });
  return { labels: next, found };
}

function removeLabelFromTree(labels = [], labelId) {
  const removed = removeLabelFromTreeInner(labels, labelId);
  if (!removed.label) throw new Error(`Unknown label: ${labelId}`);
  return removed;
}

function removeLabelFromTreeInner(labels = [], labelId) {
  let removedLabel = null;
  const next = [];
  for (const label of labels) {
    if (label.id === labelId) {
      removedLabel = label;
      continue;
    }
    if (Array.isArray(label.children)) {
      const child = removeLabelFromTreeInner(label.children, labelId);
      if (child.label) removedLabel = child.label;
      next.push({ ...label, children: child.labels });
    } else {
      next.push(label);
    }
  }
  return { labels: next, label: removedLabel };
}

function validateNextConfig(config) {
  const result = validateLabelConfig(config);
  if (!result.ok) throw new Error(`Invalid label config: ${result.issues.join("; ")}`);
  return config;
}

function withoutEmptyPatchValues(patch) {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => value !== undefined && value !== "" && !(value === null && key !== "parentId"))
  );
}

function slugFromName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
