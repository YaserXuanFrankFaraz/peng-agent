import { spawn } from "node:child_process";

let nextLeaseId = 1;
const leases = new Map();
let nativeAssertion = null;
let nativeAssertionAdapter = createDefaultNativeAssertionAdapter();

export function powerState() {
  const tokens = [...leases.values()];
  return {
    preventSleep: tokens.length > 0,
    token: tokens.at(-1) ?? null,
    tokens,
    leaseCount: tokens.length,
    reasons: [...new Set(tokens.map((token) => token.reason))],
    nativeAssertion: describeNativeAssertion()
  };
}

export function preventSleep(reason = "agent-running", metadata = {}) {
  const token = {
    id: `power_${nextLeaseId++}`,
    reason,
    startedAt: new Date().toISOString(),
    metadata
  };
  leases.set(token.id, token);
  reconcileNativeAssertion();
  return token;
}

export function allowSleep(tokenOrId) {
  const id = typeof tokenOrId === "string" ? tokenOrId : tokenOrId?.id;
  if (id) {
    const token = leases.get(id) ?? null;
    leases.delete(id);
    reconcileNativeAssertion();
    return token;
  }
  const token = [...leases.values()].at(-1) ?? null;
  if (token) leases.delete(token.id);
  reconcileNativeAssertion();
  return token;
}

export async function withPreventSleep(reason, fn, metadata = {}) {
  const token = preventSleep(reason, metadata);
  try {
    return await fn(token);
  } finally {
    allowSleep(token);
  }
}

export function resetPowerState() {
  const previous = [...leases.values()];
  leases.clear();
  stopNativeAssertion("reset");
  return previous;
}

export function configureNativePowerAssertion(adapter) {
  stopNativeAssertion("reconfigured");
  nativeAssertionAdapter = adapter ?? createDefaultNativeAssertionAdapter();
  reconcileNativeAssertion();
  return powerState().nativeAssertion;
}

export function createDefaultNativeAssertionAdapter({ platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform !== "darwin") {
    return {
      name: "none",
      available: false,
      start() {
        return null;
      }
    };
  }
  return {
    name: "caffeinate",
    available: true,
    start() {
      return spawnImpl("caffeinate", ["-dimsu"], { stdio: "ignore" });
    },
    stop(processHandle) {
      processHandle?.kill?.("SIGTERM");
    }
  };
}

function reconcileNativeAssertion() {
  if (leases.size > 0) {
    startNativeAssertion();
  } else {
    stopNativeAssertion("released");
  }
}

function startNativeAssertion() {
  if (nativeAssertion?.status === "running") return nativeAssertion;
  if (nativeAssertionAdapter?.available !== true) {
    nativeAssertion = {
      status: "unavailable",
      adapter: nativeAssertionAdapter?.name ?? "none",
      startedAt: null,
      pid: null,
      error: null
    };
    return nativeAssertion;
  }
  try {
    const processHandle = nativeAssertionAdapter.start();
    nativeAssertion = {
      status: processHandle ? "running" : "unavailable",
      adapter: nativeAssertionAdapter.name ?? "native",
      startedAt: processHandle ? new Date().toISOString() : null,
      pid: processHandle?.pid ?? null,
      error: null,
      processHandle
    };
    processHandle?.once?.("exit", (code, signal) => {
      if (nativeAssertion?.processHandle === processHandle) {
        nativeAssertion = {
          status: "exited",
          adapter: nativeAssertionAdapter.name ?? "native",
          startedAt: nativeAssertion.startedAt,
          pid: processHandle.pid ?? null,
          error: null,
          exitedAt: new Date().toISOString(),
          exit: { code, signal }
        };
      }
    });
  } catch (error) {
    nativeAssertion = {
      status: "failed",
      adapter: nativeAssertionAdapter.name ?? "native",
      startedAt: null,
      pid: null,
      error: error.message
    };
  }
  return nativeAssertion;
}

function stopNativeAssertion(reason) {
  const assertion = nativeAssertion;
  nativeAssertion = null;
  if (assertion?.status === "running") {
    nativeAssertionAdapter?.stop?.(assertion.processHandle, reason);
    if (!nativeAssertionAdapter?.stop) assertion.processHandle?.kill?.("SIGTERM");
  }
  return assertion;
}

function describeNativeAssertion() {
  if (!nativeAssertion) {
    return {
      status: nativeAssertionAdapter?.available === true ? "idle" : "unavailable",
      adapter: nativeAssertionAdapter?.name ?? "none",
      pid: null,
      startedAt: null,
      error: null
    };
  }
  const { processHandle, ...serializable } = nativeAssertion;
  return serializable;
}
