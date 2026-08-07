import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function discoverWorkflows({ workspace, home = process.env.HOME }) {
  const roots = [
    path.join(workspace, "workflow"),
    home ? path.join(home, ".craft-agent", "workflow") : null
  ].filter(Boolean);
  const workflows = [];

  for (const root of roots) {
    const files = await readMarkdownFiles(root);
    for (const file of files) {
      const filePath = path.join(root, file);
      const text = await readFile(filePath, "utf8");
      workflows.push(parseWorkflowMarkdown({ id: path.basename(file, ".md"), path: filePath, text }));
    }
  }

  return dedupeById(workflows);
}

export function parseWorkflowMarkdown({ id, path: filePath, text }) {
  const frontmatter = parseFrontmatter(text);
  const body = frontmatter.body;
  const title = firstMatch(body, /^#\s+(.+)$/m) ?? id;
  const summary = firstMatch(body, /^>\s+(.+)$/m) ?? "";
  const phases = [...body.matchAll(/^###\s+(.+)$/gm)].map((match) => ({
    title: match[1],
    checkpoint: /checkpoint|门禁|批准前|等待批准/i.test(match[1])
  }));
  const runnable = frontmatter.metadata.loop === "v1";

  return {
    id,
    path: filePath,
    title,
    summary,
    runnable,
    trigger: frontmatter.metadata.trigger ?? null,
    phases
  };
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: text };
  return { metadata: parseSimpleYaml(match[1]), body: match[2] };
}

function parseSimpleYaml(text) {
  const metadata = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) metadata[kv[1]] = kv[2].trim() || true;
  }
  return metadata;
}

async function readMarkdownFiles(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function firstMatch(text, regex) {
  return text.match(regex)?.[1]?.trim();
}

function dedupeById(workflows) {
  const seen = new Set();
  return workflows.filter((workflow) => {
    if (seen.has(workflow.id)) return false;
    seen.add(workflow.id);
    return true;
  });
}
