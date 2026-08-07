import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { applyApiAuth, atomicWriteJson, credentialRestartSignature, renewApiCredential, shouldRenewCredential, sourceAuthState } from "./credentials.js";
import { summarizeMcpTools, withMcpClient } from "./mcp.js";
import { buildOAuthAuthorizationUrl, createOAuthAuthorizationRequest, exchangeOAuthCode, exchangeOAuthDeviceCode, pollOAuthDeviceCode, refreshOAuthCredential, startOAuthDeviceFlow } from "./oauth.js";
import { evaluateSourcePermission } from "./permissions.js";

export async function discoverSources({ workspace, home = process.env.HOME, workspaceId, store }) {
  const roots = [
    path.join(workspace, ".craft-agent", "sources"),
    home && workspaceId ? path.join(home, ".craft-agent", "workspaces", workspaceId, "sources") : null
  ].filter(Boolean);
  const sources = [];

  for (const root of roots) {
    for (const slug of await readDirNames(root)) {
      const source = await readSource(path.join(root, slug));
      if (source && store) {
        const credential = await store.getCredential(source.slug);
        Object.assign(source, sourceAuthState(source, credential));
      }
      if (source) sources.push(source);
    }
  }
  return dedupeBySlug(sources);
}

export async function readSource(sourceDir) {
  try {
    const config = JSON.parse(await readFile(path.join(sourceDir, "config.json"), "utf8"));
    let guide = null;
    let permissions = null;
    try {
      guide = await readFile(path.join(sourceDir, "guide.md"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      permissions = JSON.parse(await readFile(path.join(sourceDir, "permissions.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      ...config,
      path: sourceDir,
      guide,
      permissions,
      validation: validateSourceConfig(config)
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function testSource({ source, store, fetchImpl = globalThis.fetch }) {
  if (!source) throw new Error("Source is required.");
  if (!source.validation?.ok) {
    return persistSourceStatus(source, {
      connectionStatus: "failed",
      isAuthenticated: false,
      connectionError: source.validation?.issues?.join("; ") || "invalid source config"
    });
  }

  let credential = store ? await store.getCredential(source.slug) : null;
  if (credential?.mode === "oauth" && credential.refreshToken && shouldRenewCredential(credential)) {
    credential = await refreshOAuthCredential({ source, credential, fetchImpl });
    if (store) await store.saveCredential(credential);
  }
  const authState = sourceAuthState(source, credential);
  if (authState.connectionStatus === "needs_auth") {
    return persistSourceStatus(source, {
      connectionStatus: "needs_auth",
      isAuthenticated: false,
      connectionError: "Authentication required"
    });
  }

  let result;
  if (source.type === "local") result = await testLocalSource(source);
  else if (source.type === "api") result = await testApiSource({ source, credential, store, fetchImpl });
  else if (source.type === "mcp") result = await testMcpSource({ source, authState, store, fetchImpl });
  else result = await persistSourceStatus(source, { connectionStatus: "failed", isAuthenticated: false, connectionError: `Unsupported source type: ${source.type}` });

  if (result.connectionStatus === "connected" || result.connectionStatus === "needs_auth") {
    const icon = await cacheSourceIcon({ source, fetchImpl }).catch((error) => ({ iconError: error.message }));
    if (icon?.icon || icon?.iconError) {
      const current = await readSource(source.path);
      const next = await persistSourceStatus(current, {
        connectionStatus: result.connectionStatus,
        isAuthenticated: result.isAuthenticated,
        connectionError: result.connectionError,
        icon: icon.icon,
        iconError: icon.iconError
      });
      return next;
    }
  }
  return result;
}

export async function executeApiSourceRequest({ source, endpointPath, method = "GET", body, headers, store, fetchImpl = globalThis.fetch }) {
  if (source.type !== "api") throw new Error(`Source is not an API source: ${source.slug}`);
  if (!fetchImpl) throw new Error("No fetch implementation available for source request.");
  let credential = store ? await store.getCredential(source.slug) : null;
  if (credential && shouldRenewCredential(credential) && source.api?.renewEndpoint) {
    credential = await renewApiCredential({ source, credential, fetchImpl });
    if (store) await store.saveCredential(credential);
  }
  const url = resolveEndpointUrl(source.api.baseUrl, endpointPath);
  const authed = applyApiAuth({ url, headers, source, credential });
  const response = await fetchImpl(authed.url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...authed.headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    url: authed.url,
    headers: redactAuthHeaders(authed.headers),
    body: parseMaybeJson(text)
  };
}

export async function listMcpSourceTools({ source, store, timeoutMs, fetchImpl }) {
  return withMcpClient(source, async (client) => summarizeMcpTools(await client.listTools()), {
    timeoutMs,
    credential: store ? await store.getCredential(source.slug) : null,
    fetchImpl
  });
}

export async function callMcpSourceTool({ source, name, arguments: args = {}, store, timeoutMs, mode = "safe", fetchImpl }) {
  const permission = evaluateSourcePermission({ source, kind: "mcp", value: name, mode });
  if (permission.decision !== "allow") {
    const error = new Error(`MCP tool denied: ${permission.reason}`);
    error.code = "permission_denied";
    error.permission = permission;
    throw error;
  }
  return withMcpClient(source, (client) => client.callTool(name, args), {
    timeoutMs,
    credential: store ? await store.getCredential(source.slug) : null,
    fetchImpl
  });
}

export async function getSourceRuntimeSignature({ source, store }) {
  const credential = store ? await store.getCredential(source.slug) : null;
  const configSignature = sha256(sourceRestartConfig(source));
  const credentialSignature = credentialRestartSignature(credential);
  return {
    sourceSlug: source.slug,
    signature: sha256({
      sourceSlug: source.slug,
      configSignature,
      credentialSignature
    }),
    configSignature,
    credentialSignature,
    credentialUpdatedAt: credential?.updatedAt ?? null,
    sourceUpdatedAt: source.updatedAt ?? null,
    requiresAuth: sourceAuthState(source, credential).auth.required
  };
}

export function getSourceOAuthAuthorizationUrl({ source, state, codeChallenge, redirectUri }) {
  return buildOAuthAuthorizationUrl(source, { state, codeChallenge, redirectUri });
}

export function createSourceOAuthAuthorizationRequest({ source, state, generateState, pkce, codeChallenge, codeVerifier, redirectUri }) {
  return createOAuthAuthorizationRequest(source, { state, generateState, pkce, codeChallenge, codeVerifier, redirectUri });
}

export function startSourceOAuthDeviceFlow({ source, fetchImpl = globalThis.fetch }) {
  return startOAuthDeviceFlow({ source, fetchImpl });
}

export async function exchangeSourceOAuthCode({ source, code, codeVerifier, redirectUri, store, fetchImpl = globalThis.fetch }) {
  const credential = await exchangeOAuthCode({ source, code, codeVerifier, redirectUri, fetchImpl });
  if (store) await store.saveCredential(credential);
  return credential;
}

export async function exchangeSourceOAuthDeviceCode({ source, deviceCode, store, fetchImpl = globalThis.fetch }) {
  const credential = await exchangeOAuthDeviceCode({ source, deviceCode, fetchImpl });
  if (store) await store.saveCredential(credential);
  return credential;
}

export async function pollSourceOAuthDeviceCode({ source, deviceCode, intervalSecs, expiresIn, maxAttempts, store, fetchImpl = globalThis.fetch, sleep }) {
  const credential = await pollOAuthDeviceCode({ source, deviceCode, intervalSecs, expiresIn, maxAttempts, fetchImpl, sleep });
  if (store) await store.saveCredential(credential);
  return credential;
}

export async function refreshSourceOAuthCredential({ source, store, fetchImpl = globalThis.fetch }) {
  const current = store ? await store.getCredential(source.slug) : null;
  const credential = await refreshOAuthCredential({ source, credential: current, fetchImpl });
  if (store) await store.saveCredential(credential);
  return credential;
}

export async function cacheSourceIcon({ source, fetchImpl = globalThis.fetch, maxBytes = 256 * 1024 }) {
  const iconUrl = resolveSourceIconUrl(source);
  if (!iconUrl) return { icon: source.icon ?? null, skipped: true };
  if (!fetchImpl) throw new Error("No fetch implementation available for source icon download.");
  const response = await fetchImpl(iconUrl, { headers: { accept: "image/*,*/*;q=0.8" } });
  if (!response.ok) throw new Error(`Source icon download failed: HTTP ${response.status}`);
  const contentType = response.headers?.get?.("content-type") ?? "application/octet-stream";
  if (!contentType.startsWith("image/") && !iconUrl.endsWith(".svg")) {
    throw new Error(`Source icon response is not an image: ${contentType}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Source icon exceeds ${maxBytes} bytes.`);
  const fileName = `icon${extensionForIcon({ contentType, url: iconUrl })}`;
  await mkdir(source.path, { recursive: true });
  await writeFile(path.join(source.path, fileName), bytes);
  const icon = {
    ...(typeof source.icon === "object" && source.icon ? source.icon : {}),
    url: iconUrl,
    cachedPath: fileName,
    contentType,
    bytes: bytes.length,
    fetchedAt: new Date().toISOString()
  };
  await persistSourceStatus(source, {
    connectionStatus: source.connectionStatus ?? "untested",
    isAuthenticated: source.isAuthenticated ?? false,
    connectionError: source.connectionError ?? null,
    icon,
    iconError: null,
    preserveLastTestedAt: true
  });
  return { icon };
}

export async function persistSourceStatus(source, { connectionStatus, isAuthenticated, connectionError = null, icon = source.icon, iconError = source.iconError, preserveLastTestedAt = false }) {
  const next = {
    ...source,
    icon,
    iconError,
    connectionStatus,
    isAuthenticated,
    connectionError,
    lastTestedAt: preserveLastTestedAt ? source.lastTestedAt : Date.now(),
    updatedAt: Date.now()
  };
  if (next.icon === undefined) delete next.icon;
  if (next.iconError === undefined || next.iconError === null) delete next.iconError;
  delete next.path;
  delete next.guide;
  delete next.permissions;
  delete next.validation;
  delete next.auth;
  await atomicWriteJson(path.join(source.path, "config.json"), next);
  return {
    sourceSlug: source.slug,
    connectionStatus,
    isAuthenticated,
    connectionError,
    icon: next.icon ?? null,
    iconError: next.iconError ?? null,
    lastTestedAt: next.lastTestedAt
  };
}

export function validateSourceConfig(config) {
  const issues = [];
  if (!config.id) issues.push("missing id");
  if (!isSlug(config.slug)) issues.push(`invalid slug: ${config.slug}`);
  if (!config.name) issues.push("missing name");
  if (!["mcp", "api", "local"].includes(config.type)) issues.push(`invalid type: ${config.type}`);
  if (!config.provider) issues.push("missing provider");
  if (config.type === "mcp") validateMcp(config, issues);
  if (config.type === "api") validateApi(config, issues);
  if (config.type === "local" && !config.local?.path) issues.push("local source requires local.path");
  return { ok: issues.length === 0, issues };
}

function validateMcp(config, issues) {
  if (!config.mcp) {
    issues.push("mcp source requires mcp config");
    return;
  }
  if (config.mcp.transport === "stdio") {
    if (!config.mcp.command) issues.push("stdio MCP source requires command");
  } else if (!config.mcp.url) {
    issues.push("HTTP MCP source requires url");
  }
  if (!["oauth", "bearer", "none", undefined].includes(config.mcp.authType)) {
    issues.push(`invalid MCP authType: ${config.mcp.authType}`);
  }
}

function validateApi(config, issues) {
  if (!config.api?.baseUrl) {
    issues.push("api source requires api.baseUrl");
    return;
  }
  if (!config.api.baseUrl.endsWith("/")) issues.push("api.baseUrl must have trailing slash");
  if (!["bearer", "header", "query", "basic", "oauth", "none", undefined].includes(config.api.authType)) {
    issues.push(`invalid API authType: ${config.api.authType}`);
  }
  if (config.api.authType && config.api.authType !== "none" && !config.api.testEndpoint) {
    issues.push("authenticated API source requires api.testEndpoint");
  }
  if (config.api.authType === "header" && !config.api.headerName && !Array.isArray(config.api.headerNames)) {
    issues.push("header auth requires api.headerName or api.headerNames");
  }
  if (config.api.authType === "query" && !config.api.queryParam) {
    issues.push("query auth requires api.queryParam");
  }
  if (config.api.testEndpoint?.path?.startsWith("/")) {
    issues.push("api.testEndpoint.path must not start with /");
  }
}

async function testLocalSource(source) {
  try {
    const info = await stat(source.local.path);
    return persistSourceStatus(source, {
      connectionStatus: info.isDirectory() ? "connected" : "failed",
      isAuthenticated: info.isDirectory(),
      connectionError: info.isDirectory() ? null : "Local path is not a directory"
    });
  } catch (error) {
    return persistSourceStatus(source, {
      connectionStatus: "failed",
      isAuthenticated: false,
      connectionError: error.code ?? error.message
    });
  }
}

async function testApiSource({ source, credential, store, fetchImpl }) {
  const endpoint = source.api.authType === "none"
    ? source.api.testEndpoint ?? { method: "GET", path: "" }
    : source.api.testEndpoint;
  try {
    const result = await executeApiSourceRequest({
      source,
      endpointPath: endpoint.path,
      method: endpoint.method ?? "GET",
      body: endpoint.body,
      store,
      fetchImpl
    });
    return persistSourceStatus(source, {
      connectionStatus: result.ok ? "connected" : result.status === 401 || result.status === 403 ? "needs_auth" : "failed",
      isAuthenticated: result.ok,
      connectionError: result.ok ? null : `HTTP ${result.status}`
    });
  } catch (error) {
    if (!credential && source.api.authType !== "none") {
      return persistSourceStatus(source, { connectionStatus: "needs_auth", isAuthenticated: false, connectionError: "Authentication required" });
    }
    return persistSourceStatus(source, { connectionStatus: "failed", isAuthenticated: false, connectionError: error.message });
  }
}

async function testMcpSource({ source, authState, store, fetchImpl }) {
  if (authState.connectionStatus === "needs_auth") {
    return persistSourceStatus(source, { connectionStatus: "needs_auth", isAuthenticated: false, connectionError: "Authentication required" });
  }
  if (source.mcp.transport === "stdio" || source.mcp.url) {
    try {
      await listMcpSourceTools({ source, store, fetchImpl });
      return persistSourceStatus(source, {
        connectionStatus: "connected",
        isAuthenticated: authState.isAuthenticated,
        connectionError: null
      });
    } catch (error) {
      return persistSourceStatus(source, {
        connectionStatus: "failed",
        isAuthenticated: false,
        connectionError: error.message
      });
    }
  }
  return persistSourceStatus(source, { connectionStatus: "failed", isAuthenticated: false, connectionError: "Unsupported MCP transport" });
}

function resolveEndpointUrl(baseUrl, endpointPath = "") {
  try {
    return new URL(endpointPath).toString();
  } catch {
    return new URL(endpointPath, baseUrl).toString();
  }
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactAuthHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [
    key,
    key.toLowerCase() === "authorization" || /key|token|secret/i.test(key) ? "[REDACTED]" : value
  ]));
}

function resolveSourceIconUrl(source) {
  if (typeof source.iconUrl === "string") return source.iconUrl;
  if (typeof source.icon === "string" && /^https?:\/\//.test(source.icon)) return source.icon;
  if (typeof source.icon === "object" && source.icon?.url) return source.icon.url;
  if (source.api?.iconUrl) return source.api.iconUrl;
  if (source.mcp?.iconUrl) return source.mcp.iconUrl;
  return null;
}

function extensionForIcon({ contentType, url }) {
  const pathname = new URL(url).pathname;
  const ext = path.extname(pathname).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".ico"].includes(ext)) return ext;
  if (contentType.includes("svg")) return ".svg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("icon")) return ".ico";
  return ".bin";
}

function sourceRestartConfig(source) {
  return {
    slug: source.slug,
    provider: source.provider,
    type: source.type,
    enabled: source.enabled,
    api: restartRelevantObject(source.api),
    mcp: restartRelevantObject(source.mcp),
    local: restartRelevantObject(source.local),
    oauth: restartRelevantObject(source.oauth),
    permissions: restartRelevantObject(source.permissions)
  };
}

function restartRelevantObject(value) {
  if (!value || typeof value !== "object") return value ?? null;
  const ignored = new Set(["iconUrl", "oauth", "guide", "description"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)));
}

function sha256(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

function dedupeBySlug(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    if (seen.has(source.slug)) return false;
    seen.add(source.slug);
    return true;
  });
}

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
