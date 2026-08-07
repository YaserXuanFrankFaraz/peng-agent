import { createRuntime } from "./runtime.js";
import { createServer } from "./server.js";
import { JsonStore } from "./store.js";
import { createDefaultTools } from "./tools.js";
import { createProviderFromEnv } from "./provider.js";

export const CRAFT_SERVER_MANIFEST = {
  name: "craft-server",
  packageName: "@craft-agent/server",
  compatibility: "clean-room",
  protocolVersion: 1,
  transports: ["http", "sse", "websocket"],
  endpoints: ["/health", "/events", "/ws", "/api/run", "/api/threads", "/api/tools"]
};

export function parseServerOptions(args = [], env = process.env, cwd = process.cwd()) {
  return {
    host: readFlag(args, "--host") ?? env.PENG_HOST ?? env.HOST ?? "127.0.0.1",
    port: Number(readFlag(args, "--port") ?? env.PENG_PORT ?? env.PORT ?? 4721),
    workspace: readFlag(args, "--workspace") ?? env.PENG_WORKSPACE ?? cwd,
    json: hasFlag(args, "--json")
  };
}

export function createServerRuntime({ workspace, provider = createProviderFromEnv(), store = new JsonStore({ workspace }) } = {}) {
  return createRuntime({
    workspace,
    store,
    provider,
    tools: createDefaultTools({ workspace })
  });
}

export async function startHeadlessServer({ args = [], env = process.env, cwd = process.cwd(), stdout = console.log } = {}) {
  const options = parseServerOptions(args, env, cwd);
  const runtime = createServerRuntime({ workspace: options.workspace });
  const app = createServer({ runtime, workspace: options.workspace });
  const address = await app.listen({ host: options.host, port: options.port });
  const url = `http://${options.host}:${address.port}`;
  const info = {
    ...CRAFT_SERVER_MANIFEST,
    url,
    host: options.host,
    port: address.port,
    workspace: options.workspace
  };
  stdout(options.json ? JSON.stringify(info) : `Peng craft-server listening on ${url}`);
  return { app, runtime, address, info };
}

export function serverHelp() {
  return `craft-server

Usage:
  craft-server [--host 127.0.0.1] [--port 4721] [--workspace <path>] [--json]
  craft-server --manifest

Environment:
  PENG_HOST       Host override
  PENG_PORT       Port override
  PENG_WORKSPACE  Workspace root override

This entrypoint provides the Peng/Craft-compatible headless server boundary.
`;
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function hasFlag(args, name) {
  return args.includes(name);
}
