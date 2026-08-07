import { spawn } from "node:child_process";
import { createId } from "./id.js";

const MAX_TERMINAL_OUTPUT = 8000;

export function createTerminalRecord({
  workspaceId,
  sessionId = null,
  command,
  cwd,
  pid = null,
  shell = null,
  dimensions,
  status,
  exitCode = null,
  output = "",
  startedAt = new Date().toISOString(),
  endedAt,
  events = []
}) {
  if (!command || typeof command !== "string") {
    throw new Error("Terminal record requires command.");
  }
  const id = createId("terminal");
  const normalizedExitCode = normalizeExitCode(exitCode);
  const normalizedStartedAt = startedAt ?? new Date().toISOString();
  const normalizedEndedAt = endedAt ?? (normalizedExitCode === null ? null : new Date().toISOString());
  const normalizedEvents = normalizeTerminalEvents(events, id);
  const normalizedDimensions = normalizeDimensions(dimensions);
  const textOutput = truncateOutput(outputFromEvents(normalizedEvents) || output);
  const rawOutputLength = outputFromEvents(normalizedEvents).length || String(output ?? "").length;

  return {
    id,
    workspaceId,
    sessionId,
    command: command.trim(),
    cwd: cwd || null,
    pid,
    shell,
    dimensions: lastResizeDimensions(normalizedEvents) ?? normalizedDimensions,
    status: normalizeStatus(status, normalizedExitCode),
    exitCode: normalizedExitCode,
    output: textOutput,
    outputTruncated: rawOutputLength > MAX_TERMINAL_OUTPUT,
    startedAt: normalizedStartedAt,
    endedAt: normalizedEndedAt,
    durationMs: normalizedEndedAt ? Math.max(0, Date.parse(normalizedEndedAt) - Date.parse(normalizedStartedAt)) : null,
    events: normalizedEvents
  };
}

export function createTerminalSession({
  workspaceId,
  name = "Terminal",
  cwd,
  shell = process.env.SHELL ?? null,
  dimensions,
  status = "open",
  recordIds = [],
  createdAt = new Date().toISOString()
}) {
  if (!workspaceId) throw new Error("Terminal session requires workspaceId.");
  return {
    id: createId("terminal_session"),
    workspaceId,
    name: String(name || "Terminal").trim(),
    cwd: cwd || null,
    shell: typeof shell === "string" ? shell : null,
    dimensions: normalizeDimensions(dimensions),
    status: normalizeSessionStatus(status),
    recordIds: Array.isArray(recordIds) ? [...new Set(recordIds.map(String).filter(Boolean))] : [],
    createdAt,
    updatedAt: createdAt,
    closedAt: status === "closed" ? createdAt : null
  };
}

export function attachTerminalRecordToSession(session, record, { updatedAt = new Date().toISOString() } = {}) {
  if (!session?.id) throw new Error("Terminal session is required.");
  if (!record?.id) throw new Error("Terminal record is required.");
  const recordIds = [...new Set([...(session.recordIds ?? []), record.id])];
  return {
    ...session,
    cwd: record.cwd ?? session.cwd,
    shell: record.shell ?? session.shell,
    dimensions: record.dimensions ?? session.dimensions,
    status: session.status === "closed" ? "closed" : "open",
    recordIds,
    updatedAt
  };
}

export function closeTerminalSession(session, { closedAt = new Date().toISOString() } = {}) {
  return {
    ...session,
    status: "closed",
    closedAt,
    updatedAt: closedAt
  };
}

export function createTerminalEvent({
  id = createId("terminal_event"),
  recordId,
  type = "output",
  stream = "stdout",
  data = "",
  sequence,
  createdAt = new Date().toISOString()
}) {
  if (!recordId) throw new Error("Terminal event requires recordId.");
  const normalizedType = normalizeEventType(type);
  return {
    id,
    recordId,
    type: normalizedType,
    stream: normalizedType === "output" ? normalizeStream(stream) : null,
    data: String(data ?? ""),
    sequence: Number.isInteger(Number(sequence)) ? Number(sequence) : 0,
    createdAt
  };
}

export function recordTerminalChunk(record, { stream = "stdout", data = "", createdAt = new Date().toISOString() } = {}) {
  const events = normalizeTerminalEvents(record.events);
  const event = createTerminalEvent({
    recordId: record.id,
    type: "output",
    stream,
    data,
    sequence: nextSequence(events),
    createdAt
  });
  const updatedEvents = [...events, event];
  const output = outputFromEvents(updatedEvents);
  return {
    ...record,
    status: record.status === "pending" ? "running" : record.status ?? "running",
    output: truncateOutput(output),
    outputTruncated: output.length > MAX_TERMINAL_OUTPUT,
    events: updatedEvents
  };
}

export function recordTerminalInput(record, { data = "", createdAt = new Date().toISOString() } = {}) {
  const events = normalizeTerminalEvents(record.events);
  const event = createTerminalEvent({
    recordId: record.id,
    type: "input",
    data,
    sequence: nextSequence(events),
    createdAt
  });
  return {
    ...record,
    status: record.status === "pending" ? "running" : record.status ?? "running",
    events: [...events, event]
  };
}

export function recordTerminalResize(record, { cols, rows, createdAt = new Date().toISOString() } = {}) {
  const dimensions = normalizeDimensions({ cols, rows });
  const events = normalizeTerminalEvents(record.events);
  const event = createTerminalEvent({
    recordId: record.id,
    type: "resize",
    data: JSON.stringify(dimensions),
    sequence: nextSequence(events),
    createdAt
  });
  return {
    ...record,
    dimensions,
    status: record.status === "pending" ? "running" : record.status ?? "running",
    events: [...events, event]
  };
}

export function finishTerminalRecord(record, { exitCode = 0, endedAt = new Date().toISOString() } = {}) {
  const normalizedExitCode = normalizeExitCode(exitCode);
  const events = normalizeTerminalEvents(record.events);
  const exitEvent = createTerminalEvent({
    recordId: record.id,
    type: "exit",
    data: String(normalizedExitCode),
    sequence: nextSequence(events),
    createdAt: endedAt
  });
  return {
    ...record,
    status: normalizedExitCode === 0 ? "completed" : "failed",
    exitCode: normalizedExitCode,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(record.startedAt)),
    events: [...events, exitEvent]
  };
}

export function replayTerminalRecord(record) {
  const events = normalizeTerminalEvents(record.events);
  const frames = events.length > 0
    ? events
    : legacyOutputFrames(record);
  return {
    recordId: record.id,
    command: record.command,
    cwd: record.cwd ?? null,
    status: record.status ?? normalizeStatus(undefined, record.exitCode),
    exitCode: record.exitCode ?? null,
    output: outputFromEvents(frames) || String(record.output ?? ""),
    frames
  };
}

export async function executeTerminalCommand({
  workspaceId,
  sessionId = null,
  command,
  cwd,
  shell = process.env.SHELL || true,
  env = {},
  timeoutMs = 0,
  dimensions,
  saveRecord = async () => {},
  onEvent = () => {}
}) {
  let record = createTerminalRecord({
    workspaceId,
    sessionId,
    command,
    cwd,
    shell: typeof shell === "string" ? shell : null,
    dimensions,
    status: "running",
    startedAt: new Date().toISOString()
  });
  await saveRecord(record);

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: cwd || process.cwd(),
      shell,
      env: envWithDimensions(env, record.dimensions),
      detached: process.platform !== "win32",
      windowsHide: true
    });
    record = { ...record, pid: child.pid ?? null };
    void saveRecord(record);

    let settled = false;
    let timedOut = false;
    const timeout = Number(timeoutMs) > 0
      ? setTimeout(() => {
        timedOut = true;
        terminateTerminalChild(child, "SIGTERM");
      }, Number(timeoutMs))
      : null;

    child.stdout?.on("data", (chunk) => {
      appendChunk("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      appendChunk("stderr", chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const exitCode = timedOut ? 124 : (code ?? (signal ? 128 : 1));
      record = finishTerminalRecord(record, { exitCode });
      if (timedOut) {
        record = {
          ...record,
          status: "failed",
          signal: "SIGTERM",
          timeoutMs: Number(timeoutMs)
        };
      } else if (signal) {
        record = {
          ...record,
          status: "failed",
          signal
        };
      }
      saveRecord(record).then(() => resolve(record), reject);
    });

    function appendChunk(stream, chunk) {
      record = recordTerminalChunk(record, {
        stream,
        data: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
      });
      const event = record.events.at(-1);
      onEvent(event, record);
      void saveRecord(record);
    }
  });
}

export class TerminalProcessManager {
  constructor({ saveRecord, onEvent = () => {}, onFinish = () => {} }) {
    this.saveRecord = saveRecord;
    this.onEvent = onEvent;
    this.onFinish = onFinish;
    this.processes = new Map();
  }

  async start({
    workspaceId,
    sessionId = null,
    command,
    cwd,
    shell = process.env.SHELL || true,
    env = {},
    timeoutMs = 0,
    dimensions
  }) {
    let record = createTerminalRecord({
      workspaceId,
      sessionId,
      command,
      cwd,
      shell: typeof shell === "string" ? shell : null,
      dimensions,
      status: "running",
      startedAt: new Date().toISOString()
    });
    await this.saveRecord(record);

    const child = spawn(command, {
      cwd: cwd || process.cwd(),
      shell,
      env: envWithDimensions(env, record.dimensions),
      detached: process.platform !== "win32",
      windowsHide: true
    });
    record = { ...record, pid: child.pid ?? null };
    await this.saveRecord(record);

    const state = { child, record, cancelled: false, timedOut: false, timeout: null };
    this.processes.set(record.id, state);
    if (Number(timeoutMs) > 0) {
      state.timeout = setTimeout(() => {
        state.timedOut = true;
        terminateTerminalChild(child, "SIGTERM");
      }, Number(timeoutMs));
    }

    child.stdout?.on("data", (chunk) => this.appendChunk(record.id, "stdout", chunk));
    child.stderr?.on("data", (chunk) => this.appendChunk(record.id, "stderr", chunk));
    child.on("error", (error) => this.finish(record.id, { code: 1, error }));
    child.on("close", (code, signal) => this.finish(record.id, { code, signal, timeoutMs }));
    return record;
  }

  async cancel(recordId, { signal = "SIGTERM" } = {}) {
    const state = this.processes.get(recordId);
    if (!state) throw Object.assign(new Error("Terminal process is not running"), { code: "not_running" });
    state.cancelled = true;
    terminateTerminalChild(state.child, signal);
    state.record = {
      ...state.record,
      status: "cancelled",
      signal
    };
    await this.saveRecord(state.record);
    return state.record;
  }

  async write(recordId, { data = "" } = {}) {
    const state = this.processes.get(recordId);
    if (!state) throw Object.assign(new Error("Terminal process is not running"), { code: "not_running" });
    if (!state.child.stdin?.writable) throw Object.assign(new Error("Terminal stdin is not writable"), { code: "stdin_closed" });
    const input = String(data ?? "");
    state.record = recordTerminalInput(state.record, { data: input });
    const event = state.record.events.at(-1);
    state.child.stdin.write(input);
    this.onEvent(event, state.record);
    await this.saveRecord(state.record);
    return state.record;
  }

  async resize(recordId, { cols, rows } = {}) {
    const state = this.processes.get(recordId);
    if (!state) throw Object.assign(new Error("Terminal process is not running"), { code: "not_running" });
    state.record = recordTerminalResize(state.record, { cols, rows });
    const event = state.record.events.at(-1);
    this.onEvent(event, state.record);
    await this.saveRecord(state.record);
    return state.record;
  }

  status(recordId) {
    const state = this.processes.get(recordId);
    return {
      recordId,
      running: Boolean(state),
      pid: state?.record.pid ?? null,
      status: state?.record.status ?? null,
      dimensions: state?.record.dimensions ?? null
    };
  }

  async appendChunk(recordId, stream, chunk) {
    const state = this.processes.get(recordId);
    if (!state) return;
    state.record = recordTerminalChunk(state.record, {
      stream,
      data: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    });
    const event = state.record.events.at(-1);
    this.onEvent(event, state.record);
    await this.saveRecord(state.record);
  }

  async finish(recordId, { code, signal, error, timeoutMs } = {}) {
    const state = this.processes.get(recordId);
    if (!state) return null;
    if (state.timeout) clearTimeout(state.timeout);
    this.processes.delete(recordId);
    const exitCode = state.timedOut ? 124 : (code ?? (signal ? 128 : 1));
    let record = finishTerminalRecord(state.record, { exitCode });
    if (state.cancelled) {
      record = { ...record, status: "cancelled", signal: signal ?? state.record.signal ?? "SIGTERM" };
    } else if (state.timedOut) {
      record = { ...record, status: "failed", signal: "SIGTERM", timeoutMs: Number(timeoutMs) };
    } else if (signal) {
      record = { ...record, status: "failed", signal };
    } else if (error) {
      record = { ...record, status: "failed", error: error.message };
    }
    await this.saveRecord(record);
    this.onFinish(record);
    return record;
  }
}

export function filterTerminalHistory(history, { query, exitCode } = {}) {
  const lowerQuery = String(query ?? "").trim().toLowerCase();
  const normalizedExitCode = exitCode === undefined || exitCode === null || exitCode === "" ? null : Number(exitCode);

  return history.filter((record) => {
    if (lowerQuery && !record.command.toLowerCase().includes(lowerQuery) && !String(record.output ?? "").toLowerCase().includes(lowerQuery)) {
      return false;
    }
    if (normalizedExitCode !== null && record.exitCode !== normalizedExitCode) return false;
    return true;
  });
}

function truncateOutput(output) {
  const text = String(output ?? "");
  if (text.length <= MAX_TERMINAL_OUTPUT) return text;
  return text.slice(0, MAX_TERMINAL_OUTPUT);
}

function normalizeExitCode(exitCode) {
  if (exitCode === null || exitCode === undefined || exitCode === "") return null;
  const number = Number(exitCode);
  if (!Number.isInteger(number)) throw new Error("Terminal exitCode must be an integer.");
  return number;
}

function normalizeTerminalEvents(events = [], fallbackRecordId = null) {
  if (!Array.isArray(events)) return [];
  return events
    .map((event, index) => createTerminalEvent({
      id: event.id,
      recordId: event.recordId ?? fallbackRecordId,
      type: event.type,
      stream: event.stream,
      data: event.data,
      sequence: event.sequence ?? index,
      createdAt: event.createdAt
    }))
    .sort((a, b) => a.sequence - b.sequence);
}

function normalizeStatus(status, exitCode) {
  if (["pending", "running", "completed", "failed", "cancelled"].includes(status)) return status;
  if (exitCode === null || exitCode === undefined) return "running";
  return exitCode === 0 ? "completed" : "failed";
}

function normalizeSessionStatus(status) {
  if (["open", "closed"].includes(status)) return status;
  return "open";
}

function normalizeEventType(type) {
  if (["input", "output", "exit", "error", "resize"].includes(type)) return type;
  throw new Error(`Unsupported terminal event type: ${type}`);
}

function normalizeStream(stream) {
  if (["stdout", "stderr"].includes(stream)) return stream;
  throw new Error(`Unsupported terminal stream: ${stream}`);
}

function normalizeDimensions(dimensions = {}) {
  const cols = Number(dimensions?.cols ?? 80);
  const rows = Number(dimensions?.rows ?? 24);
  if (!Number.isInteger(cols) || cols < 1) throw new Error("Terminal cols must be a positive integer.");
  if (!Number.isInteger(rows) || rows < 1) throw new Error("Terminal rows must be a positive integer.");
  return { cols, rows };
}

function lastResizeDimensions(events) {
  for (const event of [...events].reverse()) {
    if (event.type !== "resize") continue;
    try {
      return normalizeDimensions(JSON.parse(event.data));
    } catch {
      return null;
    }
  }
  return null;
}

function envWithDimensions(env = {}, dimensions) {
  const normalizedDimensions = normalizeDimensions(dimensions);
  return {
    ...process.env,
    ...env,
    COLUMNS: String(normalizedDimensions.cols),
    LINES: String(normalizedDimensions.rows)
  };
}

function nextSequence(events) {
  return events.reduce((max, event) => Math.max(max, event.sequence), -1) + 1;
}

function outputFromEvents(events) {
  return events
    .filter((event) => event.type === "output")
    .map((event) => event.data)
    .join("");
}

function legacyOutputFrames(record) {
  const output = String(record.output ?? "");
  if (!output) return [];
  return [
    createTerminalEvent({
      recordId: record.id,
      type: "output",
      stream: "stdout",
      data: output,
      sequence: 0,
      createdAt: record.endedAt ?? record.startedAt
    })
  ];
}

function terminateTerminalChild(child, signal = "SIGTERM") {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to killing the direct child when process-group signalling is unavailable.
    }
  }
  child.kill(signal);
}
