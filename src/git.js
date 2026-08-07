import { execFile } from "node:child_process";
import path from "node:path";

const GIT_LOG_RECORD_SEPARATOR = "\x1e";
const GIT_LOG_FIELD_SEPARATOR = "\x1f";

export function parseGitStatusPorcelain(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseStatusLine(line));
}

export function summarizeGitStatus(entries) {
  const summary = {
    total: entries.length,
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    untracked: 0,
    conflicted: 0,
    other: 0
  };

  for (const entry of entries) {
    summary[entry.category] = (summary[entry.category] ?? 0) + 1;
  }

  return summary;
}

export function parseGitLog(text) {
  return String(text ?? "")
    .split(GIT_LOG_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, author, date, subject] = record.split(GIT_LOG_FIELD_SEPARATOR);
      if (!hash || !subject) {
        const [fallbackHash, ...messageParts] = record.split(/\s+/);
        return {
          hash: fallbackHash,
          shortHash: fallbackHash?.slice(0, 12) ?? "",
          author: null,
          date: null,
          subject: messageParts.join(" ")
        };
      }
      return {
        hash,
        shortHash: hash.slice(0, 12),
        author: author || null,
        date: date || null,
        subject: subject || ""
      };
    });
}

export function gitLogPrettyFormat() {
  return `%H%x1f%an%x1f%ai%x1f%s%x1e`;
}

export async function gitStatus({ cwd, pathspecs = [] } = {}) {
  const [status, branch] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1", "--", ...normalizeGitPathspecs(pathspecs)], { allowFailure: true }),
    gitCurrentBranch({ cwd })
  ]);
  if (!status.ok) return gitUnavailable(status);
  const entries = parseGitStatusPorcelain(status.stdout);
  return {
    ok: true,
    isRepository: true,
    branch,
    entries,
    summary: summarizeGitStatus(entries)
  };
}

export async function gitCurrentBranch({ cwd } = {}) {
  const branch = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  if (branch.ok && branch.stdout.trim()) return branch.stdout.trim();
  const detached = await runGit(cwd, ["rev-parse", "--short", "HEAD"], { allowFailure: true });
  return detached.ok && detached.stdout.trim() ? detached.stdout.trim() : null;
}

export async function gitBranches({ cwd } = {}) {
  const result = await runGit(cwd, ["branch", "--all", "--format=%(refname:short)\t%(objectname)\t%(HEAD)\t%(upstream:short)"], { allowFailure: true });
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, hash, marker, upstream] = line.split("\t");
      return {
        name,
        hash: hash || null,
        current: marker === "*",
        upstream: upstream || null,
        remote: name?.startsWith("remotes/") === true
      };
    });
}

export async function gitWorktrees({ cwd } = {}) {
  const result = await runGit(cwd, ["worktree", "list", "--porcelain"], { allowFailure: true });
  if (!result.ok) return [];
  const records = result.stdout.split(/\n\s*\n/).map((record) => record.trim()).filter(Boolean);
  return records.map((record) => {
    const item = {};
    for (const line of record.split(/\r?\n/)) {
      const [key, ...valueParts] = line.split(" ");
      if (key === "worktree") item.path = valueParts.join(" ");
      else if (key === "HEAD") item.head = valueParts.join(" ");
      else if (key === "branch") item.branch = valueParts.join(" ").replace(/^refs\/heads\//, "");
      else if (key === "detached") item.detached = true;
      else if (key === "bare") item.bare = true;
    }
    return item;
  });
}

export async function gitStashes({ cwd } = {}) {
  const result = await runGit(cwd, ["stash", "list", "--format=%gd%x1f%H%x1f%an%x1f%ai%x1f%s"], { allowFailure: true });
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref, hash, author, date, subject] = line.split(GIT_LOG_FIELD_SEPARATOR);
      return { ref, hash, shortHash: hash?.slice(0, 12) ?? "", author: author || null, date: date || null, subject: subject || "" };
    });
}

export async function gitHistory({ cwd, limit = 50, pathspecs = [] } = {}) {
  const count = Math.max(1, Math.min(500, Number(limit) || 50));
  const result = await runGit(cwd, ["log", `-${count}`, `--pretty=format:${gitLogPrettyFormat()}`, "--", ...normalizeGitPathspecs(pathspecs)], { allowFailure: true });
  return result.ok ? parseGitLog(result.stdout) : [];
}

export async function gitDiff({ cwd, staged = false, commit = null, pathspecs = [] } = {}) {
  const args = commit
    ? ["show", "--format=", "--no-ext-diff", String(commit), "--", ...normalizeGitPathspecs(pathspecs)]
    : ["diff", "--no-ext-diff", ...(staged ? ["--staged"] : []), "--", ...normalizeGitPathspecs(pathspecs)];
  const result = await runGit(cwd, args, { allowFailure: true, maxBuffer: 20 * 1024 * 1024 });
  return result.ok ? result.stdout : "";
}

export async function gitStage({ cwd, pathspecs = [] } = {}) {
  return gitOkResult(await runGit(cwd, ["add", "--", ...requiredPathspecs(pathspecs)], { allowFailure: true }));
}

export async function gitUnstage({ cwd, pathspecs = [] } = {}) {
  return gitOkResult(await runGit(cwd, ["restore", "--staged", "--", ...requiredPathspecs(pathspecs)], { allowFailure: true }));
}

export async function gitDiscard({ cwd, pathspecs = [] } = {}) {
  return gitOkResult(await runGit(cwd, ["restore", "--", ...requiredPathspecs(pathspecs)], { allowFailure: true }));
}

export async function gitCommit({ cwd, message } = {}) {
  const trimmed = String(message ?? "").trim();
  if (!trimmed) return { ok: false, code: "missing_message", stderr: "Commit message is required" };
  return gitOkResult(await runGit(cwd, ["commit", "-m", trimmed], { allowFailure: true }));
}

export async function gitCreateBranch({ cwd, name, startPoint = null, checkout = false } = {}) {
  const branch = safeGitRefName(name);
  const args = checkout ? ["switch", "-c", branch] : ["branch", branch];
  if (startPoint) args.push(String(startPoint));
  return gitOkResult(await runGit(cwd, args, { allowFailure: true }));
}

export async function gitSwitchBranch({ cwd, name } = {}) {
  return gitOkResult(await runGit(cwd, ["switch", safeGitRefName(name)], { allowFailure: true }));
}

export async function gitDeleteBranch({ cwd, name, force = false } = {}) {
  return gitOkResult(await runGit(cwd, ["branch", force ? "-D" : "-d", safeGitRefName(name)], { allowFailure: true }));
}

export async function gitMerge({ cwd, name } = {}) {
  return gitOkResult(await runGit(cwd, ["merge", safeGitRefName(name)], { allowFailure: true }));
}

export async function gitFetch({ cwd, remote = null } = {}) {
  return gitOkResult(await runGit(cwd, ["fetch", ...(remote ? [String(remote)] : [])], { allowFailure: true }));
}

export async function gitPull({ cwd, remote = null, branch = null } = {}) {
  return gitOkResult(await runGit(cwd, ["pull", ...(remote ? [String(remote)] : []), ...(branch ? [String(branch)] : [])], { allowFailure: true }));
}

export async function gitPush({ cwd, remote = null, branch = null, setUpstream = false } = {}) {
  return gitOkResult(await runGit(cwd, ["push", ...(setUpstream ? ["-u"] : []), ...(remote ? [String(remote)] : []), ...(branch ? [String(branch)] : [])], { allowFailure: true }));
}

export async function gitSaveStash({ cwd, message = null, includeUntracked = false } = {}) {
  return gitOkResult(await runGit(cwd, ["stash", "push", ...(includeUntracked ? ["--include-untracked"] : []), ...(message ? ["-m", String(message)] : [])], { allowFailure: true }));
}

export async function gitApplyStash({ cwd, ref = "stash@{0}", pop = false } = {}) {
  return gitOkResult(await runGit(cwd, ["stash", pop ? "pop" : "apply", String(ref)], { allowFailure: true }));
}

export async function gitDropStash({ cwd, ref = "stash@{0}" } = {}) {
  return gitOkResult(await runGit(cwd, ["stash", "drop", String(ref)], { allowFailure: true }));
}

export async function gitAddWorktree({ cwd, worktreePath, branch = null } = {}) {
  const target = requiredWorkspacePath(cwd, worktreePath);
  return gitOkResult(await runGit(cwd, ["worktree", "add", target, ...(branch ? [safeGitRefName(branch)] : [])], { allowFailure: true }));
}

export async function gitRemoveWorktree({ cwd, worktreePath, force = false } = {}) {
  const target = requiredWorkspacePath(cwd, worktreePath);
  return gitOkResult(await runGit(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), target], { allowFailure: true }));
}

export async function gitGenerateCommitMessage({ cwd } = {}) {
  const status = await gitStatus({ cwd });
  if (!status.ok || status.summary.total === 0) return "Update workspace";
  const categories = Object.entries(status.summary)
    .filter(([key, value]) => key !== "total" && value > 0)
    .map(([key, value]) => `${value} ${key}`);
  return `Update ${status.summary.total} file${status.summary.total === 1 ? "" : "s"} (${categories.join(", ")})`;
}

function runGit(cwd, args, { allowFailure = false, timeoutMs = 15000, maxBuffer = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
      const result = {
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal ?? null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        args
      };
      if (error && !allowFailure) reject(Object.assign(error, result));
      else resolve(result);
    });
    child.stdin?.end();
  });
}

function gitUnavailable(result) {
  return {
    ok: false,
    isRepository: false,
    branch: null,
    entries: [],
    summary: summarizeGitStatus([]),
    code: result.code,
    stderr: result.stderr
  };
}

function gitOkResult(result) {
  return {
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function normalizeGitPathspecs(value) {
  const list = Array.isArray(value) ? value : [value].filter(Boolean);
  return list
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => item.replace(/^\.\//, ""))
    .filter((item) => item !== "." && !path.isAbsolute(item) && !item.split(/[\\/]/).includes(".."));
}

function requiredPathspecs(value) {
  const pathspecs = normalizeGitPathspecs(value);
  if (pathspecs.length === 0) throw new Error("At least one workspace-relative path is required");
  return pathspecs;
}

function safeGitRefName(value) {
  const ref = String(value ?? "").trim();
  if (!ref || ref.startsWith("-") || ref.includes("..") || /[\s~^:?*[\\]/.test(ref)) throw new Error("Invalid git ref name");
  return ref;
}

function requiredWorkspacePath(cwd, value) {
  const requested = String(value ?? "").trim();
  if (!requested) throw new Error("worktreePath is required");
  const resolved = path.resolve(cwd, requested);
  const parent = path.resolve(cwd, "..");
  if (!resolved.startsWith(`${parent}${path.sep}`)) throw new Error("worktreePath must stay next to the workspace");
  return resolved;
}

function parseStatusLine(line) {
  const index = line[0] ?? " ";
  const worktree = line[1] ?? " ";
  const rawPath = line.slice(3);
  const [originalPath, path] = parseRenamedPath(rawPath);
  const category = categorizeStatus(index, worktree);

  return {
    index,
    worktree,
    path,
    originalPath,
    category,
    raw: line
  };
}

function parseRenamedPath(rawPath) {
  const text = rawPath.trim();
  const arrowIndex = text.indexOf(" -> ");
  if (arrowIndex === -1) return [null, unquoteGitPath(text)];
  return [unquoteGitPath(text.slice(0, arrowIndex)), unquoteGitPath(text.slice(arrowIndex + 4))];
}

function unquoteGitPath(value) {
  const text = String(value ?? "");
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(1, -1);
  }
}

function categorizeStatus(index, worktree) {
  const pair = `${index}${worktree}`;
  if (pair === "??") return "untracked";
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(pair)) return "conflicted";
  if (index === "R" || worktree === "R") return "renamed";
  if (index === "C" || worktree === "C") return "copied";
  if (index === "A" || worktree === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "M" || worktree === "M") return "modified";
  return "other";
}
