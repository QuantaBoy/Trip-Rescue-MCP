// Starts server.js and drives the demo story through a real MCP client. Usage: npm run test:mcp
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 3999;
const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok) => srv.stdout.once("data", ok));

try {
  const client = new Client({ name: "triprescue-test", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));
  console.log("protocol", client.transport.protocolVersion);

  const { tools } = await client.listTools();
  console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(", "));
  assert.equal(tools.length, 12);

  const call = async (name, args = {}) => {
    const t0 = performance.now();
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    const out = r.isError ? { error: text } : JSON.parse(text);
    console.log(`\n[${name}] ${(performance.now() - t0).toFixed(0)} ms  ${out.speech ?? out.error}`);
    return out;
  };

  const early = await call("build_itinerary");
  assert.match(early.error, /No trip yet/, "errors must be helpful, not crashes");

  await call("start_trip_planning", { destination: "Goa" });
  await call("build_itinerary");
  const v = await call("trip_verdict", { scenario: "monsoon" });
  assert.equal(v.news.source, "google-news");
  await call("check_disruption", { scenario: "monsoon" });
  const re = await call("replan_trip");
  assert.ok(re.needsConfirmation);
  await call("confirm_booking", { confirm: true });

  // two users with different session ids must not see each other's trip
  const other = new Client({ name: "triprescue-test-2", version: "0.1.0" });
  await other.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), { requestInit: { headers: { "x-session-id": "judge-2" } } }));
  const isolated = await other.callTool({ name: "budget_breakdown", arguments: {} });
  assert.ok(isolated.isError && /No trip yet/.test(isolated.content[0].text), "a second session must start with no trip");
  await other.close();
  console.log("\nsession isolation ok");

  const bad = await client.callTool({ name: "start_trip_planning", arguments: { destination: "Goa", days: 99 } });
  assert.ok(bad.isError, "invalid input must be rejected");

  await client.close();
  console.log("\nmcp checks passed");
} finally {
  srv.kill();
}
