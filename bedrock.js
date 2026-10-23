// Amazon Bedrock (Converse API): deep-reads the top posts and words replies for voice.
// Everything here is optional: on any error or timeout, callers keep the plain-code result.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

try {
  process.loadEnvFile(new URL("./.env", import.meta.url)); // AWS_BEARER_TOKEN_BEDROCK, AWS_REGION, BEDROCK_MODEL
} catch {} // no .env: Bedrock stays off

const MODEL = process.env.BEDROCK_MODEL ?? "amazon.nova-lite-v1:0";
const TIMEOUT_MS = 4000;
let client;

export const bedrockEnabled = () => Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_ACCESS_KEY_ID) && process.env.USE_BEDROCK !== "0";

async function converse(system, text, maxTokens = 400) {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "ap-southeast-2" });
  const res = await client.send(
    new ConverseCommand({
      modelId: MODEL,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text }] }],
      inferenceConfig: { maxTokens, temperature: 0.2 },
    }),
    { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  return res.output.message.content.map((c) => c.text ?? "").join("").trim();
}

const readCache = new Map(); // a post's meaning doesn't change, so each post is read once
const key = (p) => p.id ?? `${p.source}:${p.text}`;

// Raw Converse call for the chat agent (messages and tool config passed straight through)
// the conversation needs more reasoning than wording or post reading, so it gets the larger model
const CHAT_MODEL = process.env.CHAT_MODEL ?? "amazon.nova-pro-v1:0";

export async function converseRaw({ system, messages, tools, maxTokens = 600, timeoutMs = 20000 }) {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "ap-southeast-2" });
  return client.send(
    new ConverseCommand({
      modelId: CHAT_MODEL,
      system: [{ text: system }],
      messages,
      toolConfig: tools?.length ? { tools } : undefined,
      inferenceConfig: { maxTokens, temperature: 0.3 },
    }),
    { abortSignal: AbortSignal.timeout(timeoutMs) },
  );
}

// Reads posts the keyword pass ranked highest and returns { id: { sentiment, topic } }, or null on failure.
export async function deepReadPosts(all) {
  if (!bedrockEnabled() || !all.length) return null;
  const cached = Object.fromEntries(all.filter((p) => readCache.has(key(p))).map((p) => [key(p), readCache.get(key(p))]));
  const posts = all.filter((p) => !readCache.has(key(p)));
  if (!posts.length) return cached;
  try {
    const list = posts.map((p, i) => `${i}. [${p.place}] ${p.text}`).join("\n");
    const out = await converse(
      "You rate travel posts for a trip-risk checker. For each numbered post return its sentiment for a tourist (-1 very bad to 1 very good) and one topic from: flood, closure, crowd, price, safety, positive, neutral. Reply with only a JSON array like [{\"i\":0,\"sentiment\":-0.8,\"topic\":\"flood\"}].",
      list,
      60 * posts.length,
    );
    const rows = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1));
    const result = { ...cached };
    for (const r of rows) {
      const p = posts[r.i];
      if (!p || !Number.isFinite(r.sentiment)) continue;
      result[key(p)] = { sentiment: Math.max(-1, Math.min(1, r.sentiment)), topic: String(r.topic ?? "neutral") };
      readCache.set(key(p), result[key(p)]);
    }
    return Object.keys(result).length ? result : null;
  } catch (e) {
    console.error(`bedrock deep read failed: ${e.message}`);
    return Object.keys(cached).length ? cached : null;
  }
}

// Rewrites a reply for Alexa: short, warm, spoken. Falls back to the plain text.
export async function speak(plain, facts = "") {
  if (!bedrockEnabled()) return { text: plain, by: "plain" };
  try {
    const text = await converse(
      "You are TripRescue, a travel assistant speaking through Alexa. Rewrite the reply so it sounds natural when spoken: at most 4 short sentences, start with the reply's 'My verdict is ...' phrase unchanged and do not use the words go, wait or skip anywhere else, and keep every number, name, news headline and the final question to the user. Never decide for the user, add nothing that is not in the facts. No markdown, no emoji.",
      `Reply: ${plain}${facts ? `\nFacts: ${facts}` : ""}`,
      200,
    );
    return text ? { text, by: "bedrock" } : { text: plain, by: "plain" };
  } catch (e) {
    console.error(`bedrock speak failed: ${e.message}`);
    return { text: plain, by: "plain" };
  }
}
