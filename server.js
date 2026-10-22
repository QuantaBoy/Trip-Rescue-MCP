// TripRescue MCP server: Streamable HTTP (spec 2025-11-25) at /mcp, exposing planner.js as 12 tools.
import express from "express";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as P from "./planner.js";
import { chat } from "./chat.js";

const scenario = z.enum(["monsoon", "normal"]).optional().describe("Demo data set of social posts and fallback weather. Default monsoon.");

function buildServer() {
  const server = new McpServer({ name: "triprescue", version: "0.1.0" });

  // Every tool returns JSON with a short "speech" field for Alexa+ to read aloud.
  // Errors come back as helpful messages, never crashes, so the conversation has no dead ends.
  const tool = (name, description, inputSchema, fn, annotations = {}) =>
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await fn(args)) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    });

  tool(
    "start_trip_planning",
    "Start a new trip when the user says where they want to go. Also checks the calendar for those dates.",
    {
      destination: z.string().max(60).describe("City or region, e.g. Goa"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default 2026-12-10"),
      days: z.number().int().min(1).max(14).optional().describe("Default 5"),
      budget: z.number().positive().max(10_000_000).optional().describe("Total budget in INR, default from profile"),
      travelers: z.number().int().min(1).max(20).optional(),
    },
    P.startTripPlanning,
  );
  tool("get_user_profile", "Get the user's saved likes, dislikes, budget and past trips.", {}, P.getUserProfile, { readOnlyHint: true });
  tool(
    "update_preferences",
    "Remember something the user likes or dislikes (e.g. 'I love scuba', 'no crowds'), or a new budget.",
    { like: z.string().max(40).optional(), dislike: z.string().max(40).optional(), budget: z.number().positive().max(10_000_000).optional() },
    P.updatePreferences,
  );
  tool(
    "check_calendar",
    "Check the user's calendar for busy days. Without dates, checks the current trip.",
    { startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: z.number().int().min(1).max(14).optional() },
    P.checkCalendar,
    { readOnlyHint: true },
  );
  tool(
    "search_hotels",
    "Find hotels ranked by what the user likes, within budget. Defaults to the current trip's destination.",
    { destination: z.string().max(60).optional(), maxPrice: z.number().positive().optional().describe("Max INR per night") },
    P.searchHotels,
    { readOnlyHint: true },
  );
  tool("build_itinerary", "Build the day-by-day plan for the current trip: hotel plus activities the user likes, within budget, keeping busy calendar days light.", {}, P.buildItinerary);
  tool("budget_breakdown", "Split the current plan's cost into hotel, activities and food, and show what's left.", {}, P.budgetBreakdown, { readOnlyHint: true });
  tool(
    "trip_verdict",
    "Should the user go now? Analyzes recent social media posts and live news about the destination and returns GO, WAIT or SKIP with confidence, evidence, affected plan items and a safer alternative. It never changes the trip. Read the verdict to the user and let them decide: keep the trip if they want, or, if they name another place, call start_trip_planning with it and run build_itinerary and trip_verdict again.",
    { scenario, liveNews: z.boolean().optional().describe("Use live Google News, default true") },
    P.tripVerdict,
    { readOnlyHint: true, openWorldHint: true },
  );
  tool(
    "check_disruption",
    "Check the weather forecast for the trip and list planned outdoor activities that rain would break.",
    { scenario, liveWeather: z.boolean().optional().describe("Use live Open-Meteo, default true") },
    P.checkDisruption,
    { readOnlyHint: true, openWorldHint: true },
  );
  tool("replan_trip", "Fix the plan after a disruption: swaps affected outdoor activities for indoor ones the user likes. Changes wait for confirm_booking.", {}, P.replanTrip);
  tool("explain_changes", "Explain what changed in the plan and why.", {}, P.explainChanges, { readOnlyHint: true });
  tool(
    "confirm_booking",
    "Apply pending changes, or book the trip if none are pending. Only call with confirm=true after the user clearly says yes.",
    { confirm: z.boolean() },
    P.confirmBooking,
    { destructiveHint: true },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "100kb" }));

// optional shared secret: set MCP_TOKEN and clients must send "Authorization: Bearer <token>"
app.use("/mcp", (req, res, next) => {
  const token = process.env.MCP_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) return res.status(401).json({ error: "unauthorized" });
  next();
});

// Stateless Streamable HTTP: a fresh server and transport per request. Trip state lives in planner.js.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
// stateless mode has no server-sent stream or session to delete
app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// simulated Alexa+ page: Bedrock as the assistant, calling this server's /mcp tools
const port = process.env.PORT || 3000;
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));
app.post("/chat", async (req, res) => {
  const { sessionId, text } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "sessionId and text are required" });
  try {
    res.json(await chat({ sessionId: sessionId.slice(0, 64), text, port }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: "Sorry, something went wrong on my side. Please try again.", calls: [] });
  }
});

app.listen(port, () => console.log(`TripRescue MCP server on http://localhost:${port}/mcp`));
