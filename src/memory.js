import { createId } from "./id.js";

const MAX_CONTEXT_CHARS = 4000;
const SECRET_PATTERNS = [
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: "Bearer [REDACTED]" },
  { name: "openai api key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { name: "assignment secret", pattern: /\b(api[_-]?key|token|password|secret)\s*=\s*["']?[^"'\s]{8,}/gi, replacement: "$1=[REDACTED]" }
];

export function createMemoryRecord({
  text,
  source = "UserPromptSubmit",
  workspaceId = null,
  sessionId = null,
  tags = [],
  createdAt = new Date().toISOString()
}) {
  const rawText = String(text ?? "").trim();
  if (!rawText) throw new Error("Memory text is required.");
  const redactedText = redactMemoryText(rawText);
  assertNoObviousSecret(redactedText);

  return {
    id: createId("memory"),
    text: redactedText,
    source,
    workspaceId,
    sessionId,
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : [],
    usageCount: 0,
    createdAt,
    updatedAt: createdAt
  };
}

export function redactMemoryText(text) {
  let redacted = String(text ?? "");
  for (const rule of SECRET_PATTERNS) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  return redacted;
}

export function assertNoObviousSecret(text) {
  const suspicious = [
    /\b[A-Za-z0-9+/]{32,}={0,2}\b/,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bAIza[A-Za-z0-9_-]{20,}\b/
  ];
  if (suspicious.some((pattern) => pattern.test(text))) {
    throw new Error("Memory text appears to contain an unredacted secret.");
  }
}

export function searchMemories(memories, { query = "", limit = 10 } = {}) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return memories
    .map((memory) => ({ memory, score: scoreMemory(memory, terms) }))
    .filter((item) => terms.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt))
    .slice(0, Number(limit) || 10)
    .map((item, index) => ({
      ...item.memory,
      citation: `[memory:${item.memory.id}]`,
      rank: index + 1,
      score: item.score
    }));
}

export function renderMemoryContext(memories, { query = "", limit = 8, maxChars = MAX_CONTEXT_CHARS } = {}) {
  const selected = searchMemories(memories, { query, limit });
  if (selected.length === 0) return "";

  const lines = ["<memory_context>"];
  for (const memory of selected) {
    const next = `- [memory:${memory.id}] ${memory.text}`;
    if (lines.join("\n").length + next.length + "</memory_context>".length + 2 > maxChars) break;
    lines.push(next);
  }
  lines.push("</memory_context>");
  return lines.join("\n");
}

export function parseMemoryCitations(text) {
  const ids = new Set();
  for (const match of String(text ?? "").matchAll(/\[memory:([A-Za-z0-9_-]+)\]/g)) {
    ids.add(match[1]);
  }
  return [...ids];
}

export function scanMemoryCitations(items = []) {
  const ids = new Set();
  for (const item of items) {
    for (const id of parseMemoryCitations(extractCitationText(item))) ids.add(id);
  }
  return [...ids];
}

export function extractMemoryCandidates({
  text,
  source = "UserPromptSubmit",
  workspaceId = null,
  sessionId = null,
  tags = [],
  createdAt = new Date().toISOString()
} = {}) {
  const candidates = [];
  for (const sentence of splitCandidateSentences(text)) {
    if (!isMemoryWorthy(sentence)) continue;
    candidates.push(createMemoryRecord({ text: cleanMemorySentence(sentence), source, workspaceId, sessionId, tags, createdAt }));
  }
  return candidates;
}

export function consolidateMemories(memories) {
  const byKey = new Map();
  for (const memory of memories) {
    const key = normalizeMemoryKey(memory.text);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...memory, tags: [...(memory.tags ?? [])] });
      continue;
    }
    byKey.set(key, {
      ...existing,
      usageCount: Number(existing.usageCount ?? 0) + Number(memory.usageCount ?? 0),
      tags: [...new Set([...(existing.tags ?? []), ...(memory.tags ?? [])])],
      createdAt: existing.createdAt < memory.createdAt ? existing.createdAt : memory.createdAt,
      updatedAt: existing.updatedAt > memory.updatedAt ? existing.updatedAt : memory.updatedAt
    });
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function applyMemoryCitationUsage(memories, citedIds, { usedAt = new Date().toISOString() } = {}) {
  const cited = new Set(citedIds);
  return memories.map((memory) =>
    cited.has(memory.id)
      ? {
          ...memory,
          usageCount: Number(memory.usageCount ?? 0) + 1,
          lastUsedAt: usedAt,
          updatedAt: usedAt
        }
      : memory
  );
}

export function pruneMemories(memories, { maxRecords = 500, maxAgeDays = null, minUsageCount = null, now = new Date(), maxRemovedPerRun = null, maxRemovedRatio = null } = {}) {
  const cutoff = maxAgeDays ? now.getTime() - Number(maxAgeDays) * 24 * 60 * 60 * 1000 : null;
  const candidates = memories
    .filter((memory) => {
      if (minUsageCount !== null && Number(memory.usageCount ?? 0) < Number(minUsageCount)) return false;
      if (cutoff !== null && Date.parse(memory.updatedAt ?? memory.createdAt) < cutoff) return false;
      return true;
    })
    .sort(memoryPrioritySort)
    .slice(0, Number(maxRecords) || 500);
  return applyRetentionRateCaps(memories, candidates, { maxRemovedPerRun, maxRemovedRatio });
}

export function applyRetentionRateCaps(original, maintained, { maxRemovedPerRun = null, maxRemovedRatio = null } = {}) {
  const maintainedIds = new Set(maintained.map((memory) => memory.id));
  const removed = original.filter((memory) => !maintainedIds.has(memory.id));
  const maxRemoved = retentionRemovalLimit(original.length, { maxRemovedPerRun, maxRemovedRatio });
  if (maxRemoved === null || removed.length <= maxRemoved) return maintained;

  const keepCount = removed.length - maxRemoved;
  const deferred = removed.sort(memoryPrioritySort).slice(0, keepCount);
  return [...maintained, ...deferred].sort(memoryPrioritySort);
}

export function renderMemoriesMarkdown(memories, { title = "Craft Memory", generatedAt = new Date().toISOString() } = {}) {
  const lines = [`# ${title}`, "", `Generated: ${generatedAt}`, ""];
  for (const memory of memories.sort(memoryPrioritySort)) {
    const tags = (memory.tags ?? []).length ? ` tags=${memory.tags.join(",")}` : "";
    const usage = Number(memory.usageCount ?? 0);
    lines.push(`- [${memory.id}] ${memory.text}`);
    lines.push(`  - source=${memory.source} usage=${usage}${tags}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderMemoriesJsonl(memories) {
  return memories.map((memory) => JSON.stringify(memory)).join("\n") + (memories.length ? "\n" : "");
}

export function buildMemoryMaintenanceReport(original, maintained, { unconstrainedCount = maintained.length } = {}) {
  const removed = Math.max(0, original.length - maintained.length);
  const unconstrainedRemoved = Math.max(0, original.length - unconstrainedCount);
  return {
    before: original.length,
    after: maintained.length,
    removed,
    deferredRemovals: Math.max(0, unconstrainedRemoved - removed),
    generatedAt: new Date().toISOString()
  };
}

function scoreMemory(memory, terms) {
  if (terms.length === 0) return Date.parse(memory.createdAt) || 0;
  const haystack = `${memory.text} ${(memory.tags ?? []).join(" ")}`.toLowerCase();
  return terms.reduce((score, term) => {
    const count = haystack.split(term).length - 1;
    return score + count;
  }, 0);
}

function splitCandidateSentences(text) {
  return String(text ?? "")
    .split(/[\n.!?。！？]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isMemoryWorthy(sentence) {
  return /\b(prefer|remember|always|never|avoid|use|default|do not|don't)\b/i.test(sentence);
}

function cleanMemorySentence(sentence) {
  return sentence.replace(/^\s*(please\s+)?remember\s+(that\s+)?/i, "").trim();
}

function normalizeMemoryKey(text) {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function memoryPrioritySort(a, b) {
  return Number(b.usageCount ?? 0) - Number(a.usageCount ?? 0) || b.updatedAt.localeCompare(a.updatedAt);
}

function retentionRemovalLimit(total, { maxRemovedPerRun, maxRemovedRatio }) {
  const limits = [];
  if (maxRemovedPerRun !== null && maxRemovedPerRun !== undefined) {
    const countLimit = Number(maxRemovedPerRun);
    if (Number.isFinite(countLimit) && countLimit >= 0) limits.push(Math.trunc(countLimit));
  }
  if (maxRemovedRatio !== null && maxRemovedRatio !== undefined) {
    const ratioLimit = Number(maxRemovedRatio);
    if (Number.isFinite(ratioLimit) && ratioLimit >= 0) {
      limits.push(Math.floor(total * Math.min(1, ratioLimit)));
    }
  }
  if (limits.length === 0) return null;
  return Math.max(0, Math.min(...limits));
}

function extractCitationText(item) {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;
  if (typeof item.content === "string") return item.content;
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (item.payload) return extractCitationText(item.payload);
  if (typeof item === "object") return JSON.stringify(item);
  return String(item);
}
