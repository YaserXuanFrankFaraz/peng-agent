let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readFrames();
});

function readFrames() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1] ?? 0);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.slice(start, end).toString("utf8"));
    buffer = buffer.slice(end);
    handleMessage(message);
  }
}

function handleMessage(message) {
  if (!message.id) return;
  if (message.method === "initialize") {
    return write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "mock-mcp", version: "0.1.0" },
        capabilities: { tools: {} }
      }
    });
  }
  if (message.method === "tools/list") {
    return write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } }
            }
          },
          {
            name: "secret_env",
            description: "Read injected secret env.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } }
            }
          }
        ]
      }
    });
  }
  if (message.method === "tools/call") {
    if (message.params?.name === "secret_env") {
      return write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: process.env[message.params?.arguments?.name] ?? "" }],
          isError: false
        }
      });
    }
    return write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: message.params?.arguments?.text ?? "" }],
        isError: false
      }
    });
  }
  write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } });
}

function write(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
