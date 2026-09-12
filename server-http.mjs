import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "./mcp-server.mjs";

const port = Number.parseInt(process.env.PORT || "3777", 10);
const host = process.env.HOST || "127.0.0.1";
const allowedHosts = (process.env.ALLOWED_HOSTS || "127.0.0.1,localhost,obsidian-mcp")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const app = createMcpExpressApp({ host, allowedHosts });

app.get("/healthz", (_request, response) => {
  response.json({ ok: true, service: "obsidian-vault-mcp" });
});

app.post("/mcp", async (request, response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  } finally {
    response.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  }
});

app.get("/mcp", (_request, response) => {
  response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.delete("/mcp", (_request, response) => {
  response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.listen(port, host, (error) => {
  if (error) {
    console.error("Failed to start MCP server", error);
    process.exit(1);
  }
  console.log(`Obsidian MCP listening on http://${host}:${port}/mcp`);
});
