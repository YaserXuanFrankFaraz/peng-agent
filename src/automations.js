import { createId } from "./id.js";
import { createSession } from "./domain.js";

export const EMPTY_AUTOMATION_CONFIG = {
  version: 2,
  automations: {}
};

export const APP_EVENTS = new Set([
  "LabelAdd",
  "LabelRemove",
  "LabelConfigChange",
  "PermissionModeChange",
  "FlagChange",
  "SessionStatusChange",
  "SchedulerTick"
]);

export const AGENT_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
  "Setup"
]);

export function validateAutomationConfig(config = EMPTY_AUTOMATION_CONFIG) {
  const issues = [];
  if (config.version !== 2) issues.push("version must be 2");
  if (!config.automations || typeof config.automations !== "object" || Array.isArray(config.automations)) {
    issues.push("automations must be an object keyed by event name");
    return { ok: false, issues };
  }

  for (const [eventName, matchers] of Object.entries(config.automations)) {
    if (!APP_EVENTS.has(eventName) && !AGENT_EVENTS.has(eventName)) issues.push(`unknown event: ${eventName}`);
    if (!Array.isArray(matchers)) {
      issues.push(`${eventName} must be an array`);
      continue;
    }
    for (const matcher of matchers) {
      if (matcher.matcher) {
        try {
          new RegExp(matcher.matcher);
        } catch (error) {
          issues.push(`${eventName}: invalid matcher regex "${matcher.matcher}": ${error.message}`);
        }
      }
      if (matcher.condition && !validateCondition(matcher.condition)) {
        issues.push(`${eventName}: invalid condition`);
      }
      for (const action of matcher.actions ?? []) {
        if (action.type === "prompt" && !action.prompt) issues.push(`${eventName}: prompt action requires prompt`);
        if (action.type === "webhook" && !action.url) issues.push(`${eventName}: webhook action requires url`);
        if (action.type === "webhook" && action.method && !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(action.method).toUpperCase())) {
          issues.push(`${eventName}: unsupported webhook method ${action.method}`);
        }
        if (action.rateLimit && !validRateLimit(action.rateLimit)) issues.push(`${eventName}: invalid rateLimit`);
        if (action.type && !["prompt", "webhook"].includes(action.type)) {
          issues.push(`${eventName}: unsupported action type ${action.type}`);
        }
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export function lintAutomationConfig(config = EMPTY_AUTOMATION_CONFIG) {
  const validation = validateAutomationConfig(config);
  const warnings = [];
  for (const [eventName, matchers] of Object.entries(config.automations ?? {})) {
    if (!Array.isArray(matchers)) continue;
    matchers.forEach((matcher, matcherIndex) => {
      if ((matcher.actions ?? []).length === 0) warnings.push(`${eventName}[${matcherIndex}]: matcher has no actions`);
      if (!matcher.matcher && !matcher.condition) warnings.push(`${eventName}[${matcherIndex}]: matcher runs for every ${eventName} event`);
      (matcher.actions ?? []).forEach((action, actionIndex) => {
        if (action.type === "webhook" && action.captureResponse !== true) {
          warnings.push(`${eventName}[${matcherIndex}].actions[${actionIndex}]: webhook response is not captured`);
        }
        if (action.type === "webhook" && !action.rateLimit) {
          warnings.push(`${eventName}[${matcherIndex}].actions[${actionIndex}]: webhook has no rateLimit`);
        }
      });
    });
  }
  return { ok: validation.ok, issues: validation.issues, warnings };
}

export async function runAutomations({ config, event, store, now = new Date(), env = {}, executeWebhooks = false, fetchImpl = globalThis.fetch } = {}) {
  const workspace = await store.getWorkspace();
  const matchers = config.automations?.[event.type] ?? [];
  const results = [];
  const previousHistory = typeof store.listAutomationHistory === "function" ? await store.listAutomationHistory() : [];

  for (const [matcherIndex, matcher] of matchers.entries()) {
    if (matcher.enabled === false) continue;
    if (!matchesEvent(matcher, event, now)) continue;
    const variables = buildVariables({ workspace, event });
    for (const [actionIndex, action] of (matcher.actions ?? []).entries()) {
      const automationKey = `${event.type}:${matcherIndex}:${actionIndex}:${action.type}`;
      if (action.type === "prompt") {
        const session = createSession({
          workspaceId: workspace.id,
          prompt: expandValue(action.prompt, variables, env),
          permissionMode: matcher.permissionMode ?? action.permissionMode ?? "safe",
          labels: matcher.labels ?? action.labels ?? [],
          labelConfig: await store.getLabelConfig(),
          statusConfig: await store.getStatusConfig()
        });
        session.llmConnection = action.llmConnection ?? null;
        session.model = action.model ?? null;
        await store.saveSession(session);
        results.push({ type: "prompt", automationKey, sessionId: session.id, session });
      } else if (action.type === "webhook") {
        const request = buildWebhookRequest(action, variables, env);
        const rate = rateLimitDecision({ history: previousHistory, now, action, automationKey });
        if (!rate.allowed) {
          results.push({ type: "webhook", automationKey, request, skipped: true, reason: "rate_limited", rateLimit: rate });
          continue;
        }
        const result = { type: "webhook", automationKey, request, executed: false };
        if (executeWebhooks) {
          result.executed = true;
          result.response = await executeWebhookRequest(request, { fetchImpl });
        }
        results.push(result);
      }
    }
  }

  const history = {
    id: createId("automation"),
    eventType: event.type,
    event,
    resultCount: results.length,
    results,
    createdAt: now.toISOString()
  };
  await store.appendAutomationHistory(history);
  return { results, history };
}

export async function runAutomationSchedulerTick({ store, now = new Date(), env = {}, executeWebhooks = false, fetchImpl = globalThis.fetch } = {}) {
  const timestamp = now.toISOString();
  const event = {
    type: "SchedulerTick",
    scheduledAt: timestamp,
    matchValue: timestamp,
    minute: now.getMinutes(),
    hour: now.getHours(),
    weekday: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()]
  };
  return runAutomations({
    config: await store.getAutomationConfig(),
    event,
    store,
    now,
    env,
    executeWebhooks,
    fetchImpl
  });
}

export class AutomationScheduler {
  constructor({ store, intervalMs = 60000, executeWebhooks = false, env = {}, fetchImpl = globalThis.fetch, onTick = null } = {}) {
    this.store = store;
    this.intervalMs = normalizeSchedulerInterval(intervalMs);
    this.executeWebhooks = executeWebhooks;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.onTick = onTick;
    this.timer = null;
    this.running = false;
    this.tickCount = 0;
    this.lastTickAt = null;
    this.lastResult = null;
    this.lastError = null;
  }

  start({ immediate = false } = {}) {
    if (this.running) return this.status();
    this.running = true;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
    if (immediate) this.tick().catch(() => {});
    return this.status();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    return this.status();
  }

  async tick({ now = new Date() } = {}) {
    try {
      const result = await runAutomationSchedulerTick({
        store: this.store,
        now,
        env: this.env,
        executeWebhooks: this.executeWebhooks,
        fetchImpl: this.fetchImpl
      });
      this.tickCount += 1;
      this.lastTickAt = now.toISOString();
      this.lastResult = result.history;
      this.lastError = null;
      await this.onTick?.(result);
      return result;
    } catch (error) {
      this.lastError = { message: error.message, code: error.code ?? "automation_scheduler_failed", at: new Date().toISOString() };
      throw error;
    }
  }

  status() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      executeWebhooks: this.executeWebhooks,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      lastHistoryId: this.lastResult?.id ?? null,
      lastError: this.lastError
    };
  }
}

export async function executeWebhookRequest(request, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Webhook execution requires fetch");
  const headers = { ...(request.headers ?? {}) };
  const init = { method: request.method, headers };
  if (request.body !== undefined) {
    if (request.bodyFormat === "text") {
      init.body = String(request.body);
    } else {
      if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
      init.body = JSON.stringify(request.body ?? {});
    }
  }
  const response = await fetchImpl(request.url, init);
  const text = request.captureResponse ? await response.text() : "";
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body: request.captureResponse ? text.slice(0, 4000) : undefined
  };
}

export function matchesEvent(matcher, event, now = new Date()) {
  const value = event.matchValue ?? event.label ?? event.newState ?? event.newMode ?? "";
  if (matcher.matcher && !new RegExp(matcher.matcher).test(String(value))) return false;
  if (matcher.condition && !evaluateCondition(matcher.condition, event, now)) return false;
  return true;
}

export function buildVariables({ workspace, event }) {
  const variables = {
    CRAFT_EVENT: event.type,
    CRAFT_EVENT_DATA: JSON.stringify(event),
    CRAFT_WORKSPACE_ID: workspace.id
  };
  if (event.sessionId) variables.CRAFT_SESSION_ID = event.sessionId;
  if (event.sessionName) variables.CRAFT_SESSION_NAME = event.sessionName;
  if (event.label) variables.CRAFT_LABEL = event.label;
  if (event.oldMode) variables.CRAFT_OLD_MODE = event.oldMode;
  if (event.newMode) variables.CRAFT_NEW_MODE = event.newMode;
  if (event.isFlagged !== undefined) variables.CRAFT_IS_FLAGGED = String(event.isFlagged);
  if (event.oldState) variables.CRAFT_OLD_STATE = event.oldState;
  if (event.newState) variables.CRAFT_NEW_STATE = event.newState;
  return variables;
}

export function expandValue(value, variables, env = {}) {
  if (typeof value === "string") return expandString(value, variables, env);
  if (Array.isArray(value)) return value.map((item) => expandValue(item, variables, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandValue(item, variables, env)]));
  }
  return value;
}

function buildWebhookRequest(action, variables, env) {
  const url = expandString(action.url, variables, env);
  assertHttpUrl(url);
  const method = (action.method ?? "POST").toUpperCase();
  return {
    url,
    method,
    headers: expandValue(action.headers ?? {}, variables, env),
    bodyFormat: action.bodyFormat ?? "json",
    body: method === "GET" ? undefined : expandValue(action.body, variables, env),
    captureResponse: action.captureResponse === true
  };
}

function rateLimitDecision({ history, now, action, automationKey }) {
  const limit = action.rateLimit;
  if (!limit) return { allowed: true };
  const count = Number(limit.count);
  const windowMs = Number(limit.windowMs);
  const since = now.getTime() - windowMs;
  const used = history.filter((item) => {
    const createdAt = Date.parse(item.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < since) return false;
    return (item.results ?? []).some((result) => result.automationKey === automationKey && !result.skipped);
  }).length;
  return { allowed: used < count, count, windowMs, used, remaining: Math.max(0, count - used) };
}

function validRateLimit(rateLimit) {
  return Number.isInteger(Number(rateLimit.count)) && Number(rateLimit.count) > 0 && Number(rateLimit.windowMs) > 0;
}

function normalizeSchedulerInterval(intervalMs) {
  const value = Number(intervalMs);
  if (!Number.isFinite(value)) return 60000;
  return Math.max(1000, Math.trunc(value));
}

function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function expandString(text, variables, env) {
  return text.replace(/\$\{?([A-Z][A-Z0-9_]*)\}?/g, (match, key) => {
    if (key.startsWith("CRAFT_WH_")) return env[key] ?? "";
    if (key.startsWith("CRAFT_")) return variables[key] ?? "";
    return match;
  });
}

function validateCondition(condition, depth = 1) {
  if (depth > 8) return false;
  if (["and", "or", "not"].includes(condition.condition)) {
    return Array.isArray(condition.conditions) && condition.conditions.every((item) => validateCondition(item, depth + 1));
  }
  return ["state", "time"].includes(condition.condition);
}

function evaluateCondition(condition, event, now) {
  if (condition.condition === "and") return condition.conditions.every((item) => evaluateCondition(item, event, now));
  if (condition.condition === "or") return condition.conditions.some((item) => evaluateCondition(item, event, now));
  if (condition.condition === "not") return !condition.conditions.some((item) => evaluateCondition(item, event, now));
  if (condition.condition === "state") return evaluateStateCondition(condition, event);
  if (condition.condition === "time") return evaluateTimeCondition(condition, now);
  return false;
}

function evaluateStateCondition(condition, event) {
  const field = transitionField(condition.field);
  const current = event[field] ?? event[condition.field];
  if ("value" in condition && current !== condition.value) return false;
  if ("not_value" in condition && current === condition.not_value) return false;
  if ("from" in condition && event.oldState !== condition.from && event.oldMode !== condition.from) return false;
  if ("to" in condition && event.newState !== condition.to && event.newMode !== condition.to) return false;
  if ("contains" in condition && (!Array.isArray(current) || !current.includes(condition.contains))) return false;
  return true;
}

function transitionField(field) {
  if (field === "sessionStatus") return "newState";
  if (field === "permissionMode") return "newMode";
  return field;
}

function evaluateTimeCondition(condition, now) {
  const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()];
  if (condition.weekday && !condition.weekday.includes(day)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (condition.after || condition.before) {
    const after = condition.after ? parseTime(condition.after) : 0;
    const before = condition.before ? parseTime(condition.before) : 24 * 60;
    if (after <= before && (minutes < after || minutes >= before)) return false;
    if (after > before && minutes < after && minutes >= before) return false;
  }
  return true;
}

function parseTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function assertHttpUrl(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Webhook URL must use http or https: ${url}`);
  }
}
