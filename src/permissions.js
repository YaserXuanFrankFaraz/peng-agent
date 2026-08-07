export const DEFAULT_PERMISSION_RULES = {
  version: "2026-03-07",
  allowedBashPatterns: [
    { pattern: "^ls\\b", comment: "List directory contents" },
    { pattern: "^find\\b", comment: "Search for files in directory hierarchy" },
    { pattern: "^rg\\b", comment: "Ripgrep search" },
    { pattern: "^cat\\b", comment: "Read file contents" },
    { pattern: "^head\\b", comment: "Read the beginning of files" },
    { pattern: "^tail\\b", comment: "Read the end of files" },
    { pattern: "^pwd$", comment: "Print working directory" },
    { pattern: "^git\\s+(status|log|diff|show|branch|ls-files)\\b", comment: "Git read-only operations" },
    { pattern: "^npm\\s+(ls|list|view|info|show|outdated|audit|search)\\b", comment: "npm read operations" }
  ],
  allowedMcpPatterns: [
    { pattern: "(list|get|search)", comment: "Read-oriented source operations" }
  ],
  allowedApiEndpoints: [
    { method: "GET", path: ".*", comment: "GET requests" }
  ],
  deniedBashPatterns: [
    { pattern: "\\brm\\s+-rf\\b", comment: "Recursive force delete is denied" },
    { pattern: "\\bsudo\\b", comment: "Privilege escalation is denied" }
  ],
  deniedMcpPatterns: [],
  deniedApiEndpoints: [],
  allowedTools: [],
  blockedTools: [],
  allowedWritePaths: [],
  deniedWritePaths: []
};

export function evaluatePermission({ mode = "safe", kind, value, method, path, rules = DEFAULT_PERMISSION_RULES }) {
  if (mode === "allow-all") return allow("allow-all mode");
  if (mode === "ask") return ask("ask mode requires confirmation");

  if (kind === "bash") {
    const denied = matchRegexRules(value, rules.deniedBashPatterns);
    if (denied.decision === "allow") return deny(denied.reason);
    return matchRegexRules(value, rules.allowedBashPatterns);
  }
  if (kind === "mcp") {
    const denied = matchRegexRules(value, rules.deniedMcpPatterns);
    if (denied.decision === "allow") return deny(denied.reason);
    return matchRegexRules(value, rules.allowedMcpPatterns);
  }
  if (kind === "api") {
    const denied = matchApiRules({ method, path: value }, rules.deniedApiEndpoints);
    if (denied.decision === "allow") return deny(denied.reason);
    return matchApiRules({ method, path: value }, rules.allowedApiEndpoints);
  }
  if (kind === "tool") {
    if ([...(rules.blockedTools ?? []), ...(rules.deniedTools ?? [])].includes(value)) return deny("tool is blocked");
    if ((rules.allowedTools ?? []).includes(value)) return allow("tool is allowed");
    return deny(`no ${mode} permission rule matched`);
  }
  if (kind === "write") {
    const target = path ?? value;
    if (matchGlobRules(target, rules.deniedWritePaths).decision === "allow") return deny("write path is denied");
    return matchGlobRules(target, rules.allowedWritePaths);
  }

  return deny(`no ${mode} permission rule matched`);
}

export function evaluateSourcePermission({ source, kind = "mcp", value, method = "GET", mode = "safe", rules = DEFAULT_PERMISSION_RULES }) {
  if (mode === "allow-all") return allow("allow-all mode");
  const sourceRules = source?.permissions ?? {};
  if (sourceRules.deniedTools?.includes(value)) return deny(`source ${source.slug} denied tool`);
  if (kind === "mcp" && Array.isArray(sourceRules.allowedTools)) {
    if (sourceRules.allowedTools.includes(value)) return allow(`source ${source.slug} allowed tool`);
    return deny(`source ${source.slug} did not allow tool`);
  }
  if (kind === "mcp" && Array.isArray(sourceRules.allowedMcpPatterns)) {
    if (Array.isArray(sourceRules.deniedMcpPatterns)) {
      const denied = matchRegexRules(value, sourceRules.deniedMcpPatterns);
      if (denied.decision === "allow") return deny(`source ${source.slug} denied MCP pattern`);
    }
    return matchRegexRules(value, sourceRules.allowedMcpPatterns);
  }
  if (kind === "api" && Array.isArray(sourceRules.allowedApiEndpoints)) {
    if (Array.isArray(sourceRules.deniedApiEndpoints)) {
      const denied = matchApiRules({ method, path: value }, sourceRules.deniedApiEndpoints);
      if (denied.decision === "allow") return deny(`source ${source.slug} denied API endpoint`);
    }
    return matchApiRules({ method, path: value }, sourceRules.allowedApiEndpoints);
  }
  return evaluatePermission({ mode, kind, value, method, rules });
}

export function validatePermissionRules(rules) {
  const issues = [];
  for (const collection of ["allowedBashPatterns", "deniedBashPatterns", "allowedMcpPatterns", "deniedMcpPatterns"]) {
    for (const rule of rules[collection] ?? []) {
      try {
        new RegExp(rule.pattern);
      } catch (error) {
        issues.push(`${collection}: invalid regex "${rule.pattern}": ${error.message}`);
      }
    }
  }
  for (const collection of ["allowedApiEndpoints", "deniedApiEndpoints"]) {
    for (const rule of rules[collection] ?? []) {
      if (!rule.method) issues.push(`${collection}: missing method`);
      if (!rule.path) issues.push(`${collection}: missing path`);
      try {
        new RegExp(rule.path);
      } catch (error) {
        issues.push(`${collection}: invalid path regex "${rule.path}": ${error.message}`);
      }
    }
  }
  for (const collection of ["allowedWritePaths", "deniedWritePaths"]) {
    for (const pattern of rules[collection] ?? []) {
      if (typeof pattern !== "string" || pattern.trim() === "") issues.push(`${collection}: invalid glob`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function matchRegexRules(value, rules = []) {
  for (const rule of rules) {
    if (new RegExp(rule.pattern).test(value)) return allow(rule.comment || rule.pattern);
  }
  return deny("no matching allow rule");
}

function matchApiRules({ method = "GET", path }, rules = []) {
  for (const rule of rules) {
    if (rule.method.toUpperCase() === method.toUpperCase() && new RegExp(rule.path).test(path)) {
      return allow(rule.comment || `${rule.method} ${rule.path}`);
    }
  }
  return deny("no matching API allow rule");
}

function matchGlobRules(value, patterns = []) {
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(value)) return allow(pattern);
  }
  return deny("no matching write path allow rule");
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function allow(reason) {
  return { decision: "allow", reason };
}

function deny(reason) {
  return { decision: "deny", reason };
}

function ask(reason) {
  return { decision: "ask", reason };
}
