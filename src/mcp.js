import { spawn } from "node:child_process";

export async function withMcpClient(source, fn, options = {}) {
  if (source.mcp?.transport === "stdio") return withStdioMcpClient(source, fn, options);
  return withHttpMcpClient(source, fn, options);
}

export async function withStdioMcpClient(source, fn, { timeoutMs = 5000, credential = null } = {}) {
  if (source.type !== "mcp") throw new Error(`Source is not an MCP source: ${source.slug}`);
  if (source.mcp?.transport !== "stdio") throw new Error(`Unsupported MCP transport: ${source.mcp?.transport ?? "http"}`);
  const client = new StdioMcpClient({ source, timeoutMs, credential });
  await client.start();
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function withHttpMcpClient(source, fn, { timeoutMs = 5000, credential = null, fetchImpl = globalThis.fetch } = {}) {
  if (source.type !== "mcp") throw new Error(`Source is not an MCP source: ${source.slug}`);
  if (!source.mcp?.url) throw new Error(`HTTP MCP source requires url: ${source.slug}`);
  const client = new HttpMcpClient({ source, timeoutMs, credential, fetchImpl });
  await client.initialize();
  client.notify("notifications/initialized", {});
  return fn(client);
}

export class StdioMcpClient {
  constructor({ source, timeoutMs = 5000, credential = null }) {
    this.source = source;
    this.timeoutMs = timeoutMs;
    this.credential = credential;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.process = null;
  }

  async start() {
    const args = this.source.mcp.args ?? [];
    this.process = spawn(this.source.mcp.command, args, {
      cwd: this.source.mcp.cwd ?? this.source.path,
      env: { ...process.env, ...(this.source.mcp.env ?? {}), ...mcpCredentialEnv(this.source, this.credential) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stdout.on("data", (chunk) => this.readChunk(chunk));
    this.process.stderr.on("data", () => {});
    this.process.on("exit", (code, signal) => {
      const error = new Error(`MCP process exited: ${code ?? signal}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "peng-agent", version: "0.1.0" }
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  listTools() {
    return this.request("tools/list", {});
  }

  callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    this.writeMessage(message);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  notify(method, params = {}) {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  writeMessage(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.process.stdin.write(body);
  }

  readChunk(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (this.buffer.length < end) return;
      const payload = JSON.parse(this.buffer.slice(start, end).toString("utf8"));
      this.buffer = this.buffer.slice(end);
      this.handleMessage(payload);
    }
  }

  handleMessage(message) {
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "MCP request failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  async close() {
    if (!this.process) return;
    this.process.stdin.end();
    this.process.kill();
  }
}

export class HttpMcpClient {
  constructor({ source, timeoutMs = 5000, credential = null, fetchImpl = globalThis.fetch }) {
    this.source = source;
    this.timeoutMs = timeoutMs;
    this.credential = credential;
    this.fetch = fetchImpl;
    this.nextId = 1;
  }

  initialize() {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "peng-agent", version: "0.1.0" }
    });
  }

  listTools() {
    return this.request("tools/list", {});
  }

  callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  async notify(method, params = {}) {
    await this.post({ jsonrpc: "2.0", method, params }, false);
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const payload = await this.post({ jsonrpc: "2.0", id, method, params }, true);
    if (payload.error) throw new Error(payload.error.message ?? "MCP request failed");
    return payload.result;
  }

  async post(message, expectResponse) {
    if (!this.fetch) throw new Error("No fetch implementation available for HTTP MCP.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.source.mcp.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...mcpCredentialHeaders(this.source, this.credential),
          ...(this.source.mcp.headers ?? {})
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP MCP request failed: ${response.status}`);
      if (!expectResponse || response.status === 202 || response.status === 204) return {};
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function summarizeMcpTools(result) {
  return (result.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
  }));
}

export function mcpCredentialEnv(source, credential) {
  if (!credential?.value) return {};
  const envName = source.mcp?.credentialEnv ?? source.mcp?.tokenEnv;
  if (!envName) return {};
  return { [envName]: String(credential.value) };
}

export function mcpCredentialHeaders(source, credential) {
  if (!credential?.value) return {};
  const authType = source.mcp?.authType ?? "none";
  if (authType === "bearer" || authType === "oauth") {
    return { authorization: `${source.mcp?.authScheme ?? "Bearer"} ${String(credential.value)}` };
  }
  if (authType === "header") {
    return { [source.mcp?.headerName ?? "Authorization"]: String(credential.value) };
  }
  return {};
}
