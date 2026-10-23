// Simulated Alexa+: Bedrock is the assistant, and it reaches TripRescue only through the MCP server,
// exactly as Alexa+ would. The page (public/index.html) talks to POST /chat.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { converseRaw, bedrockEnabled } from "./bedrock.js";
import { buildServer } from "./mcp.js";
import { withSession } from "./planner.js";

const SYSTEM = `You are Alexa, a warm and sharp voice assistant, using the TripRescue skill to plan and rescue trips in India.
Today is ${new Date().toISOString().slice(0, 10)}. Prices are in Indian rupees.

How to think:
- First work out what the user actually wants right now, using the whole conversation. Then decide which tool, if any, gets that answer.
- If you are missing something essential (for example they ask "is it worth going?" but no destination is known), ask one short question instead of calling a tool.
- Tool results are data for you to reason about, not a script. The "speech" field is only a rough draft: never read it out word for word. Pick the two or three facts that matter for this user's question, explain the why in plain words, and connect it to what they told you (budget, likes, dates).
- When a tool returns an error, understand it and guide the user to the next step in your own words.
- Do only what the user just asked, usually one tool call. Planning a trip means start_trip_planning only; build the itinerary, verdict or budget only when asked.
- Replies are spoken aloud: 2 to 4 natural sentences, like a friend who knows travel. No markdown, no lists, no emoji, no <thinking> tags. Always end your turn with the spoken reply, usually with a helpful next question.
- After start_trip_planning, ask before building the itinerary unless the user already asked for a plan.
- Never switch destination on your own. After trip_verdict, read the verdict and let the user decide.
- Only call confirm_booking with confirm=true after the user clearly says yes in their latest message.
- If a tool returns an error, say what the user should do next.`;

const MAX_STEPS = 6; // tool calls per user message
const YES = /\b(yes|yeah|yep|yup|confirm|confirmed|book it|go ahead|do it|sure|okay|ok)\b/i;
// which simulated feed the demo uses; the model never picks it
const SCENARIO = process.env.DEMO_SCENARIO === "normal" ? "normal" : "monsoon";
const SCENARIO_TOOLS = new Set(["trip_verdict", "check_disruption"]);
const sessions = new Map(); // ponytail: in-memory chat history, cleared on restart
const states = new Map(); // per session: what the side panel shows

// pull the few fields the page displays out of a tool result
function digest(tool, out, state) {
  if (tool === "start_trip_planning") return Object.assign(state, out.trip, { verdict: null, confidence: null, basedOn: null, headline: null, alternative: null, total: null, hotel: null, booked: false });
  if (tool === "build_itinerary") return Object.assign(state, { hotel: out.hotel?.name, total: out.total });
  if (tool === "budget_breakdown") return Object.assign(state, { total: out.total });
  if (tool === "trip_verdict")
    return Object.assign(state, { verdict: out.verdict, confidence: out.confidence, basedOn: out.basedOn, headline: out.news?.headlines?.[0]?.title ?? null, newsLive: out.news?.live, alternative: out.alternative?.destination ?? null });
  if (tool === "confirm_booking" && out.booked) return Object.assign(state, { booked: true });
  if (tool === "confirm_booking" && out.total) return Object.assign(state, { total: out.total });
}
let mcp;

// in-process MCP connection to the same 12 tools /mcp serves (works on Lambda, where there is no local port)
async function mcpClient() {
  if (mcp) return mcp;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const c = new Client({ name: "triprescue-alexa-sim", version: "0.1.0" });
  await c.connect(clientSide);
  const { tools } = await c.listTools();
  // MCP tool list -> Bedrock toolSpec list
  const specs = tools.map((t) => {
    const { $schema, ...json } = t.inputSchema;
    if (json.properties?.scenario) {
      const { scenario, ...rest } = json.properties;
      json.properties = rest;
    }
    return { toolSpec: { name: t.name, description: t.description, inputSchema: { json } } };
  });
  return (mcp = { c, specs });
}

export async function chat({ sessionId, text }) {
  if (!bedrockEnabled()) return { reply: "Bedrock is not configured, so the voice assistant is offline. Add your key to .env and restart.", calls: [] };
  const { c, specs } = await mcpClient();
  const history = sessions.get(sessionId) ?? [];
  const state = states.get(sessionId) ?? {};
  states.set(sessionId, state);
  history.push({ role: "user", content: [{ text: String(text).slice(0, 500) }] });
  const calls = [];
  let lastSpeech = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await converseRaw({ system: SYSTEM, messages: history, tools: specs });
    const msg = res.output.message;
    history.push(msg);
    const uses = msg.content.filter((b) => b.toolUse);
    if (!uses.length) {
      sessions.set(sessionId, history.slice(-30)); // keep the last turns only
      // Nova sometimes writes its reasoning in <thinking> tags and stops; never show that, fall back to the tool's speech
      const said = msg.content.map((b) => b.text ?? "").join(" ").replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, "").trim();
      return { reply: said || lastSpeech || "Sorry, I didn't catch that. Could you say it again?", calls, state };
    }
    const results = [];
    for (const { toolUse } of uses) {
      // hard guard: bookings and plan changes only after the user's own latest message says yes
      if (toolUse.name === "confirm_booking" && !YES.test(text)) {
        calls.push({ tool: toolUse.name, input: toolUse.input, ms: 0, error: true, blocked: true });
        results.push({ toolResult: { toolUseId: toolUse.toolUseId, content: [{ text: "Blocked: the user has not said yes in their latest message. Explain what would be booked or changed and ask them to confirm." }], status: "error" } });
        continue;
      }
      const t0 = performance.now();
      const args = { ...(toolUse.input ?? {}) };
      if (SCENARIO_TOOLS.has(toolUse.name)) args.scenario = SCENARIO;
      const r = await withSession(sessionId, () => c.callTool({ name: toolUse.name, arguments: args }));
      const body = r.content?.[0]?.text ?? "";
      calls.push({ tool: toolUse.name, input: toolUse.input, ms: Math.round(performance.now() - t0), error: Boolean(r.isError) });
      if (!r.isError) {
        try {
          const out = JSON.parse(body);
          digest(toolUse.name, out, state);
          lastSpeech = out.speech ?? lastSpeech;
        } catch {} // non-JSON result: panel just doesn't update
      }
      results.push({ toolResult: { toolUseId: toolUse.toolUseId, content: [{ text: body }], status: r.isError ? "error" : "success" } });
    }
    history.push({ role: "user", content: results });
  }
  // step limit hit: answer with the last tool's own speech rather than an apology
  sessions.set(sessionId, history.slice(-30));
  return { reply: lastSpeech ?? "Sorry, that took too many steps. Could you say it more simply?", calls, state };
}
