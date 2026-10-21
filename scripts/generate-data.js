// Generates a large, deterministic dataset in data/generated/ for load and latency tests.
// Usage: node scripts/generate-data.js [postCount]   (default 50000)
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const POST_COUNT = Number(process.argv[2] ?? 50000);
const OUT = new URL("../data/generated/", import.meta.url);

// seeded PRNG (mulberry32) so every run produces identical data
let seed = 42;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// [id, name, lat, lon, coastal, areas]
const DESTS = [
  ["goa", "Goa", 15.4909, 73.8278, true, ["Baga", "Calangute", "Candolim", "Panjim", "Palolem", "Anjuna", "Grande Island", "Dudhsagar", "Vagator", "Colva"]],
  ["gokarna", "Gokarna", 14.5479, 74.3188, true, ["Om Beach", "Kudle Beach", "Paradise Beach", "Netrani", "Gokarna town"]],
  ["pondicherry", "Pondicherry", 11.9416, 79.8083, true, ["White Town", "Auroville", "Paradise Beach", "Promenade", "Serenity Beach"]],
  ["kochi", "Kochi", 9.9312, 76.2673, true, ["Fort Kochi", "Mattancherry", "Marine Drive", "Cherai Beach", "Willingdon Island"]],
  ["alleppey", "Alleppey", 9.4981, 76.3388, true, ["Backwaters", "Alleppey Beach", "Kumarakom", "Marari Beach", "Punnamada Lake"]],
  ["varkala", "Varkala", 8.7379, 76.7163, true, ["North Cliff", "Papanasam Beach", "Kappil", "Odayam Beach", "Varkala town"]],
  ["andaman", "Andaman", 11.6234, 92.7265, true, ["Havelock", "Radhanagar Beach", "Neil Island", "Port Blair", "Elephant Beach"]],
  ["mumbai", "Mumbai", 19.076, 72.8777, true, ["Colaba", "Juhu", "Bandra", "Marine Drive", "Lower Parel"]],
  ["manali", "Manali", 32.2432, 77.1892, false, ["Old Manali", "Solang Valley", "Rohtang Pass", "Mall Road", "Hadimba Temple"]],
  ["shimla", "Shimla", 31.1048, 77.1734, false, ["Mall Road", "Kufri", "Jakhoo", "Chail", "Mashobra"]],
  ["rishikesh", "Rishikesh", 30.0869, 78.2676, false, ["Laxman Jhula", "Tapovan", "Shivpuri", "Ram Jhula", "Neer Garh"]],
  ["leh", "Leh", 34.1526, 77.5771, false, ["Leh Palace", "Pangong Lake", "Nubra Valley", "Khardung La", "Magnetic Hill"]],
  ["jaipur", "Jaipur", 26.9124, 75.7873, false, ["Amber Fort", "Hawa Mahal", "City Palace", "Nahargarh", "Johari Bazaar"]],
  ["udaipur", "Udaipur", 24.5854, 73.7125, false, ["Lake Pichola", "City Palace", "Fateh Sagar", "Bagore Ki Haveli", "Sajjangarh"]],
  ["jaisalmer", "Jaisalmer", 26.9157, 70.9083, false, ["Sam Sand Dunes", "Jaisalmer Fort", "Patwon Ki Haveli", "Gadisar Lake", "Kuldhara"]],
  ["varanasi", "Varanasi", 25.3176, 82.9739, false, ["Dashashwamedh Ghat", "Assi Ghat", "Sarnath", "Kashi Vishwanath", "Manikarnika Ghat"]],
  ["darjeeling", "Darjeeling", 27.041, 88.2663, false, ["Tiger Hill", "Mall Road", "Batasia Loop", "Happy Valley", "Ghoom"]],
  ["munnar", "Munnar", 10.0889, 77.0595, false, ["Tea Gardens", "Eravikulam", "Mattupetty Dam", "Top Station", "Echo Point"]],
  ["ooty", "Ooty", 11.4102, 76.695, false, ["Ooty Lake", "Botanical Garden", "Doddabetta", "Pykara", "Coonoor"]],
  ["coorg", "Coorg", 12.3375, 75.8069, false, ["Abbey Falls", "Madikeri", "Dubare", "Talacauvery", "Mandalpatti"]],
  ["hampi", "Hampi", 15.335, 76.46, false, ["Virupaksha Temple", "Vittala Temple", "Hippie Island", "Matanga Hill", "Lotus Mahal"]],
  ["mysore", "Mysore", 12.2958, 76.6394, false, ["Mysore Palace", "Chamundi Hills", "Brindavan Gardens", "Devaraja Market", "Srirangapatna"]],
  ["agra", "Agra", 27.1767, 78.0081, false, ["Taj Mahal", "Agra Fort", "Mehtab Bagh", "Fatehpur Sikri", "Kinari Bazaar"]],
  ["delhi", "Delhi", 28.6139, 77.209, false, ["Connaught Place", "Old Delhi", "Hauz Khas", "India Gate", "Qutub Minar"]],
  ["kolkata", "Kolkata", 22.5726, 88.3639, false, ["Park Street", "Howrah Bridge", "Victoria Memorial", "Kumartuli", "New Market"]],
];

const SOURCES = ["instagram", "x", "reddit", "google", "tripadvisor", "youtube"];

// templates per topic; {p} = area name
const TEMPLATES = {
  flood: ["{p} roads waterlogged, avoid this week", "Flood alert near {p}, traffic stuck for hours", "Heavy rain flooded {p}, shops shut early"],
  closure: ["{p} closed today by authorities", "Tours to {p} cancelled, got a refund", "{p} shut for maintenance, wasted trip"],
  crowd: ["{p} packed with crowds, could not move", "Huge queues at {p}, waited 2 hours", "{p} way too crowded this weekend"],
  price: ["Prices near {p} doubled this weekend", "Hotels around {p} overcharging tourists", "{p} cabs charging triple fare"],
  safety: ["Phone stolen near {p}, be careful", "Rough sea at {p}, red flag up", "Landslide warning near {p}, road blocked"],
  positive: ["{p} was beautiful today, calm and clean", "Amazing time at {p}, totally worth it", "{p} sunny and quiet, perfect day", "Great food and views at {p}", "{p} open and buzzing, loved it"],
};

// topic mix for a destination; monsoon pushes coastal places toward flood/closure/safety
const mix = (coastal, scenario) =>
  scenario === "monsoon" && coastal
    ? { flood: 0.25, closure: 0.18, safety: 0.15, crowd: 0.07, price: 0.07, positive: 0.28 }
    : { flood: 0.02, closure: 0.04, safety: 0.04, crowd: 0.12, price: 0.08, positive: 0.7 };

const pickTopic = (weights) => {
  let r = rand();
  for (const [k, w] of Object.entries(weights)) if ((r -= w) <= 0) return k;
  return "positive";
};

const destinations = DESTS.map(([id, name, lat, lon, coastal, areas]) => ({ id, name, lat, lon, coastal, areas, newsQuery: `${name} (flood OR rain OR closed OR crowd OR tourists)` }));

// Gokarna stays the clean alternative even in monsoon
const scenarioFor = (d, scenario) => (d.id === "gokarna" ? "normal" : scenario);

const posts = [];
for (let i = 0; i < POST_COUNT; i++) {
  const d = pick(destinations);
  const scenario = rand() < 0.5 ? "monsoon" : "normal";
  const topic = pickTopic(mix(d.coastal, scenarioFor(d, scenario)));
  const place = pick(d.areas);
  posts.push({
    id: `g${i}`,
    scenario,
    source: pick(SOURCES),
    destination: d.id,
    place,
    hoursAgo: int(0, 720),
    likes: Math.floor(Math.pow(rand(), 3) * 5000),
    text: pick(TEMPLATES[topic]).replace("{p}", place),
  });
}

// hand-written demo posts stay on top so the demo story is unchanged
const curated = JSON.parse(readFileSync(new URL("../data/posts.json", import.meta.url)));

const HOTEL_WORDS = ["Sea View", "Palm", "Heritage", "Royal", "Lotus", "Sunset", "Cozy", "Grand", "Green Leaf", "Blue Lagoon"];
const HOTEL_TYPES = ["Resort", "Inn", "Homestay", "Hotel", "Villa", "Hostel"];
const FEATURES = ["pool", "beach", "breakfast", "quiet", "spa", "wifi", "parking", "nightlife", "crowds", "luxury", "view"];
const hotels = destinations.flatMap((d) =>
  Array.from({ length: 40 }, (_, i) => ({
    id: `${d.id}-gh${i}`,
    destination: d.id,
    name: `${pick(HOTEL_WORDS)} ${pick(HOTEL_TYPES)} ${d.name}`,
    area: pick(d.areas),
    pricePerNight: int(8, 160) * 100,
    rating: Number((3 + rand() * 2).toFixed(1)),
    features: [...new Set(Array.from({ length: int(1, 4) }, () => pick(FEATURES)))],
  })),
);

const ACTS = [
  ["Sightseeing at {p}", false, ["views"]], ["Food walk in {p}", false, ["food"]], ["Water sports at {p}", false, ["water sports"]],
  ["Beach time at {p}", false, ["beach"]], ["Trek near {p}", false, ["nature"]], ["Museum near {p}", true, ["museum", "art"]],
  ["Cooking class in {p}", true, ["food"]], ["Spa near {p}", true, ["relax"]], ["Shopping at {p}", true, ["shopping", "crowds"]],
  ["Cafe hopping in {p}", true, ["food"]], ["Heritage tour of {p}", false, ["history"]], ["Indoor games near {p}", true, ["fun"]],
];
const places = destinations.flatMap((d) =>
  d.areas.flatMap((area, ai) =>
    ACTS.filter((a) => d.coastal || !["water sports", "beach"].includes(a[2][0])).map(([name, indoor, tags], i) => ({
      id: `${d.id}-gp${ai}-${i}`,
      destination: d.id,
      name: name.replace("{p}", area),
      area,
      cost: int(0, 50) * 100,
      indoor,
      hours: int(1, 6),
      tags,
    })),
  ),
);

mkdirSync(OUT, { recursive: true });
const write = (name, data) => writeFileSync(new URL(name, OUT), JSON.stringify(data));
write("destinations.json", destinations);
write("posts.json", [...curated, ...posts]);
write("hotels.json", hotels);
write("places.json", places);
console.log(`destinations ${destinations.length}, posts ${posts.length + curated.length}, hotels ${hotels.length}, places ${places.length}`);
