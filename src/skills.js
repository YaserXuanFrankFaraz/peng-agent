import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function discoverSkills({ workspace, home = process.env.HOME }) {
  const roots = [
    path.join(workspace, ".craft-agent", "skills"),
    home ? path.join(home, ".craft-agent", "skills") : null
  ].filter(Boolean);
  const skills = [];

  for (const root of roots) {
    for (const slug of await readDirNames(root)) {
      const skillPath = path.join(root, slug, "SKILL.md");
      const skill = await readSkill({ slug, skillPath, root });
      if (skill) skills.push(skill);
    }
  }

  return dedupeBySlug(skills);
}

export async function readSkill({ slug, skillPath, root }) {
  try {
    const text = await readFile(skillPath, "utf8");
    const parsed = parseSkillMarkdown(text);
    return { slug, root, path: skillPath, ...parsed };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function parseSkillMarkdown(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: text.trim(), valid: false, issues: ["missing YAML frontmatter"] };
  }
  const metadata = parseSimpleYaml(match[1]);
  const body = match[2].trim();
  const issues = [];
  if (!metadata.name) issues.push("missing name");
  if (!metadata.description) issues.push("missing description");
  if (!body) issues.push("missing body");
  return { metadata, body, valid: issues.length === 0, issues };
}

function parseSimpleYaml(text) {
  const metadata = {};
  let currentKey = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentKey) {
      metadata[currentKey] ??= [];
      metadata[currentKey].push(unquote(listMatch[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    currentKey = kv[1];
    metadata[currentKey] = parseYamlValue(kv[2]);
  }
  return metadata;
}

function parseYamlValue(value) {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  }
  return unquote(trimmed);
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, "");
}

async function readDirNames(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function dedupeBySlug(skills) {
  const seen = new Set();
  return skills.filter((skill) => {
    if (seen.has(skill.slug)) return false;
    seen.add(skill.slug);
    return true;
  });
}
