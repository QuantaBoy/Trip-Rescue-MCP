// TripRescue MCP server: Streamable HTTP (spec 2025-11-25) at /mcp, plus the simulated Alexa+ page.
// Runs locally with `npm start`, or on AWS Lambda through lambda.js.
import express from "express";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withSession } from "./planner.js";
import { buildServer } from "./mcp.js";
import { chat } from "./chat.js";

export const app = express();
app.use(express.json({ limit: "100kb" }));

// optional shared secret: set MCP_TOKEN and clients must send "Authorization: Bearer <token>"
app.use("/mcp", (req, res, next) => {
  const token = process.env.MCP_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) return res.status(401).json({ error: "unauthorized" });
  next();
});

// Stateless Streamable HTTP: a fresh server and transport per request.
// Clients that send an "x-session-id" header get their own trip; others share the "default" trip.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await withSession(req.headers["x-session-id"], () => transport.handleRequest(req, res, req.body));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
// stateless mode has no server-sent stream or session to delete
app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// simulated Alexa+ page: Bedrock as the assistant, calling the MCP tools
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

// every chat message costs Bedrock calls on a public URL, so cap it per visitor
const CHAT_PER_MINUTE = 12;
const hits = new Map();
app.post("/chat", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] ?? req.ip;
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= CHAT_PER_MINUTE) return res.status(429).json({ reply: "You're going a bit fast. Give me a minute and try again.", calls: [] });
  hits.set(ip, [...recent, now]);

  const { sessionId, text } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "sessionId and text are required" });
  try {
    res.json(await chat({ sessionId: sessionId.slice(0, 64), text }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: "Sorry, something went wrong on my side. Please try again.", calls: [] });
  }
});

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`TripRescue MCP server on http://localhost:${port}/mcp`));
}
