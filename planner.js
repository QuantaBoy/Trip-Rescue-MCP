// Trip planning logic. Plain code, no MCP: server.js wraps these functions as tools.
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { getNews, getForecast } from "./sources.js";
import { deepReadPosts, speak } from "./bedrock.js";

// Every tuning knob in one place
export const CONFIG = {
  windowHours: 72, // only posts from the last 3 days count
  minPosts: 5, // fewer posts than this = low confidence
  topN: 20, // highest-weighted posts kept as evidence
  deepReadN: 12, // of those, how many Bedrock re-reads (more = slower)
  skipAt: 0.6, // risk at or above = SKIP
  waitAt: 0.4, // risk at or above = WAIT, below = GO
  itineraryBoost: 2, // posts about places in your plan count double
  sourceTrust: { google: 1, tripadvisor: 1, news: 1, reddit: 0.9, x: 0.8, instagram: 0.8, youtube: 0.7 },
  rainMm: 20, // a day with this much rain disrupts outdoor plans
  foodPerPersonPerDay: 1000,
  hotelShare: 0.5, // hotel may use up to half the budget
  maxHoursPerDay: 8,
  itemsPerDay: 2,
};

const load = (p) => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const curatedDest = load("destinations.json");
const destinations = load("generated/destinations.json").map((d) => ({ ...d, ...curatedDest.find((c) => c.id === d.id) }));
const hotels = [...load("hotels.json"), ...load("generated/hotels.json")];
const places = [...load("places.json"), ...load("generated/places.json")];
const posts = load("generated/posts.json"); // already includes the curated demo posts
const calendar = load("calendar.json");
const profile = load("profile.json"); // in-memory copy; update_preferences changes it

// one trip per session; the caller sets the session with withSession()
// ponytail: in memory per server instance, so a restart or a second Lambda instance loses it; DynamoDB if that matters
const session = new AsyncLocalStorage();
const trips = new Map();
const sid = () => session.getStore() ?? "default";
const cur = () => trips.get(sid()) ?? null;
export const withSession = (id, fn) => session.run(String(id || "default").slice(0, 64), fn);

export const rupees = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const addDays = (date, i) => new Date(Date.parse(date + "T00:00:00Z") + i * 864e5).toISOString().slice(0, 10);
const nice = (date) => new Date(date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" });

function needTrip(withPlan = false) {
  const trip = cur();
  if (!trip) throw new Error("No trip yet. Say something like: plan a 5 day trip to Goa.");
  if (withPlan && !trip.plan) throw new Error("No itinerary yet. Say: build my itinerary.");
  return trip;
}

function findDest(name) {
  const q = String(name).trim().toLowerCase();
  const d = destinations.find((x) => x.id === q || x.name.toLowerCase() === q);
  if (!d) throw new Error(`I don't know ${name} yet. Try one of: ${destinations.slice(0, 8).map((x) => x.name).join(", ")}.`);
  return d;
}

// ---------- social media analysis ----------

const TOPICS = {
  flood: ["flood", "waterlog", "heavy rain", "orange alert"],
  closure: ["closed", "cancelled", "shut", "suspended"],
  crowd: ["crowds", "crowded", "packed", "queues"],
  price: ["prices", "overcharg", "overpriced", "expensive", "triple fare", "doubled"],
  safety: ["stolen", "rough", "red flag", "landslide", "warning", "alert", "high wave", "cyclone"],
  positive: ["beautiful", "calm", "clean", "amazing", "worth", "sunny", "quiet", "perfect", "great", "loved", "open", "buzzing", "clear", "cozy", "unreal", "fun", "highlight", "dry"],
};

// keyword classifier: topic + sentiment in [-1, 1]
export function classify(text, { ignoreCrowd = false } = {}) {
  const t = text.toLowerCase();
  let pos = 0, neg = 0, topic = "neutral", best = 0;
  for (const [name, words] of Object.entries(TOPICS)) {
    if (name === "crowd" && ignoreCrowd) continue;
    const hits = words.filter((w) => t.includes(w)).length;
    if (!hits) continue;
    if (name === "positive") pos += hits;
    else neg += hits;
    if (hits > best) (best = hits), (topic = name);
  }
  return { topic, sentiment: pos + neg ? (pos - neg) / (pos + neg) : 0 };
}

// scan every post, keep the relevant ones, weight them, score risk overall and per place
export function analyzePosts({ destId, scenario, itineraryAreas = [], extra = [] }) {
  const t0 = performance.now();
  const ignoreCrowd = !profile.dislikes.includes("crowds");
  const relevant = posts.filter((p) => p.destination === destId && p.scenario === scenario && p.hoursAgo <= CONFIG.windowHours).concat(extra);
  let negW = 0, totW = 0;
  const byPlace = {};
  const scored = [];
  for (const p of relevant) {
    const c = classify(p.text, { ignoreCrowd });
    const w =
      (1 / (1 + p.hoursAgo / 24)) *
      Math.log10(p.likes + 10) *
      (CONFIG.sourceTrust[p.source] ?? 0.8) *
      (itineraryAreas.includes(p.place) ? CONFIG.itineraryBoost : 1);
    negW += w * Math.max(0, -c.sentiment);
    totW += w * Math.abs(c.sentiment);
    const pl = (byPlace[p.place] ??= { place: p.place, posts: 0, neg: 0, tot: 0, topics: {} });
    pl.posts++;
    pl.neg += w * Math.max(0, -c.sentiment);
    pl.tot += w * Math.abs(c.sentiment);
    if (c.sentiment < 0) pl.topics[c.topic] = (pl.topics[c.topic] ?? 0) + 1;
    scored.push({ ...p, ...c, weight: Number(w.toFixed(3)) });
  }
  const placeRisk = Object.values(byPlace)
    .map((p) => ({
      place: p.place,
      posts: p.posts,
      risk: Number((p.tot ? p.neg / p.tot : 0).toFixed(2)),
      mainIssue: Object.entries(p.topics).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }))
    .sort((a, b) => b.risk - a.risk);
  return {
    destination: destId,
    totalScanned: posts.length + extra.length,
    relevantPosts: relevant.length,
    risk: Number((totW ? negW / totW : 0).toFixed(2)),
    negW,
    totW,
    placeRisk,
    top: scored.sort((a, b) => b.weight - a.weight).slice(0, CONFIG.topN),
    ms: Number((performance.now() - t0).toFixed(1)),
  };
}

const decide = (risk) => (risk >= CONFIG.skipAt ? "SKIP" : risk >= CONFIG.waitAt ? "WAIT" : "GO");

// ---------- tools ----------

export function startTripPlanning({ destination, startDate = "2026-12-10", days = 5, budget, travelers }) {
  const d = findDest(destination);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error("Start date must look like 2026-12-10.");
  if (!(days >= 1 && days <= 14)) throw new Error("Trips can be 1 to 14 days.");
  const dates = Array.from({ length: days }, (_, i) => addDays(startDate, i));
  const trip = { destination: d.id, name: d.name, startDate, days, dates, budget: budget ?? profile.budget, travelers: travelers ?? profile.travelers, plan: null, hotel: null, pending: null, history: [], status: "planning" };
  trips.set(sid(), trip);
  const cal = checkCalendar();
  return {
    trip: { destination: d.name, startDate, days, budget: trip.budget, travelers: trip.travelers },
    calendarConflicts: cal.conflicts,
    speech: `Starting a ${days} day ${d.name} trip from ${nice(startDate)} for ${trip.travelers}, budget ${rupees(trip.budget)}.${cal.conflicts.length ? " " + cal.speech : ""} Want me to build the itinerary?`,
  };
}

export function getUserProfile() {
  return { profile, speech: `You like ${profile.likes.join(", ")}, and you avoid ${profile.dislikes.join(" and ")}. Your usual budget is ${rupees(profile.budget)} for ${profile.travelers}.` };
}

export function updatePreferences({ like, dislike, budget }) {
  const norm = (s) => s?.trim().toLowerCase();
  if (norm(like) && !profile.likes.includes(norm(like))) (profile.likes.push(norm(like)), (profile.dislikes = profile.dislikes.filter((x) => x !== norm(like))));
  if (norm(dislike) && !profile.dislikes.includes(norm(dislike))) (profile.dislikes.push(norm(dislike)), (profile.likes = profile.likes.filter((x) => x !== norm(dislike))));
  if (budget != null) {
    if (!(budget > 0)) throw new Error("Budget must be a positive number of rupees.");
    profile.budget = budget;
    if (cur()) cur().budget = budget;
  }
  return { profile, speech: `Got it. I'll remember that${like ? ` you like ${like}` : ""}${like && dislike ? " and" : ""}${dislike ? ` you don't like ${dislike}` : ""}${budget ? `${like || dislike ? ", and" : ""} your budget is ${rupees(budget)}` : ""}.` };
}

export function checkCalendar({ startDate, days } = {}) {
  const dates = startDate ? Array.from({ length: days ?? 5 }, (_, i) => addDays(startDate, i)) : needTrip().dates;
  const conflicts = calendar.busy.filter((b) => dates.includes(b.date)).map((b) => ({ ...b, day: dates.indexOf(b.date) + 1 }));
  return {
    conflicts,
    speech: conflicts.length
      ? conflicts.map((c) => `Day ${c.day} has ${c.title}${c.allDay ? ", so I'll keep it free" : `, so I'll keep that day light and free from ${c.from}`}.`).join(" ")
      : "Your calendar is free for those dates.",
  };
}

const likeScore = (tags) => tags.reduce((s, t) => s + (profile.likes.includes(t) ? 2 : 0), 0);
const disliked = (tags) => tags.some((t) => profile.dislikes.includes(t));

export function searchHotels({ destination, maxPrice } = {}) {
  const d = destination ? findDest(destination) : findDest(needTrip().destination);
  const trip = cur();
  const nights = trip?.destination === d.id ? trip.days : 5;
  const cap = maxPrice ?? ((trip?.budget ?? profile.budget) * CONFIG.hotelShare) / nights;
  const list = hotels
    .filter((h) => h.destination === d.id && h.pricePerNight <= cap && !disliked(h.features))
    .map((h) => ({ ...h, score: likeScore(h.features) + h.rating }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (!list.length) return { hotels: [], speech: `No hotels in ${d.name} fit under ${rupees(cap)} a night. Want me to raise the limit?` };
  const h = list[0];
  const why = h.features.filter((f) => profile.likes.includes(f));
  return { hotels: list, speech: `Top pick is ${h.name} in ${h.area} at ${rupees(h.pricePerNight)} a night, rated ${h.rating}${why.length ? `, because it has ${why.join(" and ")}, which you like` : ""}.` };
}

export function buildItinerary() {
  const t = needTrip();
  const hotel = searchHotels().hotels[0];
  if (!hotel) throw new Error("No hotel fits the budget. Raise the budget or pick another place.");
  const busy = checkCalendar().conflicts;
  const food = CONFIG.foodPerPersonPerDay * t.travelers * t.days;
  let left = t.budget - hotel.pricePerNight * t.days - food;
  const pool = places
    .filter((p) => p.destination === t.destination && !disliked(p.tags))
    .map((p) => ({ ...p, score: likeScore(p.tags) }));
  const used = new Set();
  const tagUse = {};
  const plan = t.dates.map((date, i) => {
    const b = busy.find((x) => x.date === date);
    const maxHours = b ? (b.allDay ? 0 : 5) : CONFIG.maxHoursPerDay;
    const items = [];
    let hours = 0;
    while (items.length < CONFIG.itemsPerDay) {
      // best unused place: liked tags first, then a tag not used yet, then outdoor (indoor kept as rain backup), then cheaper
      const rank = (p) => p.score * 10 - (tagUse[p.tags[0]] ?? 0) * 3 + (p.indoor ? 0 : 1);
      const next = pool
        .filter((p) => !used.has(p.id) && hours + p.hours <= maxHours && p.cost <= left)
        .sort((a, b) => rank(b) - rank(a) || a.cost - b.cost)[0];
      if (!next) break;
      used.add(next.id);
      tagUse[next.tags[0]] = (tagUse[next.tags[0]] ?? 0) + 1;
      left -= next.cost;
      hours += next.hours;
      items.push({ id: next.id, name: next.name, area: next.area, cost: next.cost, indoor: next.indoor, hours: next.hours, tags: next.tags });
    }
    return { day: i + 1, date, note: b ? `${b.title}${b.allDay ? ", kept free" : `, free from ${b.from}`}` : null, items };
  });
  t.hotel = hotel;
  t.plan = plan;
  t.pending = null;
  const bd = budgetBreakdown();
  return {
    hotel: { name: hotel.name, area: hotel.area, pricePerNight: hotel.pricePerNight, features: hotel.features },
    plan,
    total: bd.total,
    speech: `Here's your ${t.days} day ${t.name} plan at ${hotel.name}, which has ${hotel.features.filter((f) => profile.likes.includes(f)).join(" and ") || "a good rating"}. Day 1: ${plan[0].items.map((x) => x.name).join(" and ") || "rest"}. I skipped ${profile.dislikes.join(" and ")}${busy.length ? `, and kept day ${busy[0].day} ${busy[0].allDay ? "free" : "light"} for ${busy[0].title}` : ""}. Total ${rupees(bd.total)}, within your ${rupees(t.budget)}.`,
  };
}

export function budgetBreakdown() {
  const t = needTrip(true);
  const hotel = t.hotel.pricePerNight * t.days;
  const activities = t.plan.flatMap((d) => d.items).reduce((s, x) => s + x.cost, 0);
  const food = CONFIG.foodPerPersonPerDay * t.travelers * t.days;
  const total = hotel + activities + food;
  return {
    hotel, activities, food, total, budget: t.budget, remaining: t.budget - total,
    speech: `Hotel ${rupees(hotel)}, activities ${rupees(activities)}, food ${rupees(food)}. Total ${rupees(total)}, leaving ${rupees(t.budget - total)} of your budget.`,
  };
}

export async function tripVerdict({ scenario = "monsoon", liveNews = true, deepRead = true } = {}) {
  const t0 = performance.now();
  const t = needTrip();
  const d = findDest(t.destination);
  const areas = (t.plan ?? []).flatMap((x) => x.items.map((i) => i.area));
  const news = await getNews(d, scenario, liveNews);
  const a = analyzePosts({ destId: d.id, scenario, itineraryAreas: areas, extra: news.items });

  // stage 2: Bedrock re-reads the top-weighted posts; its sentiment replaces the keyword one for those posts
  const reread = deepRead ? await deepReadPosts(a.top.slice(0, CONFIG.deepReadN)) : null;
  if (reread) {
    let { negW, totW } = a;
    for (const p of a.top) {
      const b = reread[p.id ?? `${p.source}:${p.text}`];
      if (!b) continue;
      negW += p.weight * (Math.max(0, -b.sentiment) - Math.max(0, -p.sentiment));
      totW += p.weight * (Math.abs(b.sentiment) - Math.abs(p.sentiment));
      Object.assign(p, b);
    }
    a.risk = Number((totW ? negW / totW : 0).toFixed(2));
  }
  const verdict = decide(a.risk);
  const agreement = Math.abs(2 * a.risk - 1); // 1 = posts all agree, 0 = split
  const confidence = a.relevantPosts < CONFIG.minPosts ? 35 : Math.round(Math.min(95, 40 + 12 * Math.log10(a.relevantPosts) + 30 * agreement));
  // news items are about the whole destination, so they don't count as a hotspot place
  const hotspots = a.placeRisk.filter((p) => p.risk >= 0.5 && p.posts >= 2 && p.place !== d.name);
  const affected = (t.plan ?? []).flatMap((x) => x.items.filter((i) => hotspots.some((h) => h.place === i.area)).map((i) => ({ day: x.day, name: i.name, area: i.area })));

  let alternative = null;
  if (verdict !== "GO") {
    // compare every similar destination: this scans the whole dataset again per place
    const options = destinations
      .filter((x) => x.id !== d.id && x.coastal === d.coastal)
      .map((x) => ({ x, r: analyzePosts({ destId: x.id, scenario }) }))
      .filter((o) => o.r.relevantPosts >= CONFIG.minPosts)
      .sort((p, q) => p.r.risk - q.r.risk);
    if (options[0]) alternative = { destination: options[0].x.name, risk: options[0].r.risk, about: options[0].x.about ?? null };
  }

  const bad = a.top.filter((p) => p.sentiment < 0).slice(0, 3);
  const evidence = (verdict === "GO" ? a.top.filter((p) => p.sentiment > 0) : bad).slice(0, 3).map((p) => ({ source: p.source, place: p.place, hoursAgo: p.hoursAgo, text: p.text }));
  const issue = hotspots[0];
  const speech = {
    GO: `My verdict is go, ${confidence}% confident. ${a.relevantPosts} recent posts about ${d.name} look good${evidence[0] ? `, like: ${evidence[0].text}` : ""}.`,
    WAIT: `My verdict is wait, ${confidence}% confident. ${a.relevantPosts} recent posts show problems${issue ? `, mostly ${issue.mainIssue} around ${issue.place}` : ""}${bad[0] ? `: ${bad[0].text}` : ""}.${alternative ? ` ${alternative.destination} looks better right now.` : ""}`,
    SKIP: `My verdict is skip, ${confidence}% confident. ${a.relevantPosts} recent posts report serious problems in ${d.name}${issue ? `, mostly ${issue.mainIssue} around ${issue.place}` : ""}${bad[0] ? `: ${bad[0].text}` : ""}.${affected.length ? ` That hits ${affected.length} things in your plan.` : ""}${alternative ? ` ${alternative.destination} looks safer${alternative.about ? `: ${alternative.about.replace(/\.$/, "")}` : ""}.` : ""}`,
  }[verdict];
  // the user decides: never switch destination on our own, always ask
  const question =
    verdict === "GO"
      ? " Shall I go ahead with this plan?"
      : ` Do you still want to go to ${d.name}, or should I check another place${alternative ? ` like ${alternative.destination}` : ""}?`;
  // headlines naming the destination and saying something good or bad first, then newest
  const rel = (n) => (n.text.toLowerCase().includes(d.name.toLowerCase()) ? 2 : 0) + (n.topic !== "neutral" ? 1 : 0);
  const headlines = news.items
    .map((n) => ({ ...n, ...classify(n.text) }))
    .sort((p, q) => rel(q) - rel(p) || p.hoursAgo - q.hoursAgo)
    .slice(0, 3)
    .map((n) => ({ title: n.text, outlet: n.outlet, hoursAgo: n.hoursAgo, topic: n.topic }));
  t.verdict = verdict;
  const plain = speech + (headlines[0] ? ` Latest news${news.live ? "" : " (saved copy)"}: ${headlines[0].title}${headlines[0].outlet ? `, from ${headlines[0].outlet}` : ""}.` : " I couldn't find any recent news.") + question;
  const spoken = deepRead ? await speak(plain) : { text: plain, by: "plain" };
  return {
    analysis: reread ? `keywords on all posts, Bedrock deep read of top ${Object.keys(reread).length}` : "keywords",
    wording: spoken.by,
    news: { source: news.source, live: news.live, count: news.items.length, headlines },
    verdict,
    confidence: `${confidence}%`,
    risk: a.risk,
    basedOn: `${a.relevantPosts} posts from the last ${CONFIG.windowHours} hours, filtered from ${a.totalScanned.toLocaleString("en-IN")}`,
    newsSource: news.source,
    hotspots: hotspots.slice(0, 5),
    affectedPlan: affected,
    evidence,
    alternative,
    tripUnchanged: true,
    nextStep: verdict === "GO" ? "Wait for the user to confirm the plan." : `Ask the user. Keep ${d.name} if they insist. If they name another place, call start_trip_planning with it, then build_itinerary and trip_verdict again.`,
    ms: Number((performance.now() - t0).toFixed(1)),
    speech: spoken.text,
  };
}

export async function checkDisruption({ scenario = "monsoon", liveWeather = true } = {}) {
  const t = needTrip(true);
  const d = findDest(t.destination);
  const forecast = await getForecast(d, t.dates, scenario, liveWeather);
  const rainyDays = forecast.days.filter((x) => x.rainMm >= CONFIG.rainMm).map((x) => x.day);
  const affected = t.plan.filter((x) => rainyDays.includes(x.day)).flatMap((x) => x.items.filter((i) => !i.indoor).map((i) => ({ day: x.day, id: i.id, name: i.name, reason: "rain" })));
  t.disruption = { rainyDays, affected, forecast: forecast.days };
  return {
    weatherSource: forecast.source,
    forecast: forecast.days,
    rainyDays,
    affected,
    speech: affected.length
      ? `Heads up: heavy rain on day ${rainyDays.join(" and ")}. That affects ${affected.map((x) => x.name).join(", ")}. Want me to replan those days?`
      : "No disruptions. The weather looks fine for your plan.",
  };
}

export async function replanTrip() {
  const t = needTrip(true);
  if (!t.disruption) await checkDisruption();
  const { affected } = t.disruption;
  if (!affected.length) return { changes: [], speech: "Nothing needs changing. Your plan is fine." };
  const used = new Set(t.plan.flatMap((x) => x.items.map((i) => i.id)));
  const indoor = places
    .filter((p) => p.destination === t.destination && p.indoor && !disliked(p.tags) && !used.has(p.id))
    .sort((a, b) => likeScore(b.tags) - likeScore(a.tags) || a.cost - b.cost);
  const changes = [];
  for (const a of affected) {
    const from = t.plan[a.day - 1].items.find((i) => i.id === a.id);
    const to = indoor.find((p) => !used.has(p.id) && p.hours <= from.hours + 1);
    if (!to) continue;
    used.add(to.id);
    changes.push({ day: a.day, from: { id: from.id, name: from.name, cost: from.cost }, to: { id: to.id, name: to.name, area: to.area, cost: to.cost, indoor: true, hours: to.hours, tags: to.tags }, reason: a.reason });
  }
  const costDelta = changes.reduce((s, c) => s + c.to.cost - c.from.cost, 0);
  t.pending = { changes, costDelta };
  const list = changes.map((c) => `${c.from.name} for ${c.to.name} on day ${c.day}`).join(", ");
  return {
    changes,
    costDelta,
    needsConfirmation: true,
    speech: `Because of rain, I swapped ${list}. ${costDelta === 0 ? "Same cost." : costDelta > 0 ? `It costs ${rupees(costDelta)} more.` : `It saves ${rupees(-costDelta)}.`} Say yes to confirm.`,
  };
}

export function explainChanges() {
  const t = needTrip(true);
  const last = t.pending ?? t.history.at(-1);
  if (!last) return { speech: "I haven't changed anything in your plan yet." };
  return {
    status: t.pending ? "waiting for your yes" : "applied",
    changes: last.changes,
    speech: last.changes.map((c) => `Day ${c.day}: ${c.from.name} was outdoors and heavy rain is forecast, so I picked ${c.to.name}, which is indoors${c.to.tags.some((x) => profile.likes.includes(x)) ? ` and matches your love of ${c.to.tags.find((x) => profile.likes.includes(x))}` : ""}.`).join(" "),
  };
}

export function confirmBooking({ confirm } = {}) {
  const t = needTrip(true);
  if (confirm !== true) return { applied: false, speech: "Okay, I won't change or book anything until you say yes." };
  if (t.pending) {
    for (const c of t.pending.changes) {
      const day = t.plan[c.day - 1];
      day.items = day.items.map((i) => (i.id === c.from.id ? c.to : i));
    }
    t.history.push(t.pending);
    t.pending = null;
    t.disruption = null;
    return { applied: true, total: budgetBreakdown().total, speech: `Done. Your plan is updated, new total ${rupees(budgetBreakdown().total)}.` };
  }
  t.status = "booked";
  return { applied: true, booked: true, speech: `Booked (simulated): ${t.hotel.name} for ${t.days} nights from ${nice(t.startDate)}, total ${rupees(budgetBreakdown().total)}.` };
}
