export const DESKTOP_RUNTIME_KINDS = {
  node: "node",
  tauri: "tauri",
  browser: "browser"
};

export function runtimeKind(env = globalThis) {
  if (env?.__TAURI_INTERNALS__) return DESKTOP_RUNTIME_KINDS.tauri;
  if (typeof process !== "undefined" && process.versions?.node) return DESKTOP_RUNTIME_KINDS.node;
  return DESKTOP_RUNTIME_KINDS.browser;
}

export function isDesktopRuntime(env = globalThis) {
  return runtimeKind(env) !== DESKTOP_RUNTIME_KINDS.browser;
}

export function createNativeBridge({ invoke } = {}) {
  return {
    available: typeof invoke === "function",
    async call(command, payload = {}, { timeoutMs = 30_000 } = {}) {
      if (typeof invoke !== "function") {
        return { ok: false, error: "native bridge unavailable", command, payload };
      }
      try {
        return { ok: true, value: await withTimeout(invoke(command, payload), timeoutMs), command };
      } catch (error) {
        return { ok: false, error: error.message, command, payload };
      }
    }
  };
}

export function createRpcBridge({ send, now = () => new Date() } = {}) {
  let nextId = 1;
  const pending = new Map();
  const history = [];
  return {
    pending,
    history,
    async request(method, params = {}, { timeoutMs = 30_000 } = {}) {
      const message = { jsonrpc: "2.0", id: nextId++, method, params };
      history.push({ direction: "out", message, timestamp: now().toISOString() });
      if (typeof send !== "function") return { ...message, sent: false };
      const sent = await send(message);
      if (sent && typeof sent === "object" && ("result" in sent || "error" in sent)) return sent;
      return new Promise((resolve) => {
        const timer = Number(timeoutMs) > 0
          ? setTimeout(() => {
            pending.delete(message.id);
            resolve({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "rpc request timeout" } });
          }, Number(timeoutMs))
          : null;
        pending.set(message.id, (response) => {
          if (timer) clearTimeout(timer);
          resolve(response);
        });
      });
    },
    receive(message) {
      history.push({ direction: "in", message, timestamp: now().toISOString() });
      if (message?.id && pending.has(message.id)) {
        const resolve = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
        return true;
      }
      return false;
    }
  };
}

function withTimeout(promise, timeoutMs) {
  if (!(Number(timeoutMs) > 0)) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("native bridge timeout")), Number(timeoutMs));
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
