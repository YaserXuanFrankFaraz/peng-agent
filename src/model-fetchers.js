export function createModelFetcher({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async list(url, options = {}) {
      return fetchModels({ url, fetchImpl, ...options });
    },
    async listForProvider(provider, options = {}) {
      return fetchProviderModels({ provider, fetchImpl, ...options });
    }
  };
}

export async function fetchProviderModels({ provider, fetchImpl = globalThis.fetch, apiKey, useOllamaTags = false, timeoutMs = 30_000, signal } = {}) {
  const request = planModelFetchRequest({ provider, apiKey, useOllamaTags });
  return fetchModels({ ...request, fetchImpl, timeoutMs, signal });
}

export function planModelFetchRequest({ provider = {}, apiKey, useOllamaTags = false } = {}) {
  const profile = typeof provider === "string" ? { id: provider, type: provider } : provider;
  const id = profile.id ?? profile.profile ?? profile.type ?? "openai-compatible";
  const type = profile.type ?? (id === "anthropic" ? "anthropic" : "openai-compatible");
  const baseUrl = String(profile.baseUrl ?? defaultModelBaseUrl(id, type)).replace(/\/$/, "");
  const key = apiKey ?? profile.apiKey;
  if (id === "ollama" && useOllamaTags) {
    return {
      provider: id,
      url: baseUrl.replace(/\/v1$/, "") + "/api/tags",
      headers: {},
      parser: "ollama-tags"
    };
  }
  if (type === "anthropic") {
    return {
      provider: id,
      url: `${baseUrl}/models`,
      headers: {
        "anthropic-version": "2023-06-01",
        ...(key ? { "x-api-key": key } : {})
      },
      parser: "anthropic"
    };
  }
  return {
    provider: id,
    url: `${baseUrl}/models`,
    headers: key ? { authorization: `Bearer ${key}` } : {},
    parser: "openai-compatible"
  };
}

export async function fetchModels({
  url,
  fetchImpl = globalThis.fetch,
  headers = {},
  method = "GET",
  body,
  provider = "openai-compatible",
  parser = "openai-compatible",
  timeoutMs = 30_000,
  signal
} = {}) {
  if (typeof fetchImpl !== "function") return modelFetchFailure("fetch unavailable", { provider, status: null });
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const abortFromParent = () => controller?.abort(signal.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener?.("abort", abortFromParent, { once: true });
  const timer = controller && Number(timeoutMs) > 0
    ? setTimeout(() => controller.abort(new Error("model fetch timeout")), Number(timeoutMs))
    : null;
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller?.signal ?? signal });
    const data = await readResponseJson(response);
    const models = normalizeModels(data, { parser });
    return {
      ok: response.ok,
      provider,
      status: response.status,
      models,
      count: models.length,
      raw: data,
      error: response.ok ? null : modelFetchErrorMessage(data, response)
    };
  } catch (error) {
    return modelFetchFailure(error.message, { provider, status: null, code: error.name === "AbortError" ? "aborted" : "network" });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromParent);
  }
}

export function normalizeModels(data, options = {}) {
  return normalizeModelsWithOptions(data, options);
}

function normalizeModelsWithOptions(data, { parser = "openai-compatible" } = {}) {
  if (parser === "ollama-tags") {
    return normalizeOllamaTags(data);
  }
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];
  return items.map((item) => {
    if (typeof item === "string") return { id: item, name: item, ownedBy: null, raw: item };
    return {
      id: item.id ?? item.name ?? item.model ?? "",
      name: item.name ?? item.id ?? item.model ?? "",
      ownedBy: item.owned_by ?? item.ownedBy ?? item.provider ?? null,
      contextWindow: item.context_window ?? item.contextWindow ?? item.context_length ?? null,
      createdAt: item.created_at ?? item.createdAt ?? null,
      raw: item
    };
  }).filter((item) => item.id);
}

function normalizeOllamaTags(data) {
  const items = Array.isArray(data?.models) ? data.models : [];
  return items.map((item) => ({
    id: item.name ?? item.model ?? "",
    name: item.name ?? item.model ?? "",
    ownedBy: "ollama",
    contextWindow: item.details?.context_length ?? null,
    size: item.size ?? null,
    modifiedAt: item.modified_at ?? null,
    raw: item
  })).filter((item) => item.id);
}

function defaultModelBaseUrl(id, type) {
  if (id === "ollama") return "http://127.0.0.1:11434/v1";
  if (id === "lmstudio") return "http://127.0.0.1:1234/v1";
  if (id === "openrouter") return "https://openrouter.ai/api/v1";
  if (type === "anthropic") return "https://api.anthropic.com/v1";
  return "https://api.openai.com/v1";
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function modelFetchFailure(message, { provider, status, code = "failed" }) {
  return { ok: false, provider, status, models: [], count: 0, raw: null, error: message, code };
}

function modelFetchErrorMessage(data, response) {
  return data?.error?.message ?? data?.message ?? `model fetch failed with status ${response.status}`;
}
