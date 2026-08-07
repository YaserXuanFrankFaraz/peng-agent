import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { promisify } from "node:util";
import { createCredentialRecord } from "./credentials.js";

const execFileAsync = promisify(execFile);

export function buildOAuthAuthorizationUrl(source, { state, codeChallenge, redirectUri } = {}) {
  const oauth = source.oauth ?? source.mcp?.oauth ?? source.api?.oauth;
  if (!oauth?.authorizationUrl) throw new Error(`OAuth source missing authorizationUrl: ${source.slug}`);
  const url = new URL(oauth.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oauth.clientId);
  if (redirectUri ?? oauth.redirectUri) url.searchParams.set("redirect_uri", redirectUri ?? oauth.redirectUri);
  if (oauth.scope) url.searchParams.set("scope", Array.isArray(oauth.scope) ? oauth.scope.join(" ") : oauth.scope);
  if (state) url.searchParams.set("state", state);
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", oauth.codeChallengeMethod ?? "S256");
  }
  for (const [key, value] of Object.entries(oauth.extraAuthParams ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

export function generateOAuthState({ bytes = 16 } = {}) {
  return randomBytes(bytes).toString("base64url");
}

export function generateOAuthPkcePair({ bytes = 32 } = {}) {
  const codeVerifier = randomBytes(bytes).toString("base64url");
  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    codeChallengeMethod: "S256"
  };
}

export function createOAuthAuthorizationRequest(source, { state, generateState = false, pkce = false, codeChallenge, codeVerifier, redirectUri } = {}) {
  const nextState = generateState || state === true || state === "auto" ? generateOAuthState() : state;
  const generatedPkce = pkce && (!codeChallenge || !codeVerifier) ? generateOAuthPkcePair() : null;
  const nextCodeChallenge = codeChallenge ?? generatedPkce?.codeChallenge;
  const nextCodeVerifier = codeVerifier ?? generatedPkce?.codeVerifier;
  return {
    url: buildOAuthAuthorizationUrl(source, { state: nextState, codeChallenge: nextCodeChallenge, redirectUri }),
    state: nextState ?? null,
    codeChallenge: nextCodeChallenge ?? null,
    codeVerifier: nextCodeVerifier ?? null,
    redirectUri: redirectUri ?? (source.oauth ?? source.mcp?.oauth ?? source.api?.oauth)?.redirectUri ?? null
  };
}

export async function openOAuthAuthorizationUrl(url, { platform = process.platform, execFileImpl = execFileAsync } = {}) {
  const command = openCommandForPlatform(platform, url);
  await execFileImpl(command.file, command.args);
  return command;
}

export async function startOAuthDeviceFlow({ source, fetchImpl = globalThis.fetch }) {
  const oauth = source.oauth ?? source.mcp?.oauth ?? source.api?.oauth;
  if (!oauth?.deviceAuthorizationUrl) throw new Error(`OAuth source missing deviceAuthorizationUrl: ${source.slug}`);
  const payload = {
    client_id: oauth.clientId,
    scope: Array.isArray(oauth.scope) ? oauth.scope.join(" ") : oauth.scope,
    ...(oauth.extraDeviceParams ?? {})
  };
  return postForm({ url: oauth.deviceAuthorizationUrl, payload, fetchImpl });
}

export async function exchangeOAuthCode({ source, code, codeVerifier, redirectUri, fetchImpl = globalThis.fetch }) {
  const oauth = source.oauth ?? source.mcp?.oauth ?? source.api?.oauth;
  if (!oauth?.tokenUrl) throw new Error(`OAuth source missing tokenUrl: ${source.slug}`);
  const payload = {
    grant_type: "authorization_code",
    code,
    client_id: oauth.clientId,
    redirect_uri: redirectUri ?? oauth.redirectUri,
    code_verifier: codeVerifier
  };
  return credentialFromTokenResponse(source, await postForm({ url: oauth.tokenUrl, payload, fetchImpl }));
}

export async function exchangeOAuthDeviceCode({ source, deviceCode, fetchImpl = globalThis.fetch }) {
  const oauth = source.oauth ?? source.mcp?.oauth ?? source.api?.oauth;
  if (!oauth?.tokenUrl) throw new Error(`OAuth source missing tokenUrl: ${source.slug}`);
  const payload = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: oauth.clientId
  };
  return credentialFromTokenResponse(source, await postForm({ url: oauth.tokenUrl, payload, fetchImpl }));
}

export async function pollOAuthDeviceCode({
  source,
  deviceCode,
  fetchImpl = globalThis.fetch,
  intervalSecs = 5,
  expiresIn = 600,
  maxAttempts,
  sleep = defaultSleep
}) {
  let attempts = 0;
  let delayMs = Math.max(0, Number(intervalSecs) * 1000);
  const deadline = Date.now() + Math.max(0, Number(expiresIn) * 1000);
  while (Date.now() <= deadline && (maxAttempts === undefined || attempts < Number(maxAttempts))) {
    attempts += 1;
    try {
      return await exchangeOAuthDeviceCode({ source, deviceCode, fetchImpl });
    } catch (error) {
      if (error.oauthError === "authorization_pending") {
        await sleep(delayMs);
        continue;
      }
      if (error.oauthError === "slow_down") {
        delayMs += 5000;
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  const error = new Error("OAuth device authorization timed out.");
  error.code = "oauth_device_timeout";
  throw error;
}

export async function refreshOAuthCredential({ source, credential, fetchImpl = globalThis.fetch }) {
  const oauth = source.oauth ?? source.mcp?.oauth ?? source.api?.oauth;
  if (!oauth?.tokenUrl) throw new Error(`OAuth source missing tokenUrl: ${source.slug}`);
  if (!credential?.refreshToken) throw new Error(`Missing OAuth refresh token for source: ${source.slug}`);
  const payload = {
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
    client_id: oauth.clientId
  };
  return credentialFromTokenResponse(source, await postForm({ url: oauth.tokenUrl, payload, fetchImpl }), credential);
}

export function credentialFromTokenResponse(source, token, previous = null) {
  if (!token.access_token) throw new Error("OAuth token response missing access_token.");
  const expiresAt = token.expires_in
    ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
    : previous?.expiresAt ?? null;
  return createCredentialRecord({
    sourceSlug: source.slug,
    provider: source.provider,
    mode: "oauth",
    value: token.access_token,
    refreshToken: token.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt
  });
}

export async function createOAuthCallbackServer({
  host = "127.0.0.1",
  port = 0,
  path = "/callback",
  expectedState,
  timeoutMs = 120000
} = {}) {
  let server;
  let settled = false;
  let timer;
  let resolveCallback;
  let rejectCallback;
  const waitForCallback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const close = () => closeServer(server, timer);
  const settle = async (handler, value) => {
    if (settled) return;
    settled = true;
    handler(value);
    await close();
  };

  server = http.createServer((request, response) => {
    const base = `http://${host}:${server.address()?.port ?? port}`;
    const requestUrl = new URL(request.url, base);
    if (requestUrl.pathname !== path) {
      respondCallback(response, 404, "OAuth callback path not found.");
      return;
    }

    const state = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");
    const providerError = requestUrl.searchParams.get("error");
    if (providerError) {
      respondCallback(response, 400, "OAuth authorization failed. You can close this window.");
      const error = new Error(`OAuth authorization failed: ${providerError}`);
      error.oauthError = providerError;
      void settle(rejectCallback, error);
      return;
    }
    if (expectedState && state !== expectedState) {
      respondCallback(response, 400, "OAuth state mismatch. You can close this window.");
      const error = new Error("OAuth state mismatch.");
      error.code = "oauth_state_mismatch";
      void settle(rejectCallback, error);
      return;
    }
    if (!code) {
      respondCallback(response, 400, "OAuth callback missing code. You can close this window.");
      const error = new Error("OAuth callback missing code.");
      error.code = "oauth_missing_code";
      void settle(rejectCallback, error);
      return;
    }

    respondCallback(response, 200, "OAuth authorization complete. You can close this window.");
    void settle(resolveCallback, {
      code,
      state,
      url: requestUrl.toString()
    });
  });

  waitForCallback.catch(() => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  timer = setTimeout(() => {
    const error = new Error("OAuth callback timed out.");
    error.code = "oauth_callback_timeout";
    void settle(rejectCallback, error);
  }, timeoutMs);
  timer.unref?.();

  return {
    redirectUri: `http://${host}:${server.address().port}${path}`,
    waitForCallback,
    close
  };
}

async function postForm({ url, payload, fetchImpl }) {
  if (!fetchImpl) throw new Error("No fetch implementation available for OAuth.");
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`OAuth request failed: ${response.status} ${parsed.error ?? text}`);
    error.status = response.status;
    error.oauthError = parsed.error;
    error.oauthPayload = parsed;
    throw error;
  }
  return parsed;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function respondCallback(response, status, text) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

function closeServer(server, timer) {
  if (timer) clearTimeout(timer);
  return new Promise((resolve, reject) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function openCommandForPlatform(platform, url) {
  if (platform === "darwin") return { file: "open", args: [url] };
  if (platform === "win32") return { file: "cmd", args: ["/c", "start", "", url] };
  return { file: "xdg-open", args: [url] };
}
