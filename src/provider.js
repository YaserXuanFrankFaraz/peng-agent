import { applyStreamEvent, createStreamAccumulator, finalizeStream, repairToolArguments } from "./streaming.js";

export const PROVIDER_PROFILES = {
  deterministic: {
    id: "deterministic",
    displayName: "Deterministic Local",
    type: "deterministic",
    envPrefix: "YUUMIRA"
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    type: "openai-compatible",
    envPrefix: "OPENAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini"
  },
  "openai-compatible": {
    id: "openai-compatible",
    displayName: "OpenAI Compatible",
    type: "openai-compatible",
    envPrefix: "OPENAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini"
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    type: "openai-compatible",
    envPrefix: "OPENROUTER",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1-mini"
  },
  ollama: {
    id: "ollama",
    displayName: "Ollama",
    type: "openai-compatible",
    envPrefix: "OLLAMA",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.1"
  },
  lmstudio: {
    id: "lmstudio",
    displayName: "LM Studio",
    type: "openai-compatible",
    envPrefix: "LMSTUDIO",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model"
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    type: "anthropic",
    envPrefix: "ANTHROPIC",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514"
  },
  "anthropic-compatible": {
    id: "anthropic-compatible",
    displayName: "Anthropic via OpenAI-Compatible Bridge",
    type: "openai-compatible",
    envPrefix: "ANTHROPIC",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514"
  }
};

export class DeterministicProvider {
  constructor({ name = "deterministic" } = {}) {
    this.name = name;
  }

  async complete({ messages, tools }) {
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === "tool_result") {
      return {
        content: `Completed tool work.\n\n${lastMessage.content}`,
        toolCalls: []
      };
    }

    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const prompt = lastUserMessage?.content ?? "";
    const lower = prompt.toLowerCase();

    if (lower.includes("list") || lower.includes("files") || lower.includes("workspace")) {
      return {
        content: "I will inspect the workspace files, then summarize what I find.",
        toolCalls: [{ name: "workspace.list", input: { dir: "." } }]
      };
    }

    if (lower.includes("remember")) {
      return {
        content: "I will save this as a project memory.",
        toolCalls: [{ name: "memory.remember", input: { fact: prompt } }]
      };
    }

    if (lower.includes("skill")) {
      return {
        content: "I will inspect available skills.",
        toolCalls: [{ name: "skills.list", input: {} }]
      };
    }

    if (lower.includes("workflow")) {
      return {
        content: "I will inspect available workflows.",
        toolCalls: [{ name: "workflows.list", input: {} }]
      };
    }

    if (lower.includes("permission")) {
      return {
        content: "I will evaluate a representative safe-mode read command.",
        toolCalls: [{ name: "permission.evaluate", input: { mode: "safe", kind: "bash", value: "ls -la" } }]
      };
    }

    if (lower.includes("status")) {
      return {
        content: "I will inspect workspace session statuses.",
        toolCalls: [{ name: "statuses.list", input: {} }]
      };
    }

    if (lower.includes("session")) {
      return {
        content: "I will create a tracked workspace session for this request.",
        toolCalls: [{ name: "sessions.create", input: { prompt, permissionMode: "safe" } }]
      };
    }

    if (lower.includes("automation")) {
      return {
        content: "I will validate workspace automation configuration.",
        toolCalls: [{ name: "automations.validate", input: {} }]
      };
    }

    if (lower.includes("source")) {
      return {
        content: "I will inspect configured workspace sources.",
        toolCalls: [{ name: "sources.list", input: {} }]
      };
    }

    if (lower.includes("project")) {
      return {
        content: "I will inspect workspace projects.",
        toolCalls: [{ name: "projects.list", input: {} }]
      };
    }

    if (lower.includes("task")) {
      return {
        content: "I will inspect workspace tasks.",
        toolCalls: [{ name: "tasks.list", input: {} }]
      };
    }

    if (lower.includes("search")) {
      return {
        content: "I will search the workspace records.",
        toolCalls: [{ name: "search.query", input: { query: prompt.replace(/search/i, "").trim() || prompt } }]
      };
    }

    return {
      content: `I can work on this task with ${tools.length} available tools. Next useful step: define the desired behavior as acceptance criteria.`,
      toolCalls: []
    };
  }
}

export class OpenAICompatibleProvider {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    profile = "openai-compatible",
    displayName = "OpenAI Compatible",
    fetchImpl = globalThis.fetch
  } = {}) {
    this.name = "openai-compatible";
    this.profile = profile;
    this.displayName = displayName;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.fetch = fetchImpl;
  }

  async complete({ system, messages, tools, signal }) {
    if (!this.fetch) throw new Error("No fetch implementation available.");
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for openai-compatible provider.");

    const { request, toolNameMap } = buildOpenAIRequest({ model: this.model, system, messages, tools });

    const response = await fetchProvider(this.fetch, `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(request),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw createProviderHttpError({ provider: this.name, phase: "complete", status: response.status, body, retryAfter: response.headers?.get?.("retry-after") });
    }

    const payload = await response.json();
    const message = payload.choices?.[0]?.message ?? {};
    return {
      content: message.content ?? "",
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: toolNameMap.get(call.function?.name) ?? call.function?.name,
        input: repairToolArguments(call.function?.arguments).value
      })),
      raw: payload
    };
  }

  async streamComplete({ system, messages, tools, onEvent, signal }) {
    if (!this.fetch) throw new Error("No fetch implementation available.");
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for openai-compatible provider.");

    const { request, toolNameMap } = buildOpenAIRequest({ model: this.model, system, messages, tools });
    const response = await fetchProvider(this.fetch, `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ ...request, stream: true }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw createProviderHttpError({ provider: this.name, phase: "stream", status: response.status, body, retryAfter: response.headers?.get?.("retry-after") });
    }

    if (!response.body) return this.complete({ system, messages, tools });

    const accumulator = createStreamAccumulator({ toolNameMap });
    for await (const event of parseOpenAIStream(response.body)) {
      applyStreamEvent(accumulator, event);
      if (onEvent) await onEvent(event);
    }
    return finalizeStream(accumulator);
  }
}

export class AnthropicProvider {
  constructor({
    apiKey = process.env.ANTHROPIC_API_KEY,
    baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
    model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
    fetchImpl = globalThis.fetch
  } = {}) {
    this.name = "anthropic";
    this.profile = "anthropic";
    this.displayName = "Anthropic";
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.fetch = fetchImpl;
  }

  async complete({ system, messages, tools, signal }) {
    if (!this.fetch) throw new Error("No fetch implementation available.");
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY is required for anthropic provider.");

    const { request, toolNameMap } = buildAnthropicRequest({ model: this.model, system, messages, tools });
    const response = await fetchProvider(this.fetch, `${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(request),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw createProviderHttpError({ provider: this.name, phase: "complete", status: response.status, body, retryAfter: response.headers?.get?.("retry-after") });
    }

    const payload = await response.json();
    return {
      content: (payload.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(""),
      toolCalls: (payload.content ?? [])
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          name: toolNameMap.get(block.name) ?? block.name,
          input: block.input ?? {}
        })),
      raw: payload
    };
  }

  async streamComplete({ system, messages, tools, onEvent, signal }) {
    if (!this.fetch) throw new Error("No fetch implementation available.");
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY is required for anthropic provider.");

    const { request, toolNameMap } = buildAnthropicRequest({ model: this.model, system, messages, tools });
    const response = await fetchProvider(this.fetch, `${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ ...request, stream: true }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw createProviderHttpError({ provider: this.name, phase: "stream", status: response.status, body, retryAfter: response.headers?.get?.("retry-after") });
    }

    if (!response.body) return this.complete({ system, messages, tools });

    const accumulator = createStreamAccumulator({ toolNameMap });
    for await (const event of parseAnthropicStream(response.body)) {
      applyStreamEvent(accumulator, event);
      if (onEvent) await onEvent(event);
    }
    return finalizeStream(accumulator);
  }
}

export function createProviderFromEnv(env = process.env) {
  const profile = resolveProviderProfile(env.YUUMIRA_PROVIDER ?? env.CRAFT_PROVIDER ?? "deterministic");
  if (profile.type === "openai-compatible") {
    return new OpenAICompatibleProvider({
      apiKey: firstEnv(env, `${profile.envPrefix}_API_KEY`, "OPENAI_API_KEY"),
      baseUrl: firstEnv(env, `${profile.envPrefix}_BASE_URL`, "OPENAI_BASE_URL") ?? profile.baseUrl,
      model: firstEnv(env, `${profile.envPrefix}_MODEL`, "OPENAI_MODEL") ?? profile.model,
      profile: profile.id,
      displayName: profile.displayName
    });
  }
  if (profile.type === "anthropic") {
    return new AnthropicProvider({
      apiKey: firstEnv(env, `${profile.envPrefix}_API_KEY`),
      baseUrl: firstEnv(env, `${profile.envPrefix}_BASE_URL`) ?? profile.baseUrl,
      model: firstEnv(env, `${profile.envPrefix}_MODEL`) ?? profile.model
    });
  }
  return new DeterministicProvider();
}

export function listProviderProfiles() {
  return Object.values(PROVIDER_PROFILES).map(({ id, displayName, type, envPrefix, baseUrl, model }) => ({
    id,
    displayName,
    type,
    envPrefix,
    baseUrl: baseUrl ?? null,
    model: model ?? null
  }));
}

export function describeProvider(provider) {
  return {
    name: provider.name ?? "unknown",
    profile: provider.profile ?? provider.name ?? "unknown",
    displayName: provider.displayName ?? provider.name ?? "unknown",
    model: provider.model ?? null,
    baseUrl: provider.baseUrl ?? null
  };
}

function resolveProviderProfile(id) {
  const normalized = String(id ?? "deterministic").toLowerCase();
  return PROVIDER_PROFILES[normalized] ?? PROVIDER_PROFILES.deterministic;
}

function firstEnv(env, ...names) {
  for (const name of names) {
    if (env[name]) return env[name];
  }
  return undefined;
}

async function fetchProvider(fetchImpl, url, request) {
  try {
    return await fetchImpl(url, request);
  } catch (error) {
    if (error.name === "AbortError" || request.signal?.aborted) {
      throw Object.assign(new Error("Provider request aborted."), { code: "provider_aborted", cause: error });
    }
    throw createProviderNetworkError(error);
  }
}

export function createProviderHttpError({ provider, phase, status, body, retryAfter = null }) {
  const classification = classifyProviderStatus(status);
  const excerpt = String(body ?? "").slice(0, 500);
  return Object.assign(new Error(`${provider} ${phase} failed: ${status} ${excerpt}`), {
    code: classification.code,
    provider,
    phase,
    status,
    retryable: classification.retryable,
    retryAfter,
    body: excerpt
  });
}

export function createProviderNetworkError(error) {
  return Object.assign(new Error(`Provider request failed: ${error.message}`), {
    code: "provider_network_error",
    retryable: true,
    cause: error
  });
}

export function classifyProviderStatus(status) {
  if (status === 401 || status === 403) return { code: "provider_auth_failed", retryable: false };
  if (status === 408 || status === 409 || status === 425) return { code: "provider_transient", retryable: true };
  if (status === 429) return { code: "provider_rate_limited", retryable: true };
  if (status >= 500) return { code: "provider_transient", retryable: true };
  if (status >= 400) return { code: "provider_bad_request", retryable: false };
  return { code: "provider_request_failed", retryable: false };
}

function toOpenAIMessages(system, messages) {
  const normalized = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") normalized.push({ role: "user", content: message.content });
    if (message.role === "assistant") normalized.push({ role: "assistant", content: message.content });
    if (message.role === "tool_call") {
      normalized.push({ role: "assistant", content: `Tool call requested: ${message.content}` });
    }
    if (message.role === "tool_result") {
      normalized.push({ role: "user", content: `Tool result: ${message.content}` });
    }
  }
  return normalized;
}

function buildOpenAIRequest({ model, system, messages, tools }) {
  const toolNameMap = new Map();
  const request = {
    model,
    messages: toOpenAIMessages(system, messages),
    tools: tools.map((tool) => {
      const functionName = toFunctionName(tool.name);
      toolNameMap.set(functionName, tool.name);
      return {
        type: "function",
        function: {
          name: functionName,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema ?? { type: "object", properties: {} }
        }
      };
    }),
    tool_choice: "auto"
  };
  return { request, toolNameMap };
}

function buildAnthropicRequest({ model, system, messages, tools }) {
  const toolNameMap = new Map();
  const request = {
    model,
    system,
    max_tokens: 4096,
    messages: toAnthropicMessages(messages),
    tools: tools.map((tool) => {
      const toolName = toFunctionName(tool.name);
      toolNameMap.set(toolName, tool.name);
      return {
        name: toolName,
        description: tool.description ?? tool.name,
        input_schema: tool.inputSchema ?? { type: "object", properties: {} }
      };
    })
  };
  return { request, toolNameMap };
}

function toAnthropicMessages(messages) {
  const normalized = [];
  for (const message of messages) {
    if (message.role === "user") normalized.push({ role: "user", content: message.content });
    if (message.role === "assistant") normalized.push({ role: "assistant", content: message.content });
    if (message.role === "tool_call") {
      normalized.push({ role: "assistant", content: [{ type: "text", text: `Tool call requested: ${message.content}` }] });
    }
    if (message.role === "tool_result") {
      normalized.push({ role: "user", content: [{ type: "text", text: `Tool result: ${message.content}` }] });
    }
  }
  return normalized.length > 0 ? normalized : [{ role: "user", content: "" }];
}

function toFunctionName(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, "__").slice(0, 64);
}

export async function* parseOpenAIStream(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let splitIndex;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      yield* parseOpenAIFrame(frame);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* parseOpenAIFrame(buffer);
}

export async function* parseAnthropicStream(body) {
  const decoder = new TextDecoder();
  const blocks = new Map();
  let buffer = "";
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let splitIndex;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      yield* parseAnthropicFrame(frame, blocks);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* parseAnthropicFrame(buffer, blocks);
}

function* parseOpenAIFrame(frame) {
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    const payload = JSON.parse(data);
    const delta = payload.choices?.[0]?.delta ?? {};
    if (delta.content) yield { type: "content.delta", delta: delta.content };
    for (const call of delta.tool_calls ?? []) {
      yield {
        type: "tool.delta",
        id: call.id,
        index: call.index,
        name: call.function?.name,
        argumentsDelta: call.function?.arguments ?? ""
      };
    }
  }
}

function* parseAnthropicFrame(frame, blocks) {
  const eventName = frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice("event:".length).trim();
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (!data) return;
  const payload = JSON.parse(data);
  const type = payload.type ?? eventName;
  if (type === "content_block_start") {
    const block = payload.content_block ?? {};
    blocks.set(payload.index, block);
    if (block.type === "tool_use") {
      yield {
        type: "tool.delta",
        id: block.id,
        index: payload.index,
        name: block.name,
        argumentsDelta: block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ""
      };
    }
    return;
  }
  if (type !== "content_block_delta") return;
  const delta = payload.delta ?? {};
  const block = blocks.get(payload.index) ?? {};
  if (delta.type === "text_delta") {
    yield { type: "content.delta", delta: delta.text ?? "" };
  }
  if (delta.type === "input_json_delta") {
    yield {
      type: "tool.delta",
      id: block.id,
      index: payload.index,
      name: block.name,
      argumentsDelta: delta.partial_json ?? ""
    };
  }
}
