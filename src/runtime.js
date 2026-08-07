import { createId } from "./id.js";
import { mergeConfig } from "./config.js";
import { allowSleep, powerState, preventSleep } from "./power.js";
import { createProtocolEvent, sanitizeProtocolPayload } from "./protocol.js";
import { createQueuedMessage, markQueuedMessage } from "./queue.js";
import { createRunControl, heartbeatAgeMs, isStopRequested, updateRunControl } from "./run-control.js";

export function createRuntime({ workspace, store, provider, tools, maxSteps, providerRetryPolicy, config }) {
  return new AgentRuntime({ workspace, store, provider, tools, maxSteps, providerRetryPolicy, config });
}

export class AgentRuntime {
  constructor({ workspace, store, provider, tools, maxSteps = 4, providerRetryPolicy = {}, config = {} }) {
    this.workspace = workspace;
    this.store = store;
    this.provider = provider;
    this.tools = tools;
    this.maxSteps = maxSteps;
    this.providerRetryPolicy = normalizeProviderRetryPolicy(providerRetryPolicy);
    this.config = mergeConfig(config);
  }

  async runTask({ prompt, threadId, memoryContext, includeMemory = false, onEvent = null, processQueued = true }) {
    const thread = threadId
      ? await this.store.getThread(threadId)
      : createThread({ title: titleFromPrompt(prompt) });
    let sequence = 0;
    const emit = (event) => this.emitProtocolEvent({ sequence: sequence += 1, ...event }, onEvent);

    thread.status = "running";
    await this.store.saveRunControl(createRunControl({ threadId: thread.id, status: "running" }));
    appendEvent(thread, { role: "user", content: prompt });
    thread.updatedAt = new Date().toISOString();
    await this.store.saveThread(thread);
    await emit({ type: "run.started", threadId: thread.id, payload: { prompt, resumed: Boolean(threadId) } });

    const toolResults = [];
    let finalContent = "";
    const powerLease = await this.acquireRunPowerLease({ threadId: thread.id, emit });

    try {
      for (let step = 0; step < this.maxSteps; step += 1) {
        if (await this.stopIfRequested({ thread, emit, phase: "before_step", step })) {
          finalContent = "Stopped by request.";
          break;
        }
        await this.heartbeatRun({ threadId: thread.id, step, phase: "step.start", onEvent });
        await emit({ type: "run.step.started", threadId: thread.id, step, payload: { toolCount: this.tools.list().length } });
        const response = await this.completeProvider({
          system: systemPrompt(await this.resolveMemoryContext({ prompt, memoryContext, includeMemory })),
          messages: thread.events,
          tools: this.tools.list(),
          context: { workspace: this.workspace, step },
          threadId: thread.id,
          step,
          emit
        });
        await this.heartbeatRun({ threadId: thread.id, step, phase: "provider.complete", onEvent });

        finalContent = response.content ?? "";
        appendEvent(thread, { role: "assistant", content: finalContent });
        await emit({ type: "assistant.message", threadId: thread.id, step, payload: { content: finalContent } });

        const calls = response.toolCalls ?? [];
        if (calls.length === 0) break;

        for (const call of calls) {
          if (await this.stopIfRequested({ thread, emit, phase: "before_tool", step })) {
            finalContent = "Stopped by request.";
            break;
          }
          appendEvent(thread, {
            role: "tool_call",
            toolCallId: call.id,
            content: JSON.stringify({ id: call.id, name: call.name, input: call.input })
          });
          await emit({ type: "tool.started", threadId: thread.id, step, payload: { id: call.id, name: call.name, input: call.input } });
          const result = await this.tools.run(call.name, call.input, {
            workspace: this.workspace,
            store: this.store,
            thread
          });
          toolResults.push({ call, result });
          appendEvent(thread, {
            role: "tool_result",
            toolCallId: call.id,
            content: JSON.stringify({ name: call.name, result })
          });
          await emit({ type: "tool.completed", threadId: thread.id, step, payload: { id: call.id, name: call.name, result } });
          await this.heartbeatRun({ threadId: thread.id, step, phase: "tool.completed", onEvent });
        }

        if (thread.status === "stopped") break;
        if (step === this.maxSteps - 1) {
          finalContent = "Stopped after reaching the maximum agent steps.";
          appendEvent(thread, { role: "assistant", content: finalContent });
          await emit({ type: "run.max_steps", threadId: thread.id, step, payload: { maxSteps: this.maxSteps } });
        }
      }

      const output = renderOutput(finalContent, toolResults);
      appendEvent(thread, { role: "assistant", content: output });
      if (thread.status !== "stopped") thread.status = "completed";
      thread.updatedAt = new Date().toISOString();
      await this.store.saveThread(thread);
      await this.store.saveRunControl(updateRunControl(await this.store.getRunControl(thread.id), { status: thread.status }));
      await emit({
        type: thread.status === "stopped" ? "run.stopped" : "run.completed",
        threadId: thread.id,
        payload: { status: thread.status, output, toolResultCount: toolResults.length }
      });

      const queuedReplays = processQueued && thread.status !== "stopped" ? await this.replayQueuedMessages({ threadId: thread.id, onEvent }) : [];
      const latestThread = queuedReplays.length > 0 ? await this.store.getThread(thread.id) : thread;
      return { thread: latestThread, output, toolResults, queuedReplays };
    } catch (error) {
      if (error.code === "provider_aborted" && isStopRequested(await this.store.getRunControl(thread.id))) {
        thread.status = "stopped";
        thread.updatedAt = new Date().toISOString();
        const control = await this.store.getRunControl(thread.id);
        appendEvent(thread, { role: "assistant", content: "Stopped by request." });
        await this.store.saveThread(thread);
        await this.store.saveRunControl(updateRunControl(control, { status: "stopped" }));
        await emit({ type: "run.stopped", threadId: thread.id, payload: { status: "stopped", reason: control.reason, abortedProvider: true } });
        return { thread, output: "Stopped by request.", toolResults, queuedReplays: [] };
      }
      thread.status = "failed";
      thread.updatedAt = new Date().toISOString();
      appendEvent(thread, { role: "assistant", content: `Run failed: ${error.message}` });
      await this.store.saveThread(thread);
      await this.store.saveRunControl(updateRunControl(await this.store.getRunControl(thread.id), { status: "failed", reason: error.message }));
      await emit({
        type: "run.failed",
        threadId: thread.id,
        payload: {
          message: error.message,
          code: error.code ?? "run_failed",
          retryable: error.retryable === true,
          status: error.status ?? null,
          provider: error.provider ?? null
        }
      });
      throw error;
    } finally {
      await this.releaseRunPowerLease({ lease: powerLease, threadId: thread.id, emit });
    }
  }

  async emitProtocolEvent(event, onEvent) {
    const protocolEvent = createProtocolEvent({
      ...event,
      payload: sanitizeProtocolPayload(event.payload ?? {})
    });
    if (this.store.appendProtocolEvent) await this.store.appendProtocolEvent(protocolEvent);
    if (onEvent) await onEvent(protocolEvent);
    return protocolEvent;
  }

  async completeProvider({ system, messages, tools, context, threadId, step, emit }) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.completeProviderAttempt({ system, messages, tools, context, threadId, step, emit });
      } catch (error) {
        if (!shouldRetryProviderError(error, attempt, this.providerRetryPolicy)) throw error;
        const delayMs = computeProviderRetryDelay(error, attempt, this.providerRetryPolicy);
        await emit({
          type: "provider.retry",
          threadId,
          step,
          payload: {
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts: this.providerRetryPolicy.maxRetries + 1,
            delayMs,
            code: error.code ?? "provider_request_failed",
            retryable: true,
            status: error.status ?? null,
            provider: error.provider ?? this.provider.name ?? null,
            message: error.message
          }
        });
        await this.waitForProviderRetryDelay({ delayMs, threadId, step, emit });
      }
    }
  }

  async completeProviderAttempt({ system, messages, tools, context, threadId, step, emit }) {
    const abortController = new AbortController();
    let stoppedWatching = false;
    let emittedProviderStop = false;
    const stopIfRequested = async () => {
      const control = await this.store.getRunControl(threadId);
      if (!isStopRequested(control)) return false;
      abortController.abort();
      if (!emittedProviderStop) {
        emittedProviderStop = true;
        await emit({ type: "run.stopping", threadId, step, payload: { phase: "provider", reason: control.reason } });
      }
      return true;
    };
    const watchStop = async () => {
      while (!stoppedWatching && !abortController.signal.aborted) {
        if (await stopIfRequested()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const watcher = watchStop();
    try {
      if (typeof this.provider.streamComplete !== "function") {
        const response = await this.provider.complete({ system, messages, tools, context, signal: abortController.signal });
        await stopIfRequested();
        return response;
      }
      const response = await this.provider.streamComplete({
        system,
        messages,
        tools,
        context,
        signal: abortController.signal,
        onEvent: async (event) => {
          if (await stopIfRequested()) return;
          if (event.type === "content.delta") {
            await emit({ type: "assistant.delta", threadId, step, payload: { delta: event.delta } });
          } else if (event.type === "tool.delta") {
            await emit({
              type: "tool.delta",
              threadId,
              step,
              payload: { id: event.id, index: event.index, name: event.name, argumentsDelta: event.argumentsDelta }
            });
          } else if (event.type === "diagnostic") {
            await emit({ type: "provider.diagnostic", threadId, step, payload: event });
          }
        }
      });
      await stopIfRequested();
      for (const diagnostic of response.diagnostics ?? []) {
        await emit({
          type: diagnostic.code === "tool_arguments_repaired" ? "tool.repaired" : "provider.diagnostic",
          threadId,
          step,
          payload: diagnostic
        });
      }
      return response;
    } finally {
      stoppedWatching = true;
      await watcher;
    }
  }

  async waitForProviderRetryDelay({ delayMs, threadId, step, emit }) {
    const deadline = Date.now() + delayMs;
    let emittedProviderStop = false;
    while (Date.now() < deadline) {
      const control = await this.store.getRunControl(threadId);
      if (isStopRequested(control)) {
        if (!emittedProviderStop) {
          emittedProviderStop = true;
          await emit({ type: "run.stopping", threadId, step, payload: { phase: "provider_retry", reason: control.reason } });
        }
        throw Object.assign(new Error("Provider request aborted."), { code: "provider_aborted" });
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
    }
  }

  async queueThreadMessage({ threadId, content, source = "client", onEvent = null }) {
    const thread = await this.store.getThread(threadId);
    const message = createQueuedMessage({
      threadId,
      content,
      source,
      status: thread.status === "running" ? "acknowledged" : "pending"
    });
    await this.store.saveQueuedMessage(message);
    await this.emitProtocolEvent({
      type: "message.queued",
      threadId,
      payload: { messageId: message.id, source: message.source, status: message.status, content: message.content }
    }, onEvent);
    if (message.status === "acknowledged") {
      await this.emitProtocolEvent({
        type: "message.acknowledged",
        threadId,
        payload: { messageId: message.id, replayAfterCurrentRun: true }
      }, onEvent);
    }
    return message;
  }

  async replayQueuedMessages({ threadId, onEvent = null, limit = 20 } = {}) {
    const replayed = [];
    for (let index = 0; index < limit; index += 1) {
      const queue = await this.store.listQueuedMessages({ threadId });
      const message = queue.find((item) => item.status === "acknowledged" || item.status === "pending");
      if (!message) break;

      const replaying = markQueuedMessage(message, "replaying", { replayAttempts: (message.replayAttempts ?? 0) + 1 });
      await this.store.saveQueuedMessage(replaying);
      await this.emitProtocolEvent({
        type: "message.replay.started",
        threadId,
        payload: { messageId: message.id, replayAttempts: replaying.replayAttempts }
      }, onEvent);

      try {
        await this.runTask({
          prompt: message.content,
          threadId,
          onEvent,
          processQueued: false
        });
        const applied = markQueuedMessage(replaying, "applied");
        await this.store.saveQueuedMessage(applied);
        await this.emitProtocolEvent({
          type: "message.replay.completed",
          threadId,
          payload: { messageId: message.id }
        }, onEvent);
        replayed.push(applied);
      } catch (error) {
        const failed = markQueuedMessage(replaying, "failed", { error: error.message });
        await this.store.saveQueuedMessage(failed);
        await this.emitProtocolEvent({
          type: "message.replay.failed",
          threadId,
          payload: { messageId: message.id, message: error.message, retryable: true }
        }, onEvent);
        replayed.push(failed);
        break;
      }
    }
    return replayed;
  }

  async requestStop({ threadId, reason = "user_requested", onEvent = null }) {
    await this.store.getThread(threadId);
    const current = await this.store.getRunControl(threadId);
    const control = updateRunControl(current ?? createRunControl({ threadId }), { status: "stop_requested", reason });
    await this.store.saveRunControl(control);
    await this.emitProtocolEvent({ type: "run.stop_requested", threadId, payload: { reason } }, onEvent);
    return control;
  }

  async resumeThread({ threadId, prompt = "Resume the stopped thread.", onEvent = null }) {
    const thread = await this.store.getThread(threadId);
    if (thread.status !== "stopped" && thread.status !== "failed") {
      throw new Error(`Thread is not resumable: ${thread.status}`);
    }
    await this.store.saveRunControl(createRunControl({ threadId, status: "running", reason: "resume_requested" }));
    await this.emitProtocolEvent({ type: "run.resume_requested", threadId, payload: { prompt } }, onEvent);
    return this.runTask({ prompt, threadId, onEvent });
  }

  async heartbeatRun({ threadId, step = null, phase = "running", onEvent = null }) {
    const current = await this.store.getRunControl(threadId);
    const control = updateRunControl(current ?? createRunControl({ threadId }), {
      status: current?.status ?? "running",
      heartbeatAt: new Date().toISOString(),
      phase
    });
    await this.store.saveRunControl(control);
    await this.emitProtocolEvent({ type: "run.heartbeat", threadId, step, payload: { phase, heartbeatAt: control.heartbeatAt } }, onEvent);
    return control;
  }

  async listRunControls(filter = {}) {
    return this.store.listRunControls(filter);
  }

  async inspectWatchdog({ staleAfterMs = 30000, now = Date.now(), onEvent = null } = {}) {
    const controls = await this.store.listRunControls({ status: "running" });
    const stale = controls
      .map((control) => ({ ...control, ageMs: heartbeatAgeMs(control, now) }))
      .filter((control) => control.ageMs > staleAfterMs);
    for (const control of stale) {
      await this.emitProtocolEvent({
        type: "run.watchdog.stale",
        threadId: control.threadId,
        payload: { staleAfterMs, ageMs: control.ageMs, heartbeatAt: control.heartbeatAt }
      }, onEvent);
    }
    return { staleAfterMs, stale };
  }

  async acquireRunPowerLease({ threadId, emit }) {
    if (this.config.defaults.keepAwakeWhileRunning !== true) return null;
    const lease = preventSleep("agent-running", { threadId });
    await emit({
      type: "power.prevent_sleep",
      threadId,
      payload: { leaseId: lease.id, reason: lease.reason, state: powerState() }
    });
    return lease;
  }

  async releaseRunPowerLease({ lease, threadId, emit }) {
    if (!lease) return null;
    const released = allowSleep(lease);
    await emit({
      type: "power.allow_sleep",
      threadId,
      payload: { leaseId: released?.id ?? lease.id, reason: released?.reason ?? lease.reason, state: powerState() }
    });
    return released;
  }

  async stopIfRequested({ thread, emit, phase, step }) {
    const control = await this.store.getRunControl(thread.id);
    if (!isStopRequested(control)) return false;
    thread.status = "stopped";
    thread.updatedAt = new Date().toISOString();
    appendEvent(thread, { role: "assistant", content: `Stop requested: ${control.reason ?? "user_requested"}` });
    await this.store.saveThread(thread);
    await this.store.saveRunControl(updateRunControl(control, { status: "stopped" }));
    await emit({ type: "run.stopping", threadId: thread.id, step, payload: { phase, reason: control.reason } });
    return true;
  }

  listThreads() {
    return this.store.listThreads();
  }

  getThread(threadId) {
    return this.store.getThread(threadId);
  }

  async resolveMemoryContext({ prompt, memoryContext, includeMemory }) {
    if (memoryContext) return memoryContext;
    if (!includeMemory || !this.store.renderMemoryContext) return "";
    return this.store.renderMemoryContext({ query: prompt });
  }
}

function createThread({ title }) {
  const now = new Date().toISOString();
  return {
    id: createId("thread"),
    title,
    status: "running",
    createdAt: now,
    updatedAt: now,
    events: []
  };
}

function appendEvent(thread, event) {
  thread.events.push({
    id: createId("event"),
    createdAt: new Date().toISOString(),
    ...event
  });
}

function titleFromPrompt(prompt) {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 60) || "Untitled task";
}

function systemPrompt(memoryContext = "") {
  const parts = [
    "You are an original clean-room AI agent runtime.",
    "Use tools only through the provided registry.",
    "Preserve workspace boundaries and explain outcomes plainly."
  ];
  if (memoryContext) parts.push(memoryContext);
  return parts.join("\n\n");
}

function renderOutput(content, toolResults) {
  if (toolResults.length === 0) return content;
  const rendered = toolResults.map(({ call, result }) => {
    const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return `Tool ${call.name} result:\n${body}`;
  });
  return `${content}\n\n${rendered.join("\n\n")}`;
}

function normalizeProviderRetryPolicy(policy = {}) {
  return {
    maxRetries: clampInteger(policy.maxRetries, 2, 0, 10),
    baseDelayMs: clampInteger(policy.baseDelayMs, 100, 0, 60000),
    maxDelayMs: clampInteger(policy.maxDelayMs, 1000, 0, 60000)
  };
}

function shouldRetryProviderError(error, attempt, policy) {
  if (error.code === "provider_aborted") return false;
  if (error.retryable !== true) return false;
  return attempt <= policy.maxRetries;
}

function computeProviderRetryDelay(error, attempt, policy) {
  const retryAfterMs = parseRetryAfterMs(error.retryAfter);
  if (retryAfterMs !== null) return Math.min(retryAfterMs, policy.maxDelayMs);
  if (policy.baseDelayMs === 0) return 0;
  return Math.min(policy.baseDelayMs * (2 ** (attempt - 1)), policy.maxDelayMs);
}

function parseRetryAfterMs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value * 1000);
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text) * 1000);
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
