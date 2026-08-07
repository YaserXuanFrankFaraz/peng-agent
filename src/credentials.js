import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createCredentialRecord({
  sourceSlug,
  provider,
  mode,
  value,
  expiresAt = null,
  refreshToken = null,
  createdAt = new Date().toISOString()
}) {
  if (!sourceSlug) throw new Error("Credential requires sourceSlug.");
  if (!mode) throw new Error("Credential requires mode.");
  return {
    sourceSlug,
    provider: provider ?? sourceSlug,
    mode,
    value,
    refreshToken,
    expiresAt,
    createdAt,
    updatedAt: createdAt
  };
}

export function summarizeCredential(record) {
  if (!record) return null;
  return {
    sourceSlug: record.sourceSlug,
    provider: record.provider,
    mode: record.mode,
    hasSecret: hasSecretValue(record.value) || Boolean(record.secretRef),
    hasRefreshToken: hasSecretValue(record.refreshToken) || Boolean(record.refreshTokenRef),
    expiresAt: record.expiresAt ?? null,
    expired: isCredentialExpired(record),
    updatedAt: record.updatedAt
  };
}

export function credentialRestartSignature(record) {
  if (!record) return null;
  return sha256({
    sourceSlug: record.sourceSlug,
    provider: record.provider,
    mode: record.mode,
    valueHash: secretHash(record.value),
    refreshTokenHash: secretHash(record.refreshToken),
    secretRef: record.secretRef ? stableSecretRef(record.secretRef) : null,
    refreshTokenRef: record.refreshTokenRef ? stableSecretRef(record.refreshTokenRef) : null,
    expiresAt: record.expiresAt ?? null,
    updatedAt: record.updatedAt ?? null
  });
}

function hasSecretValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function applyApiAuth({ url, headers = {}, source, credential }) {
  const api = source.api ?? {};
  const authType = api.authType ?? "none";
  const nextUrl = new URL(url);
  const nextHeaders = { ...headers };
  const value = credential?.value;

  if (authType === "none") return { url: nextUrl.toString(), headers: nextHeaders };
  if (!credential || value === undefined || value === null || value === "") {
    throw new Error(`Missing credential for source: ${source.slug}`);
  }
  if (authType === "bearer" || authType === "oauth") {
    nextHeaders.authorization = `${api.authScheme ?? "Bearer"} ${String(value)}`;
  } else if (authType === "header") {
    if (Array.isArray(api.headerNames)) {
      const values = typeof value === "object" ? value : JSON.parse(String(value));
      for (const headerName of api.headerNames) nextHeaders[headerName] = values[headerName];
    } else {
      nextHeaders[api.headerName ?? "Authorization"] = String(value);
    }
  } else if (authType === "query") {
    nextUrl.searchParams.set(api.queryParam ?? "api_key", String(value));
  } else if (authType === "basic") {
    const pair = typeof value === "object" ? value : JSON.parse(String(value));
    const username = pair.username ?? "";
    const password = pair.password ?? "";
    nextHeaders.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  return { url: nextUrl.toString(), headers: nextHeaders };
}

export function credentialPromptSpec(source) {
  const api = source.api ?? source.mcp ?? {};
  const authType = api.authType ?? "none";
  if (authType === "none") return { required: false, mode: "none", fields: [] };
  if (authType === "oauth") {
    return {
      required: true,
      mode: "oauth",
      authorizationUrl: api.oauth?.authorizationUrl ?? api.authorizationUrl ?? null,
      deviceAuthorizationUrl: api.oauth?.deviceAuthorizationUrl ?? api.deviceAuthorizationUrl ?? null,
      tokenUrl: api.oauth?.tokenUrl ?? api.tokenUrl ?? null,
      fields: [{ name: "token", secret: true }]
    };
  }
  if (authType === "header" && Array.isArray(api.headerNames)) {
    return { required: true, mode: "multi-header", fields: api.headerNames.map((name) => ({ name, secret: true })) };
  }
  if (authType === "basic") {
    return {
      required: true,
      mode: "basic",
      fields: [
        { name: "username", secret: false },
        { name: "password", secret: true, optional: api.passwordRequired === false }
      ]
    };
  }
  return { required: true, mode: authType, fields: [{ name: authType === "query" ? api.queryParam ?? "api_key" : "token", secret: true }] };
}

export function credentialFromPromptInput(source, input = {}) {
  const spec = credentialPromptSpec(source);
  if (!spec.required) {
    return createCredentialRecord({
      sourceSlug: source.slug,
      provider: source.provider,
      mode: "none",
      value: ""
    });
  }
  const fields = input.fields ?? input;
  const values = {};
  for (const field of spec.fields) {
    const value = fields[field.name];
    if (!field.optional && !hasSecretValue(value)) {
      throw new Error(`Missing credential field: ${field.name}`);
    }
    if (hasSecretValue(value)) values[field.name] = value;
  }

  let value;
  if (spec.mode === "multi-header") {
    value = values;
  } else if (spec.mode === "basic") {
    value = {
      username: values.username ?? "",
      password: values.password ?? ""
    };
  } else {
    value = values[spec.fields[0]?.name] ?? input.value;
  }
  if (spec.required && !hasSecretValue(value) && typeof value !== "object") {
    throw new Error("Credential value is required.");
  }
  return createCredentialRecord({
    sourceSlug: source.slug,
    provider: source.provider,
    mode: spec.mode,
    value,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt
  });
}

export function sourceAuthState(source, credential) {
  const spec = credentialPromptSpec(source);
  if (!source.enabled && source.enabled !== undefined) return { isAuthenticated: false, connectionStatus: "disabled", auth: spec };
  if (!spec.required) return { isAuthenticated: true, connectionStatus: source.connectionStatus ?? "untested", auth: spec };
  if (!credential) return { isAuthenticated: false, connectionStatus: "needs_auth", auth: spec };
  if (isCredentialExpired(credential) && credential.refreshToken) {
    return { isAuthenticated: true, connectionStatus: "token_expired_refreshable", auth: spec };
  }
  if (isCredentialExpired(credential)) return { isAuthenticated: false, connectionStatus: "needs_auth", auth: spec };
  return { isAuthenticated: true, connectionStatus: source.connectionStatus ?? "untested", auth: spec };
}

export function isCredentialExpired(record, now = Date.now()) {
  if (!record?.expiresAt) return false;
  return Date.parse(record.expiresAt) <= now;
}

export function shouldRenewCredential(record, now = Date.now(), skewMs = 5 * 60 * 1000) {
  if (!record?.expiresAt || !record.refreshToken) return false;
  return Date.parse(record.expiresAt) - now <= skewMs;
}

export async function renewApiCredential({ source, credential, fetchImpl = globalThis.fetch }) {
  const endpoint = source.api?.renewEndpoint;
  if (!endpoint) return credential;
  if (!credential?.value) throw new Error(`Missing credential for source: ${source.slug}`);
  if (!fetchImpl) throw new Error("No fetch implementation available for credential renewal.");

  const url = resolveEndpointUrl(source.api.baseUrl, endpoint.path);
  const headers = substituteToken(endpoint.headers ?? {}, credential.value);
  const body = endpoint.body === undefined ? undefined : substituteToken(endpoint.body, credential.value);
  const auth = applyApiAuth({ url, headers, source, credential });
  const response = await fetchImpl(auth.url, {
    method: endpoint.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...auth.headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Credential renewal failed: ${response.status}`);
  }

  const payload = await response.json();
  const tokenField = endpoint.tokenField ?? "access_token";
  const expiresInField = endpoint.expiresInField ?? "expires_in";
  const token = payload[tokenField];
  if (!token) throw new Error(`Credential renewal response missing ${tokenField}.`);
  const ttlSecs = Number(payload[expiresInField] ?? endpoint.fallbackTtlSecs ?? 0);
  return {
    ...credential,
    value: token,
    expiresAt: ttlSecs > 0 ? new Date(Date.now() + ttlSecs * 1000).toISOString() : credential.expiresAt,
    updatedAt: new Date().toISOString()
  };
}

export async function atomicWriteJson(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export async function backupUnreadableFile(file) {
  const backup = `${file}.unreadable-${Date.now()}.bak`;
  await rename(file, backup);
  return backup;
}

export function credentialFile(root) {
  return path.join(root, "credentials.json");
}

function resolveEndpointUrl(baseUrl, endpointPath) {
  try {
    return new URL(endpointPath).toString();
  } catch {
    return new URL(endpointPath, baseUrl).toString();
  }
}

function substituteToken(value, token) {
  if (typeof value === "string") return value.replaceAll("{{token}}", token);
  if (Array.isArray(value)) return value.map((item) => substituteToken(item, token));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteToken(entry, token)]));
  }
  return value;
}

function secretHash(value) {
  if (!hasSecretValue(value)) return null;
  return sha256(value);
}

function sha256(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableSecretRef(ref) {
  return Object.fromEntries(Object.entries(ref).sort(([a], [b]) => a.localeCompare(b)));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
