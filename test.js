// Runs the full demo story against planner.js and checks each step. Usage: npm test
import assert from "node:assert/strict";
import * as P from "./planner.js";

const step = (name, r) => console.log(`\n[${name}] ${r.speech}`);

step("start", P.startTripPlanning({ destination: "Goa" }));

const it = P.buildItinerary();
step("itinerary", it);
const items = it.plan.flatMap((d) => d.items);
assert.ok(it.total <= 60000, "plan must fit the ₹60k budget");
assert.ok(it.hotel.features.includes("pool"), "hotel should have a pool");
assert.ok(!items.some((i) => i.tags.includes("museum")), "museums must be skipped");
const wedding = it.plan.find((d) => d.date === "2026-12-12");
assert.ok(wedding.items.reduce((s, i) => s + i.hours, 0) <= 5, "wedding day must stay light");

step("budget", P.budgetBreakdown());

// story checks use saved news so results stay the same; the live check is below
const skip = await P.tripVerdict({ scenario: "monsoon", liveNews: false });
step("verdict monsoon", skip);
console.log(`  ${skip.basedOn}, risk ${skip.risk}, ${skip.ms} ms`);
assert.equal(skip.verdict, "SKIP");
assert.equal(skip.alternative?.destination, "Gokarna");

const go = await P.tripVerdict({ scenario: "normal", liveNews: false });
step("verdict normal", go);
console.log(`  ${go.basedOn}, risk ${go.risk}, ${go.ms} ms`);
assert.equal(go.verdict, "GO");

const dis = await P.checkDisruption({ scenario: "monsoon", liveWeather: false });
step("disruption", dis);
assert.deepEqual(dis.rainyDays, [4, 5]);
assert.ok(dis.affected.length > 0, "rain should affect outdoor plans");

const before = JSON.stringify(P.budgetBreakdown());
const re = await P.replanTrip();
step("replan", re);
assert.ok(re.changes.length > 0 && re.changes.every((c) => c.to.indoor), "replacements must be indoor");
assert.equal(JSON.stringify(P.budgetBreakdown()), before, "nothing changes before confirm");

step("explain", P.explainChanges());

step("confirm no", P.confirmBooking({ confirm: false }));
assert.equal(JSON.stringify(P.budgetBreakdown()), before, "'no' must not change the plan");
const yes = P.confirmBooking({ confirm: true });
step("confirm yes", yes);
assert.ok(yes.applied);
step("book", P.confirmBooking({ confirm: true }));

// latency: analyze every destination over the full dataset
const t0 = performance.now();
const all = ["goa", "gokarna", "manali", "jaipur", "kochi", "leh", "andaman", "delhi"].map((id) => P.analyzePosts({ destId: id, scenario: "monsoon" }));
const ms = performance.now() - t0;
console.log(`\n[latency] ${all.length} destinations x ${all[0].totalScanned.toLocaleString("en-IN")} posts in ${ms.toFixed(0)} ms`);
assert.ok(ms < 1000, "analysis must stay under 1 s");

// live news is mandatory: this fails if Google News is unreachable
const live = await P.tripVerdict({ scenario: "monsoon" });
step("verdict live news", live);
console.log(`  ${live.news.count} live headlines, verdict ${live.verdict}, risk ${live.risk}, ${live.ms} ms`);
assert.equal(live.news.source, "google-news", "live news must work");
assert.ok(live.news.count > 0, "live news must return headlines");
const cached = await P.tripVerdict({ scenario: "monsoon" });
console.log(`  second call (cached news): ${cached.ms} ms`);

console.log("\nall checks passed");
