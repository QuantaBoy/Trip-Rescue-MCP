// Live data: Google News RSS for headlines, Open-Meteo for weather. Neither needs an API key.
// The JSON files are only used when a live call fails, and the result says so.
import { readFileSync } from "node:fs";

const load = (p) => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const fallbackNews = load("news.json");
const fallbackWeather = load("weather.json");

const NEWS_TTL_MS = 10 * 60 * 1000; // headlines don't change by the second; cache per destination
const newsCache = new Map();

const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");

async function googleNews(dest) {
  const q = `${dest.name} (rain OR flood OR closed OR beach OR tourists OR crowd) when:3d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Google News HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 30).map(([, item]) => {
    const full = tag(item, "title");
    const cut = full.lastIndexOf(" - ");
    return {
      source: "news",
      place: dest.name,
      hoursAgo: Math.max(0, Math.round((Date.now() - Date.parse(tag(item, "pubDate"))) / 36e5)),
      likes: 1000, // news has no likes; treat every headline as widely seen
      text: cut > 0 ? full.slice(0, cut) : full,
      outlet: tag(item, "source") || (cut > 0 ? full.slice(cut + 3) : ""),
    };
  });
}

// live by default; `scenario` news only when live is turned off (tests) or Google News fails
export async function getNews(dest, scenario, live = true) {
  if (live) {
    const hit = newsCache.get(dest.id);
    if (hit && Date.now() - hit.at < NEWS_TTL_MS) return hit.value;
    try {
      const items = await googleNews(dest);
      const value = { source: "google-news", live: true, items };
      newsCache.set(dest.id, { at: Date.now(), value });
      return value;
    } catch (e) {
      console.error(`live news failed for ${dest.name}: ${e.message}`);
    }
  }
  const items = (fallbackNews[scenario] ?? []).filter((n) => n.destination === dest.id);
  return { source: "fallback", live: false, items: items.map((n) => ({ source: "news", place: dest.name, hoursAgo: n.hoursAgo, likes: 1000, text: n.title, outlet: n.source })) };
}

const summary = (mm) => (mm >= 20 ? "Heavy rain" : mm >= 5 ? "Showers" : mm >= 1 ? "Light drizzle" : "Dry");

// Open-Meteo only forecasts about 16 days ahead; later trips use the scenario forecast
export async function getForecast(dest, dates, scenario, live = true) {
  const inRange = Date.parse(dates.at(-1)) - Date.now() < 15 * 864e5;
  if (live && inRange) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${dest.lat}&longitude=${dest.lon}&daily=precipitation_sum,temperature_2m_max&timezone=auto&start_date=${dates[0]}&end_date=${dates.at(-1)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const body = await res.json();
      if (body.error) throw new Error(body.reason); // e.g. dates more than 16 days ahead
      const d = body.daily;
      return {
        source: "open-meteo",
        live: true,
        days: d.time.map((date, i) => ({ day: i + 1, date, rainMm: d.precipitation_sum[i], tempC: d.temperature_2m_max[i], summary: summary(d.precipitation_sum[i]) })),
      };
    } catch (e) {
      console.error(`live weather failed for ${dest.name}: ${e.message}`);
    }
  }
  const arr = fallbackWeather[scenario] ?? fallbackWeather.normal;
  return { source: "fallback", live: false, days: dates.map((date, i) => ({ ...(arr[i] ?? arr.at(-1)), day: i + 1, date })) };
}
