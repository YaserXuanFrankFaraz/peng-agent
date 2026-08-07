import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AnthropicProvider, OpenAICompatibleProvider, classifyProviderStatus, createProviderFromEnv, describeProvider, listProviderProfiles, parseAnthropicStream, parseOpenAIStream } from "../src/provider.js";
import { createRuntime } from "../src/runtime.js";
import { JsonStore } from "../src/store.js";
import { repairToolArguments } from "../src/streaming.js";
import { createDefaultTools } from "../src/tools.js";

test("selects provider from environment", () => {
  assert.equal(createProviderFromEnv({ PENG_PROVIDER: "deterministic" }).name, "deterministic");
  const provider = createProviderFromEnv({
    PENG_PROVIDER: "openai-compatible",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://example.com/v1",
    OPENAI_MODEL: "model-a"
  });
  assert.equal(provider.name, "openai-compatible");
  assert.equal(provider.profile, "openai-compatible");
  assert.equal(provider.baseUrl, "https://example.com/v1");
  assert.equal(provider.model, "model-a");
});

test("selects provider profiles and describes active provider", () => {
  const openrouter = createProviderFromEnv({
    PENG_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "router-key",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4"
  });
  assert.equal(openrouter.profile, "openrouter");
  assert.equal(openrouter.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(openrouter.model, "anthropic/claude-sonnet-4");
  assert.equal(openrouter.apiKey, "router-key");

  const ollama = createProviderFromEnv({ PENG_PROVIDER: "ollama" });
  assert.equal(ollama.profile, "ollama");
  assert.equal(ollama.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(describeProvider(ollama).displayName, "Ollama");
  assert.equal(listProviderProfiles().some((profile) => profile.id === "lmstudio"), true);
  assert.equal(createProviderFromEnv({ PENG_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "anthropic-key" }).name, "anthropic");
});

test("anthropic provider maps tools and parses tool_use blocks", async () => {
  let captured;
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    baseUrl: "https://anthropic.example/v1/",
    model: "claude-test",
    fetchImpl: async (url, request) => {
      captured = { url, request: JSON.parse(request.body), headers: request.headers };
      return {
        ok: true,
        async json() {
          return {
            content: [
              { type: "text", text: "I will use a tool." },
              { type: "tool_use", id: "toolu_1", name: "workspace__list", input: { dir: "." } }
            ]
          };
        }
      };
    }
  });

  const result = await provider.complete({
    system: "system",
    messages: [{ role: "user", content: "List files" }],
    tools: [{ name: "workspace.list", description: "List files", inputSchema: { type: "object" } }]
  });

  assert.equal(captured.url, "https://anthropic.example/v1/messages");
  assert.equal(captured.headers["x-api-key"], "test-key");
  assert.equal(captured.headers["anthropic-version"], "2023-06-01");
  assert.equal(captured.request.model, "claude-test");
  assert.equal(captured.request.system, "system");
  assert.equal(captured.request.tools[0].name, "workspace__list");
  assert.equal(result.content, "I will use a tool.");
  assert.deepEqual(result.toolCalls, [{ id: "toolu_1", name: "workspace.list", input: { dir: "." } }]);
});

test("anthropic provider streams text and tool input deltas", async () => {
  let captured;
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    baseUrl: "https://anthropic.example/v1/",
    model: "claude-test",
    fetchImpl: async (url, request) => {
      captured = { url, request: JSON.parse(request.body) };
      return {
        ok: true,
        body: ReadableStream.from([
          "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n",
          "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"workspace__list\",\"input\":{}}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"dir\\\":\"}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\".\\\"}\"}}\n\n",
          "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        ])
      };
    }
  });
  const seen = [];

  const result = await provider.streamComplete({
    system: "system",
    messages: [{ role: "user", content: "List files" }],
    tools: [{ name: "workspace.list", description: "List files", inputSchema: { type: "object" } }],
    onEvent: (event) => seen.push(event)
  });

  assert.equal(captured.url, "https://anthropic.example/v1/messages");
  assert.equal(captured.request.stream, true);
  assert.equal(result.content, "Hello");
  assert.deepEqual(result.toolCalls, [{ id: "toolu_1", name: "workspace.list", input: { dir: "." } }]);
  assert.equal(seen.some((event) => event.type === "content.delta"), true);
  assert.equal(seen.some((event) => event.type === "tool.delta"), true);
});

test("parses anthropic stream frames", async () => {
  const events = [];
  for await (const event of parseAnthropicStream(ReadableStream.from([
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"workspace__list\",\"input\":{}}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"dir\\\":\\\".\\\"}\"}}\n\n"
  ]))) {
    events.push(event);
  }
  assert.deepEqual(events.at(-1), {
    type: "tool.delta",
    id: "toolu_1",
    index: 0,
    name: "workspace__list",
    argumentsDelta: "{\"dir\":\".\"}"
  });
});

test("openai-compatible provider maps tools and parses tool calls", async () => {
  let captured;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1/",
    model: "model-a",
    fetchImpl: async (url, request) => {
      captured = { url, request: JSON.parse(request.body), headers: request.headers };
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: "I need a tool.",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "workspace__list",
                        arguments: "{\"dir\":\".\"}"
                      }
                    }
                  ]
                }
              }
            ]
          };
        }
      };
    }
  });

  const result = await provider.complete({
    system: "system",
    messages: [{ role: "user", content: "List files" }],
    tools: [{ name: "workspace.list", description: "List files", inputSchema: { type: "object" } }]
  });

  assert.equal(captured.url, "https://example.com/v1/chat/completions");
  assert.equal(captured.headers.authorization, "Bearer test-key");
  assert.equal(captured.request.model, "model-a");
  assert.equal(captured.request.tools[0].function.name, "workspace__list");
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "workspace.list", input: { dir: "." } }]);
});

test("providers pass abort signals to fetch", async () => {
  let openAiSignal;
  const openai = new OpenAICompatibleProvider({
    apiKey: "test-key",
    fetchImpl: async (url, request) => {
      openAiSignal = request.signal;
      return { ok: true, async json() { return { choices: [{ message: { content: "ok" } }] }; } };
    }
  });
  const controller = new AbortController();
  await openai.complete({ system: "system", messages: [], tools: [], signal: controller.signal });
  assert.equal(openAiSignal, controller.signal);

  let anthropicSignal;
  const anthropic = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: async (url, request) => {
      anthropicSignal = request.signal;
      return { ok: true, async json() { return { content: [{ type: "text", text: "ok" }] }; } };
    }
  });
  await anthropic.complete({ system: "system", messages: [], tools: [], signal: controller.signal });
  assert.equal(anthropicSignal, controller.signal);
});

test("classifies provider HTTP and network errors", async () => {
  assert.deepEqual(classifyProviderStatus(401), { code: "provider_auth_failed", retryable: false });
  assert.deepEqual(classifyProviderStatus(429), { code: "provider_rate_limited", retryable: true });
  assert.deepEqual(classifyProviderStatus(500), { code: "provider_transient", retryable: true });
  assert.deepEqual(classifyProviderStatus(400), { code: "provider_bad_request", retryable: false });

  const rateLimited = new OpenAICompatibleProvider({
    apiKey: "test-key",
    fetchImpl: async () => ({ ok: false, status: 429, headers: new Map([["retry-after", "2"]]), async text() { return "slow down"; } })
  });
  await assert.rejects(
    () => rateLimited.complete({ system: "system", messages: [], tools: [] }),
    (error) => error.code === "provider_rate_limited" && error.retryable === true && error.status === 429 && error.retryAfter === "2"
  );

  const networkFailure = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: async () => { throw new Error("socket closed"); }
  });
  await assert.rejects(
    () => networkFailure.complete({ system: "system", messages: [], tools: [] }),
    (error) => error.code === "provider_network_error" && error.retryable === true
  );
});

test("openai-compatible provider streams content and tool call deltas", async () => {
  let captured;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1/",
    model: "model-a",
    fetchImpl: async (url, request) => {
      captured = { url, request: JSON.parse(request.body) };
      return {
        ok: true,
        body: ReadableStream.from([
          "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
          "data: {\"choices\":[{\"delta\":{\"content\":\"lo\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"workspace__list\",\"arguments\":\"{\\\"dir\\\":\"}}]}}]}\n\n",
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\".\\\"}\"}}]}}]}\n\n",
          "data: [DONE]\n\n"
        ])
      };
    }
  });
  const seen = [];

  const result = await provider.streamComplete({
    system: "system",
    messages: [{ role: "user", content: "List files" }],
    tools: [{ name: "workspace.list", description: "List files", inputSchema: { type: "object" } }],
    onEvent: (event) => seen.push(event)
  });

  assert.equal(captured.url, "https://example.com/v1/chat/completions");
  assert.equal(captured.request.stream, true);
  assert.equal(result.content, "Hello");
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "workspace.list", input: { dir: "." } }]);
  assert.equal(seen.some((event) => event.type === "content.delta"), true);
  assert.equal(seen.some((event) => event.type === "tool.delta"), true);
});

test("repairs malformed streamed tool-call arguments", async () => {
  assert.deepEqual(repairToolArguments("{\"dir\":\".\"").value, { dir: "." });

  const events = [];
  for await (const event of parseOpenAIStream(ReadableStream.from([
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"workspace__list\",\"arguments\":\"{\\\"dir\\\":\\\".\"}}]}}]}\n\n",
    "data: [DONE]\n\n"
  ]))) {
    events.push(event);
  }
  assert.deepEqual(events[0], {
    type: "tool.delta",
    id: "call_1",
    index: 0,
    name: "workspace__list",
    argumentsDelta: "{\"dir\":\"."
  });
});

test("runtime loops through tool results before final answer", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  const provider = {
    name: "scripted",
    calls: 0,
    async complete({ messages }) {
      this.calls += 1;
      if (!messages.some((message) => message.role === "tool_result")) {
        return {
          content: "Inspecting files.",
          toolCalls: [{ id: "call_1", name: "workspace.list", input: { dir: "." } }]
        };
      }
      return { content: "Final answer after tool result.", toolCalls: [] };
    }
  };
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider,
    tools: createDefaultTools({ workspace })
  });

  const result = await runtime.runTask({ prompt: "List files" });

  assert.equal(provider.calls, 2);
  assert.match(result.output, /Final answer after tool result/);
  assert.match(result.output, /Tool workspace\.list result/);
  assert.deepEqual(
    (await runtime.store.listProtocolEvents({ threadId: result.thread.id }))
      .map((event) => event.type)
      .filter((type) => type !== "run.heartbeat"),
    [
      "run.started",
      "run.step.started",
      "assistant.message",
      "tool.started",
      "tool.completed",
      "run.step.started",
      "assistant.message",
      "run.completed"
    ]
  );
});

test("runtime emits sanitized protocol lifecycle callbacks", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  const events = [];
  const provider = {
    name: "scripted",
    async complete() {
      return {
        content: "Need a secret tool.",
        toolCalls: [{ id: "call_secret", name: "config.get", input: { token: "secret-value" } }]
      };
    }
  };
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider,
    tools: createDefaultTools({ workspace }),
    maxSteps: 1
  });

  await runtime.runTask({ prompt: "Use token", onEvent: (event) => events.push(event) });

  const started = events.find((event) => event.type === "tool.started");
  assert.equal(started.payload.input.token, "[REDACTED]");
  assert.equal(events.at(-1).type, "run.completed");
});

test("runtime persists streaming provider deltas and repaired tool calls", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  const provider = {
    name: "streamed",
    calls: 0,
    async streamComplete({ messages, onEvent }) {
      this.calls += 1;
      if (messages.some((message) => message.role === "tool_result")) {
        await onEvent({ type: "content.delta", delta: "Done" });
        return { content: "Done", toolCalls: [], diagnostics: [] };
      }
      await onEvent({ type: "content.delta", delta: "Listing" });
      await onEvent({ type: "tool.delta", id: "call_stream", index: 0, name: "workspace.list", argumentsDelta: "{\"dir\":\".\"" });
      return {
        content: "Listing",
        toolCalls: [{ id: "call_stream", name: "workspace.list", input: { dir: "." } }],
        diagnostics: [{ type: "diagnostic", code: "tool_arguments_repaired", id: "call_stream", message: "Balanced incomplete tool-call JSON arguments." }]
      };
    }
  };
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider,
    tools: createDefaultTools({ workspace })
  });

  const result = await runtime.runTask({ prompt: "Stream list files" });
  const protocol = await runtime.store.listProtocolEvents({ threadId: result.thread.id });

  assert.equal(provider.calls, 2);
  assert.match(result.output, /Tool workspace\.list result/);
  assert.equal(protocol.some((event) => event.type === "assistant.delta"), true);
  assert.equal(protocol.some((event) => event.type === "tool.delta"), true);
  assert.equal(protocol.some((event) => event.type === "tool.repaired"), true);
});

test("runtime replays acknowledged queued messages after the active run", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  const provider = {
    name: "scripted",
    calls: 0,
    async complete({ messages }) {
      this.calls += 1;
      const lastUser = messages.filter((message) => message.role === "user").at(-1)?.content;
      if (lastUser === "Follow up") {
        return { content: "Handled follow up.", toolCalls: [] };
      }
      if (!messages.some((message) => message.role === "tool_result")) {
        return {
          content: "Queueing a follow-up.",
          toolCalls: [{ id: "call_queue", name: "thread.queue_message", input: { content: "Follow up" } }]
        };
      }
      return { content: "Initial run complete.", toolCalls: [] };
    }
  };
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider,
    tools: createDefaultTools({ workspace })
  });

  const result = await runtime.runTask({ prompt: "Start" });
  const queue = await runtime.store.listQueuedMessages({ threadId: result.thread.id });
  const protocol = await runtime.store.listProtocolEvents({ threadId: result.thread.id });

  assert.equal(provider.calls, 3);
  assert.equal(queue[0].status, "applied");
  assert.equal(result.thread.events.filter((event) => event.role === "user").at(-1).content, "Follow up");
  assert.equal(protocol.some((event) => event.type === "message.replay.started"), true);
  assert.equal(protocol.some((event) => event.type === "message.replay.completed"), true);
});

test("runtime stops at a safe point and resumes a stopped thread", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  const provider = {
    name: "scripted",
    async complete({ messages }) {
      const lastUser = messages.filter((message) => message.role === "user").at(-1)?.content;
      if (lastUser?.startsWith("Continue")) return { content: "Resumed cleanly.", toolCalls: [] };
      return {
        content: "Stopping soon.",
        toolCalls: [{ id: "call_stop", name: "run_control.stop", input: { reason: "test_stop" } }]
      };
    }
  };
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider,
    tools: createDefaultTools({ workspace })
  });

  const stopped = await runtime.runTask({ prompt: "Start stoppable work" });
  assert.equal(stopped.thread.status, "stopped");
  assert.equal((await runtime.store.getRunControl(stopped.thread.id)).status, "stopped");
  assert.equal((await runtime.store.listProtocolEvents({ threadId: stopped.thread.id })).some((event) => event.type === "run.stopped"), true);

  const resumed = await runtime.resumeThread({ threadId: stopped.thread.id, prompt: "Continue from stop" });
  assert.equal(resumed.thread.status, "completed");
  assert.match(resumed.output, /Resumed cleanly/);
  assert.equal((await runtime.store.listProtocolEvents({ threadId: stopped.thread.id })).some((event) => event.type === "run.resume_requested"), true);
});

test("runtime aborts provider work when stop is requested", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  let providerSignal;
  const provider = {
    name: "abortable",
    async complete({ signal }) {
      providerSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("Provider request aborted."), { code: "provider_aborted" }));
        });
      });
    }
  };
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider,
    tools: createDefaultTools({ workspace })
  });
  let threadId;
  const running = runtime.runTask({
    prompt: "Long provider call",
    onEvent: async (event) => {
      if (event.type === "run.step.started") {
        threadId = event.threadId;
        await runtime.requestStop({ threadId, reason: "abort_test" });
      }
    }
  });

  const result = await running;
  assert.equal(providerSignal.aborted, true);
  assert.equal(result.thread.status, "stopped");
  assert.equal((await runtime.store.getRunControl(threadId)).status, "stopped");
  assert.equal((await runtime.store.listProtocolEvents({ threadId })).some((event) => event.type === "run.stopped" && event.payload.abortedProvider === true), true);
});

test("runtime emits structured provider failure payloads", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  const provider = {
    name: "failing-provider",
    async complete() {
      throw Object.assign(new Error("Rate limited"), {
        code: "provider_rate_limited",
        retryable: true,
        status: 429,
        provider: "failing-provider"
      });
    }
  };
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider,
    tools: createDefaultTools({ workspace }),
    providerRetryPolicy: { maxRetries: 0 }
  });

  await assert.rejects(() => runtime.runTask({ prompt: "Trigger provider failure" }), /Rate limited/);
  const failed = (await runtime.store.listProtocolEvents()).find((event) => event.type === "run.failed");
  assert.equal(failed.payload.code, "provider_rate_limited");
  assert.equal(failed.payload.retryable, true);
  assert.equal(failed.payload.status, 429);
  assert.equal(failed.payload.provider, "failing-provider");
});

test("runtime retries transient provider failures before completing the run", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  let attempts = 0;
  const provider = {
    name: "retry-provider",
    async complete() {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Temporary upstream failure"), {
          code: "provider_transient",
          retryable: true,
          status: 503,
          provider: "retry-provider"
        });
      }
      return { content: "Recovered.", toolCalls: [] };
    }
  };
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider,
    tools: createDefaultTools({ workspace }),
    providerRetryPolicy: { maxRetries: 2, baseDelayMs: 0 }
  });

  const result = await runtime.runTask({ prompt: "Retry provider work" });
  const events = await runtime.store.listProtocolEvents({ threadId: result.thread.id });
  const retry = events.find((event) => event.type === "provider.retry");

  assert.equal(attempts, 2);
  assert.equal(result.thread.status, "completed");
  assert.equal(result.output, "Recovered.");
  assert.equal(retry.payload.attempt, 1);
  assert.equal(retry.payload.nextAttempt, 2);
  assert.equal(retry.payload.code, "provider_transient");
  assert.equal(retry.payload.status, 503);
  assert.equal(retry.payload.provider, "retry-provider");
});

test("runtime records heartbeat and watchdog stale diagnostics", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-provider-test-"));
  const runtime = createRuntime({
    workspace,
    store: new JsonStore({ workspace }),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } },
    tools: createDefaultTools({ workspace })
  });

  const result = await runtime.runTask({ prompt: "Heartbeat" });
  await runtime.store.saveRunControl({
    threadId: result.thread.id,
    status: "running",
    reason: null,
    heartbeatAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z"
  });
  const watchdog = await runtime.inspectWatchdog({ staleAfterMs: 1000, now: Date.parse("2020-01-01T00:01:00.000Z") });

  assert.equal(watchdog.stale.length, 1);
  assert.equal(watchdog.stale[0].threadId, result.thread.id);
  assert.equal((await runtime.store.listProtocolEvents({ threadId: result.thread.id })).some((event) => event.type === "run.watchdog.stale"), true);
});
