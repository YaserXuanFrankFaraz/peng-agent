import assert from "node:assert/strict";
import test from "node:test";
import { branding, appTitle } from "../src/branding.js";
import { cssVariables, themeColor } from "../src/colors.js";
import { createNativeBridge, createRpcBridge, runtimeKind } from "../src/desktop.js";
import { createI18n, formatMessage } from "../src/i18n.js";
import { iconResourcePath } from "../src/icons.js";
import { createInterceptor } from "../src/interceptor.js";
import { uniqueMentions } from "../src/mentions.js";
import { createModelFetcher, fetchModels, fetchProviderModels, normalizeModels, planModelFetchRequest } from "../src/model-fetchers.js";
import { allowSleep, configureNativePowerAssertion, createDefaultNativeAssertionAdapter, powerState, preventSleep, resetPowerState, withPreventSleep } from "../src/power.js";
import { appendContext, systemPrompt, taskPrompt } from "../src/prompts.js";
import { webuiEntrypointIntegrity } from "../src/resources.js";
import { createTelemetrySink, redactTelemetryPayload, telemetryEvent } from "../src/telemetry.js";
import { isSafeUrl, logoResourcePath, serviceUrl, toolName, workspaceSlug } from "../src/utils.js";
import { versionInfo } from "../src/version.js";
import { createMessageWorker } from "../src/worker.js";

test("exposes low-risk shared compatibility surfaces", async () => {
  assert.equal(branding().productName, "Peng");
  assert.equal(appTitle("Settings"), "Peng - Settings");
  assert.equal(themeColor("accent"), "#38bdf8");
  assert.equal(cssVariables()["--peng-text"], "#e5e7eb");
  assert.equal(runtimeKind({}), "node");
  assert.equal(await createNativeBridge({ invoke: async (name) => name }).call("ping").then((value) => value.value), "ping");
  assert.equal((await createRpcBridge().request("ping")).sent, false);
  assert.equal(createI18n({ messages: { hello: "Hi {name}" } }).t("hello", { name: "Ada" }), "Hi Ada");
  assert.equal(formatMessage("{x}", { x: 1 }), "1");
  assert.equal(iconResourcePath("npm.png"), "/resources/tool-icons/npm.png");
  assert.deepEqual(uniqueMentions("@ada and @team.alpha"), ["ada", "team.alpha"]);
  assert.match(systemPrompt({ workspace: "/tmp/work" }), /Peng/);
  assert.deepEqual(taskPrompt("hello").role, "user");
  assert.match(appendContext("p", "c"), /<context>/);
  assert.equal(typeof webuiEntrypointIntegrity().ok, "boolean");
  assert.equal(redactTelemetryPayload({ apiKey: "secret", count: 1 }).apiKey, "[REDACTED]");
  const telemetry = createTelemetrySink({ now: () => new Date("2026-08-07T00:00:00.000Z") });
  assert.equal(telemetry.emit("run.start").timestamp, "2026-08-07T00:00:00.000Z");
  assert.equal(telemetry.list()[0].payload.apiKey, undefined);
  assert.equal(isSafeUrl("https://example.com"), true);
  assert.equal(serviceUrl("https://example.com/api/", "models"), "https://example.com/api/models");
  assert.equal(workspaceSlug("Copy Peng"), "copy-peng");
  assert.equal(toolName("/usr/bin/npm test"), "npm");
  assert.equal(logoResourcePath(), "/resources/craft-logos/craft_app_icon.png");
  assert.deepEqual(versionInfo({ version: "0.1.0" }), { version: "0.1.0", product: "Peng" });
});

test("exposes worker, interceptor, model fetcher, and power helpers", async () => {
  resetPowerState();
  configureNativePowerAssertion({ name: "fake", available: false });
  const interceptor = createInterceptor();
  interceptor.use("event", (payload) => ({ ...payload, seen: true }));
  assert.equal((await interceptor.run("event", {})).seen, true);
  assert.equal((await createMessageWorker({ handler: async (message) => message.text }).handle({ text: "ok" })).value, "ok");
  const fetcher = createModelFetcher({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [{ id: "model" }] };
      }
    })
  });
  assert.equal((await fetcher.list("https://example.com/models")).models[0].id, "model");
  const token = preventSleep("test");
  assert.equal(powerState().token, token);
  assert.equal(allowSleep(), token);
  assert.equal(powerState().preventSleep, false);
  const first = preventSleep("first");
  const second = preventSleep("second");
  assert.equal(powerState().leaseCount, 2);
  assert.equal(allowSleep(first.id), first);
  assert.equal(powerState().token, second);
  assert.equal(await withPreventSleep("scoped", async () => powerState().leaseCount), 2);
  assert.equal(powerState().leaseCount, 1);
  assert.equal(allowSleep(second), second);
  assert.equal(powerState().preventSleep, false);
  configureNativePowerAssertion(null);
});

test("manages native power assertions behind keep-awake leases", () => {
  resetPowerState();
  const calls = [];
  const fakeProcess = {
    pid: 42,
    once(event, handler) {
      calls.push(["once", event, typeof handler]);
    },
    kill(signal) {
      calls.push(["kill", signal]);
    }
  };
  configureNativePowerAssertion({
    name: "fake-native",
    available: true,
    start() {
      calls.push(["start"]);
      return fakeProcess;
    }
  });

  const first = preventSleep("first");
  const second = preventSleep("second");
  assert.equal(powerState().nativeAssertion.status, "running");
  assert.equal(powerState().nativeAssertion.pid, 42);
  assert.equal(calls.filter((call) => call[0] === "start").length, 1);
  assert.equal(allowSleep(first).id, first.id);
  assert.equal(powerState().nativeAssertion.status, "running");
  assert.equal(allowSleep(second).id, second.id);
  assert.deepEqual(calls.at(-1), ["kill", "SIGTERM"]);
  assert.equal(powerState().nativeAssertion.status, "idle");

  configureNativePowerAssertion(createDefaultNativeAssertionAdapter({ platform: "linux" }));
  preventSleep("linux");
  assert.equal(powerState().nativeAssertion.status, "unavailable");
  assert.equal(allowSleep().reason, "linux");
  configureNativePowerAssertion(null);
});

test("normalizes model fetcher responses and errors", async () => {
  assert.deepEqual(normalizeModels(["a", { id: "b", owned_by: "local" }]).map((model) => model.id), ["a", "b"]);
  assert.deepEqual(normalizeModels({ models: [{ name: "llama3.1", size: 42 }] }, { parser: "ollama-tags" }).map((model) => model.id), ["llama3.1"]);
  const failed = await fetchModels({
    url: "https://example.com/models",
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async json() {
        return { error: { message: "bad key" } };
      }
    })
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "bad key");
  const unavailable = await fetchModels({ url: "x", fetchImpl: null });
  assert.equal(unavailable.code, "failed");
});

test("plans and fetches provider-specific model lists", async () => {
  const openai = planModelFetchRequest({
    provider: { id: "openai", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" }
  });
  assert.equal(openai.url, "https://api.openai.com/v1/models");
  assert.equal(openai.headers.authorization, "Bearer sk-test");
  assert.equal(openai.parser, "openai-compatible");

  const anthropic = planModelFetchRequest({
    provider: { id: "anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
    apiKey: "ak-test"
  });
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/models");
  assert.equal(anthropic.headers["x-api-key"], "ak-test");
  assert.equal(anthropic.headers["anthropic-version"], "2023-06-01");

  const ollama = planModelFetchRequest({
    provider: { id: "ollama", type: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
    useOllamaTags: true
  });
  assert.equal(ollama.url, "http://127.0.0.1:11434/api/tags");
  assert.equal(ollama.parser, "ollama-tags");

  let captured;
  const result = await fetchProviderModels({
    provider: { id: "ollama", type: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
    useOllamaTags: true,
    fetchImpl: async (url, request) => {
      captured = { url, request };
      return {
        ok: true,
        status: 200,
        async json() {
          return { models: [{ name: "llama3.1", modified_at: "2026-08-07T00:00:00Z", size: 123 }] };
        }
      };
    }
  });
  assert.equal(captured.url, "http://127.0.0.1:11434/api/tags");
  assert.equal(result.models[0].ownedBy, "ollama");
  assert.equal(result.models[0].size, 123);
});

test("redacts, subscribes, and flushes telemetry events", () => {
  const seen = [];
  const sink = createTelemetrySink({ now: () => new Date("2026-08-07T01:00:00.000Z") });
  const unsubscribe = sink.subscribe((event) => seen.push(event));
  const event = sink.emit("source.test", { nested: { token: "secret" }, Authorization: "Bearer abc", ok: true });
  unsubscribe();
  sink.emit("ignored.by.subscriber");
  assert.equal(event.payload.nested.token, "[REDACTED]");
  assert.equal(event.payload.Authorization, "[REDACTED]");
  assert.equal(seen.length, 1);
  assert.equal(telemetryEvent("x", { password: "p" }, () => new Date("2026-08-07T02:00:00.000Z")).payload.password, "[REDACTED]");
  assert.equal(sink.flush().length, 2);
  assert.equal(sink.list().length, 0);
});

test("matches rpc bridge responses and worker batches", async () => {
  let bridge;
  bridge = createRpcBridge({
    send: async (message) => {
      setTimeout(() => bridge.receive({ jsonrpc: "2.0", id: message.id, result: "pong" }), 0);
      return { sent: true };
    },
    now: () => new Date("2026-08-07T00:00:00.000Z")
  });
  const response = await bridge.request("ping", {}, { timeoutMs: 100 });
  assert.equal(response.result, "pong");
  assert.equal(bridge.history.length, 2);

  const timeoutBridge = createRpcBridge({ send: async () => ({ sent: true }) });
  const timeout = await timeoutBridge.request("slow", {}, { timeoutMs: 1 });
  assert.equal(timeout.error.message, "rpc request timeout");

  const worker = createMessageWorker({
    handler: async (message) => {
      if (message.fail) throw new Error("nope");
      return message.value;
    }
  });
  const drained = await worker.drain([{ value: 1 }, { fail: true }]);
  assert.equal(drained.ok, false);
  assert.equal(drained.results[0].value, 1);
  assert.equal(drained.results[1].error, "nope");
  assert.equal(worker.history.length, 2);
});

test("wraps native bridge failures and timeouts", async () => {
  const bridge = createNativeBridge({ invoke: async () => { throw new Error("boom"); } });
  assert.equal((await bridge.call("fail")).error, "boom");
  const slow = createNativeBridge({ invoke: () => new Promise(() => {}) });
  assert.equal((await slow.call("slow", {}, { timeoutMs: 1 })).error, "native bridge timeout");
});
