import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "./id.js";

const KNOWLEDGE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".mdx"]);
const TOKEN_LIMIT = 512;

export function createKnowledgeCollection({
  workspaceId,
  name,
  root,
  type = "vault",
  enabled = true,
  semanticEnabled = false,
  createdAt = new Date().toISOString()
}) {
  if (!name || typeof name !== "string") throw new Error("Knowledge collection requires name.");
  if (!root || typeof root !== "string") throw new Error("Knowledge collection requires root.");
  return {
    id: createId("knowledge_collection"),
    workspaceId,
    name: name.trim(),
    root,
    type,
    enabled: Boolean(enabled),
    semanticEnabled: Boolean(semanticEnabled),
    createdAt,
    updatedAt: createdAt
  };
}

export function updateKnowledgeCollection(collection, patch = {}) {
  return {
    ...collection,
    ...(patch.name !== undefined ? { name: requiredName(patch.name) } : {}),
    ...(patch.root !== undefined ? { root: requiredRoot(patch.root) } : {}),
    ...(patch.type !== undefined ? { type: patch.type || "vault" } : {}),
    ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    ...(patch.semanticEnabled !== undefined ? { semanticEnabled: Boolean(patch.semanticEnabled) } : {}),
    updatedAt: new Date().toISOString()
  };
}

export function createKnowledgeDocument({
  workspaceId,
  collectionId,
  title,
  path: filePath,
  content,
  sizeBytes = Buffer.byteLength(String(content ?? ""), "utf8"),
  modifiedAt = new Date().toISOString(),
  indexedAt = new Date().toISOString()
}) {
  if (!collectionId) throw new Error("Knowledge document requires collectionId.");
  if (!filePath) throw new Error("Knowledge document requires path.");
  const text = String(content ?? "");
  return {
    id: createId("knowledge_doc"),
    workspaceId,
    collectionId,
    title: title || titleFromPath(filePath),
    path: filePath,
    excerpt: excerpt(text),
    content: text,
    sizeBytes,
    modifiedAt,
    indexedAt
  };
}

export async function indexKnowledgeCollection({ collection, workspaceId }) {
  const root = path.resolve(collection.root);
  const documents = [];
  const gaps = [];

  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      return { documents, report: buildKnowledgeReport({ collections: [collection], documents, gaps: [`${collection.name}: root is not a directory`] }) };
    }
  } catch (error) {
    return { documents, report: buildKnowledgeReport({ collections: [collection], documents, gaps: [`${collection.name}: ${error.code ?? error.message}`] }) };
  }

  for await (const filePath of walkKnowledgeFiles(root)) {
    try {
      const info = await stat(filePath);
      const content = await readFile(filePath, "utf8");
      documents.push(createKnowledgeDocument({
        workspaceId,
        collectionId: collection.id,
        title: titleFromContent(content) || titleFromPath(filePath),
        path: path.relative(root, filePath),
        content,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString()
      }));
    } catch (error) {
      gaps.push(`${path.relative(root, filePath)}: ${error.code ?? error.message}`);
    }
  }

  return { documents, report: buildKnowledgeReport({ collections: [collection], documents, gaps }) };
}

export function searchKnowledgeDocuments(documents, { query = "", collectionId = null, limit = 10 } = {}) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return documents
    .filter((document) => !collectionId || document.collectionId === collectionId)
    .map((document) => ({ document, score: scoreDocument(document, terms) }))
    .filter((item) => terms.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || b.document.indexedAt.localeCompare(a.document.indexedAt))
    .slice(0, Number(limit) || 10)
    .map((item, index) => ({
      id: item.document.id,
      collectionId: item.document.collectionId,
      title: item.document.title,
      path: item.document.path,
      excerpt: item.document.excerpt,
      score: item.score,
      rank: index + 1
    }));
}

export function buildKnowledgeReport({ collections, documents, gaps = [], semanticEngine = semanticEngineStatus() }) {
  const byCollection = new Map();
  for (const collection of collections) {
    byCollection.set(collection.id, {
      collectionId: collection.id,
      name: collection.name,
      root: collection.root,
      enabled: collection.enabled,
      semanticEnabled: collection.semanticEnabled,
      documentCount: 0,
      totalBytes: 0
    });
  }
  for (const document of documents) {
    const row = byCollection.get(document.collectionId);
    if (!row) continue;
    row.documentCount += 1;
    row.totalBytes += document.sizeBytes ?? 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    collectionCount: collections.length,
    documentCount: documents.length,
    gaps,
    collections: [...byCollection.values()],
    semanticEngine
  };
}

export function defaultSemanticState({ cacheDir = null, model = null, createdAt = new Date().toISOString() } = {}) {
  return {
    version: 1,
    engine: "qmd",
    model,
    cacheDir,
    indexFile: null,
    installed: false,
    status: "unavailable",
    reason: "qmd engine is not installed",
    jobs: [],
    createdAt,
    updatedAt: createdAt
  };
}

export function semanticEngineStatusFromState(state = defaultSemanticState()) {
  const latestJob = [...(state.jobs ?? [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
  return semanticEngineStatus({
    installed: state.installed === true,
    model: state.model ?? null,
    indexPath: state.indexFile ?? state.cacheDir ?? null,
    reason: state.reason ?? "qmd engine is not installed",
    status: state.status,
    latestJob
  });
}

export function createSemanticIndexJob({
  collectionId = null,
  documentCount = 0,
  model = null,
  cacheDir = null,
  status = "blocked",
  reason = "qmd engine is not installed",
  createdAt = new Date().toISOString()
} = {}) {
  return {
    id: createId("knowledge_job"),
    type: "semantic_index",
    collectionId,
    documentCount,
    model,
    cacheDir,
    status,
    reason,
    createdAt,
    updatedAt: createdAt
  };
}

export async function buildSemanticIndex({ documents = [], cacheDir, model = "clean-room-tfidf", collectionId = null, createdAt = new Date().toISOString() } = {}) {
  if (!cacheDir) throw new Error("Semantic index requires cacheDir.");
  const selected = documents.filter((document) => !collectionId || document.collectionId === collectionId);
  const documentFrequencies = new Map();
  const tokenized = selected.map((document) => {
    const tokens = tokenizeSemanticText(`${document.title} ${document.path} ${document.content}`);
    const unique = new Set(tokens);
    for (const token of unique) documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    return { document, tokens };
  });
  const entries = tokenized.map(({ document, tokens }) => {
    const vector = semanticVector(tokens, documentFrequencies, selected.length);
    return {
      id: document.id,
      collectionId: document.collectionId,
      title: document.title,
      path: document.path,
      excerpt: document.excerpt,
      vector
    };
  });
  const index = {
    version: 1,
    engine: "clean-room-local-semantic",
    model,
    collectionId,
    documentCount: entries.length,
    createdAt,
    entries
  };
  await mkdir(cacheDir, { recursive: true });
  const indexPath = path.join(cacheDir, "index.json");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { index, indexPath };
}

export function searchSemanticIndex(index, { query = "", collectionId = null, limit = 10 } = {}) {
  const tokens = tokenizeSemanticText(query);
  if (tokens.length === 0) return [];
  const documentFrequencies = new Map();
  for (const entry of index.entries ?? []) {
    for (const token of Object.keys(entry.vector ?? {})) documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
  }
  const queryVector = semanticVector(tokens, documentFrequencies, Math.max(1, (index.entries ?? []).length));
  return (index.entries ?? [])
    .filter((entry) => !collectionId || entry.collectionId === collectionId)
    .map((entry) => ({ entry, score: cosineSimilarity(queryVector, entry.vector ?? {}) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, Number(limit) || 10)
    .map((item, index) => ({
      id: item.entry.id,
      collectionId: item.entry.collectionId,
      title: item.entry.title,
      path: item.entry.path,
      excerpt: item.entry.excerpt,
      score: item.score,
      rank: index + 1,
      semantic: true
    }));
}

export function updateSemanticState(state, patch = {}) {
  const updatedAt = patch.updatedAt ?? new Date().toISOString();
  return {
    ...state,
    ...(patch.engine !== undefined ? { engine: patch.engine } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.cacheDir !== undefined ? { cacheDir: patch.cacheDir } : {}),
    ...(patch.indexFile !== undefined ? { indexFile: patch.indexFile } : {}),
    ...(patch.installed !== undefined ? { installed: patch.installed === true } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
    ...(patch.jobs !== undefined ? { jobs: patch.jobs } : {}),
    updatedAt
  };
}

export async function inspectKnowledgeCollection({ collection, documents = [] }) {
  const root = path.resolve(collection.root);
  const gaps = [];
  const seen = new Set();
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      gaps.push(`${collection.name}: root is not a directory`);
      return { collectionId: collection.id, gaps, stale: [], missing: documents.map((document) => document.path) };
    }
  } catch (error) {
    gaps.push(`${collection.name}: ${error.code ?? error.message}`);
    return { collectionId: collection.id, gaps, stale: [], missing: documents.map((document) => document.path) };
  }

  for await (const filePath of walkKnowledgeFiles(root)) {
    const relativePath = path.relative(root, filePath);
    seen.add(relativePath);
    const document = documents.find((item) => item.collectionId === collection.id && item.path === relativePath);
    if (!document) continue;
    const info = await stat(filePath);
    if (new Date(document.modifiedAt).getTime() < info.mtime.getTime() || document.sizeBytes !== info.size) {
      gaps.push(`${relativePath}: stale`);
    }
  }

  const missing = documents
    .filter((document) => document.collectionId === collection.id && !seen.has(document.path))
    .map((document) => document.path);
  for (const filePath of missing) gaps.push(`${filePath}: missing`);
  return {
    collectionId: collection.id,
    gaps,
    stale: gaps.filter((gap) => gap.endsWith(": stale")).map((gap) => gap.replace(/: stale$/, "")),
    missing
  };
}

export function buildKnowledgeMaintenanceReport({ collections, documents, inspections = [], semanticEngine = semanticEngineStatus() }) {
  const gaps = inspections.flatMap((inspection) => inspection.gaps);
  return {
    ...buildKnowledgeReport({ collections, documents, gaps, semanticEngine }),
    inspections
  };
}

export function semanticEngineStatus({ installed = false, model = null, indexPath = null, reason = "qmd engine is not installed", status = null, latestJob = null } = {}) {
  return {
    installed,
    enabled: installed,
    model,
    indexPath,
    status: status ?? (installed ? "ready" : "unavailable"),
    reason: installed ? null : reason,
    latestJob
  };
}

function requiredName(name) {
  const value = String(name ?? "").trim();
  if (!value) throw new Error("Knowledge collection requires name.");
  return value;
}

function requiredRoot(root) {
  const value = String(root ?? "").trim();
  if (!value) throw new Error("Knowledge collection requires root.");
  return value;
}

async function* walkKnowledgeFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkKnowledgeFiles(filePath);
    } else if (entry.isFile() && KNOWLEDGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield filePath;
    }
  }
}

function scoreDocument(document, terms) {
  if (terms.length === 0) return Date.parse(document.indexedAt) || 0;
  const haystack = `${document.title} ${document.path} ${document.content}`.toLowerCase();
  return terms.reduce((score, term) => score + haystack.split(term).length - 1, 0);
}

function tokenizeSemanticText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .slice(0, TOKEN_LIMIT);
}

function semanticVector(tokens, documentFrequencies, documentCount) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const vector = {};
  const total = Math.max(1, tokens.length);
  for (const [token, count] of counts.entries()) {
    const idf = Math.log((1 + documentCount) / (1 + (documentFrequencies.get(token) ?? 0))) + 1;
    vector[token] = (count / total) * idf;
  }
  return vector;
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [token, value] of Object.entries(left)) {
    leftNorm += value * value;
    dot += value * (right[token] ?? 0);
  }
  for (const value of Object.values(right)) rightNorm += value * value;
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function titleFromContent(content) {
  const heading = String(content ?? "").split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : "";
}

function titleFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function excerpt(content) {
  return String(content ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}
