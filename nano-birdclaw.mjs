#!/usr/bin/env node
/**
 * nano-birdclaw-add-value — a birdclaw-inspired X/Twitter digest, distilled to one file.
 *
 * Fetches your X/Twitter home timeline and mentions via the `bird` CLI, asks an
 * OpenAI-compatible model for a "what happened" digest where every bullet carries
 * a concrete "Add value:" reply angle, and streams the markdown either to stdout
 * (CLI mode) or to a tiny local web page (serve mode).
 *
 * Zero dependencies. Node >= 20. MIT.
 * Portions derived from birdclaw (Peter Steinberger, MIT).
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const PERIODS = ["today", "24h", "yesterday", "week"];

const HELP = `nano-birdclaw — the "worth weighing in on" digest, in one file

Usage:
  nano-birdclaw                Serve the web UI (default http://127.0.0.1:8787)
  nano-birdclaw <period>       Run once, stream markdown to stdout
                               period: today | 24h | yesterday | week

Flags:
  --limit N      Home timeline tweets to fetch (default 100)
  --mentions N   Mentions to fetch (default 100)
  --following    Use the Following feed (default is For You)
  --refresh      Bypass the 5-minute cache (still writes it)
  --port N       Web UI port (default 8787)
  --model M      Model id (default gpt-5.5)
  --help         Show this help

Environment:
  OPENAI_API_KEY                     Required
  BIRDCLAW_OPENAI_BASE_URL           OpenAI-compatible base URL (default https://api.openai.com/v1)
  OPENAI_BASE_URL                    Fallback base URL
  NANO_BIRDCLAW_MODEL                Model id (then BIRDCLAW_AI_MODEL, then gpt-5.5)
  BIRDCLAW_OPENAI_REASONING_EFFORT   Reasoning effort (default medium)
  BIRDCLAW_OPENAI_SERVICE_TIER       Service tier (default priority)
  NANO_BIRDCLAW_NAME                 Name used in the prompt (default @<your handle>)
  NANO_BIRDCLAW_BIRD                 bird executable (then BIRDCLAW_BIRD_COMMAND, then "bird")
`;

function parseArgs(argv) {
  const opts = {
    period: null,
    limit: 100,
    mentions: 100,
    following: false,
    refresh: false,
    port: 8787,
    model: null,
    help: false,
  };
  const takeInt = (flag, value) => {
    const n = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} expects a positive integer`);
    return n;
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--limit") opts.limit = takeInt(arg, rest.shift());
    else if (arg === "--mentions") opts.mentions = takeInt(arg, rest.shift());
    else if (arg === "--port") opts.port = takeInt(arg, rest.shift());
    else if (arg === "--model") opts.model = rest.shift() ?? null;
    else if (arg === "--following") opts.following = true;
    else if (arg === "--refresh") opts.refresh = true;
    else if (PERIODS.includes(arg)) opts.period = arg;
    else throw new Error(`unknown argument: ${arg} (try --help)`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

function resolveWindow(period) {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let label;
  let since;
  let until = now;
  if (period === "24h") {
    label = "Last 24 hours";
    since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  } else if (period === "yesterday") {
    label = "Yesterday";
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    until = midnight;
  } else if (period === "week") {
    label = "Last 7 days";
    since = new Date(now);
    since.setDate(since.getDate() - 7);
  } else {
    label = "Today";
    since = midnight;
  }
  return { label, since: since.toISOString(), until: until.toISOString() };
}

// ---------------------------------------------------------------------------
// bird CLI
// ---------------------------------------------------------------------------

const BIRD_COMMAND =
  process.env.NANO_BIRDCLAW_BIRD || process.env.BIRDCLAW_BIRD_COMMAND || "bird";

function runBird(args, signal) {
  return new Promise((resolve, reject) => {
    execFile(BIRD_COMMAND, args, { maxBuffer: 512 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === "ENOENT" || error.code === "EACCES") {
          reject(
            new Error(
              `bird command unavailable: ${BIRD_COMMAND}\n` +
                "Install it with: npm install -g @steipete/bird (or set NANO_BIRDCLAW_BIRD).",
            ),
          );
          return;
        }
        const detail = String(stderr || error.message || "").trim().slice(0, 400);
        reject(new Error(`bird ${args[0]} failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Escape raw control characters found inside JSON string literals — bird
 * occasionally emits unescaped newlines in tweet text. */
function escapeControlCharsInStrings(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.codePointAt(0);
      if (code < 0x20) {
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function parseBirdJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return JSON.parse(escapeControlCharsInStrings(stdout));
  }
}

function birdTweetItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.tweets)) return payload.tweets;
  return [];
}

async function fetchTimeline(args, signal) {
  return birdTweetItems(parseBirdJson(await runBird(args, signal)));
}

let identityPromise = null;
/** `bird whoami --plain` prints e.g. "user: @handle (Display Name)". Runs once per process. */
function getIdentity(signal) {
  identityPromise ??= (async () => {
    try {
      const out = await runBird(["whoami", "--plain"], signal);
      const match = /^user:\s*@(\S+)\s*\((.*)\)$/m.exec(out);
      if (match) return { handle: match[1], displayName: match[2] };
    } catch {
      // Name is cosmetic; a missing bird will fail loudly on the timeline fetch instead.
    }
    identityPromise = null; // failed or aborted: retry on the next call instead of caching null
    return null;
  })();
  return identityPromise;
}

async function resolveName(signal) {
  const fromEnv = process.env.NANO_BIRDCLAW_NAME?.trim();
  if (fromEnv) return fromEnv;
  const identity = await getIdentity(signal);
  return identity ? `@${identity.handle}` : "the user";
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

function toIso(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value ?? "") : parsed.toISOString();
}

/** Slim tweet from raw bird JSON: enough to cite and to give the model parent/quote context. */
function slimFromRaw(raw) {
  const author = raw?.author?.username ?? "unknown";
  const id = String(raw?.id ?? "");
  return {
    id,
    url: `https://x.com/${author}/status/${id}`,
    author,
    name: raw?.author?.name ?? "",
    createdAt: toIso(raw?.createdAt),
    text: String(raw?.text ?? ""),
  };
}

function slimFromCompact(tweet) {
  const { id, url, author, name, createdAt, text } = tweet;
  return { id, url, author, name, createdAt, text };
}

function hydratedQuote(raw) {
  const quoted = raw?.quotedTweet;
  if (
    quoted &&
    typeof quoted.id === "string" &&
    typeof quoted.text === "string" &&
    typeof quoted.createdAt === "string" &&
    quoted.id !== raw.id
  ) {
    return slimFromRaw(quoted);
  }
  return null;
}

function compactTweet(raw, source) {
  const slim = slimFromRaw(raw);
  return {
    ...slim,
    source,
    likeCount: Number(raw?.likeCount ?? 0),
    needsReply: source === "mentions",
    replyToId: raw?.inReplyToStatusId ?? null,
    replyToTweet: null,
    quotedTweet: hydratedQuote(raw),
  };
}

async function collectContext(opts, window, signal, status) {
  status("Fetching home timeline", `bird home · ${opts.following ? "Following" : "For You"}`);
  status("Fetching mentions", "bird mentions");
  const homeArgs = ["home", "-n", String(opts.limit), "--json"];
  if (opts.following) homeArgs.push("--following");
  const [homeRaw, mentionsRaw] = await Promise.all([
    fetchTimeline(homeArgs, signal),
    fetchTimeline(["mentions", "-n", String(opts.mentions), "--json"], signal),
  ]);

  const sinceMs = Date.parse(window.since);
  const untilMs = Date.parse(window.until);
  const inWindow = (tweet) => {
    const ms = Date.parse(tweet.createdAt);
    return Number.isFinite(ms) && ms >= sinceMs && ms < untilMs;
  };
  const home = homeRaw.map((raw) => compactTweet(raw, "home")).filter(inWindow);
  const mentions = mentionsRaw.map((raw) => compactTweet(raw, "mentions")).filter(inWindow);

  // Dedup by id, first occurrence wins in [home, mentions] order, then newest first.
  const seen = new Map();
  for (const tweet of [...home, ...mentions]) {
    if (tweet.id && !seen.has(tweet.id)) seen.set(tweet.id, tweet);
  }
  const tweets = [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { tweets, counts: { home: home.length, mentions: mentions.length } };
}

const PARENT_HYDRATION_CAP = 12;
const PARENT_HYDRATION_CONCURRENCY = 4;

/** Fill replyToTweet for mentions: from the dataset when the parent is present,
 * otherwise via `bird read <id>` (cap 12, concurrency 4, failures ignored). */
async function hydrateParents(tweets, signal, status) {
  const byId = new Map(tweets.map((tweet) => [tweet.id, tweet]));
  const missing = new Map(); // parentId -> mentions waiting on it
  for (const tweet of tweets) {
    if (tweet.source !== "mentions" || !tweet.replyToId) continue;
    const parent = byId.get(tweet.replyToId);
    if (parent) {
      tweet.replyToTweet = slimFromCompact(parent);
      continue;
    }
    if (!missing.has(tweet.replyToId)) missing.set(tweet.replyToId, []);
    missing.get(tweet.replyToId).push(tweet);
  }
  const targets = [...missing.entries()].slice(0, PARENT_HYDRATION_CAP);
  if (targets.length === 0) return;
  status("Fetching reply parents", `${targets.length} lookups via bird read`);
  let index = 0;
  const worker = async () => {
    while (index < targets.length) {
      const [parentId, waiting] = targets[index++];
      try {
        const payload = parseBirdJson(
          await runBird(["read", parentId, "--json", "--timeout", "5000"], signal),
        );
        if (payload && typeof payload.id === "string" && payload.id.length > 0) {
          const slim = slimFromRaw(payload);
          for (const tweet of waiting) tweet.replyToTweet = slim;
        }
      } catch {
        // Parent context is best-effort; a dead lookup should never sink the digest.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARENT_HYDRATION_CONCURRENCY, targets.length) }, worker),
  );
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are a precise local Twitter archive analyst. Stream one readable Markdown report. Do not invent events not present in the dataset.";

const MAX_PROMPT_DATA_CHARS = 1_200_000;

function valueAngleLines(name) {
  return [
    `- After every bullet in every section — "What people are talking about", "Important links shared", "Worth opening", and "Worth weighing in on" — add exactly one nested sub-bullet on the next line, indented two spaces, in the form "  - **Add value:** ...".`,
    `- Each "Add value" sub-bullet must name one concrete way ${name} could add value to that specific conversation, tied to what the author actually said, asked, or shared — for example sharing relevant first-hand experience, asking a sharp clarifying question, contributing a useful resource or data point, offering a respectful counterpoint, or quote-posting with added insight. End the sub-bullet with the tweet id(s) of the exact tweet(s) ${name} would engage with, using the same citation format.`,
    `- Never fold the value suggestion into the parent bullet, and never write generic filler like "reply with your thoughts" or "share your perspective". If you cannot name a conversation-specific angle for a bullet, even as a quote-post or resource share, drop that parent bullet entirely, and drop the section if no bullets remain — this report only surfaces conversations ${name} can genuinely contribute to.`,
    "",
  ].join("\n");
}

/** Keep newest-first tweets from the front until the serialized dataset fits. */
function fitPromptTweets(tweets) {
  const overhead = '{"tweets":[]}'.length;
  let used = overhead;
  let count = 0;
  for (const tweet of tweets) {
    const length = JSON.stringify(tweet).length + (count > 0 ? 1 : 0);
    if (used + length > MAX_PROMPT_DATA_CHARS) break;
    used += length;
    count += 1;
  }
  return tweets.slice(0, count);
}

function buildPrompt({ window, counts, name, tweets }) {
  const promptTweets = fitPromptTweets(tweets);
  return `Window: ${window.label}
Since: ${window.since}
Until: ${window.until}
Sources: ${JSON.stringify(counts)}
Prompt tweets: ${String(promptTweets.length)} of ${String(tweets.length)} selected context tweets

Write a high-signal "what happened" report from this local Twitter/X dataset.

Requirements:
- Stream one readable Markdown report first. The UI will show this text directly; do not rely on separate cards or structured summaries.
- Target 700-1100 words when there is enough data.
- Start with a 2-3 sentence lead that immediately says what people are talking about.
- Use sections named "What people are talking about", "Important links shared", and "Worth opening". Add "Worth weighing in on" only if there are clearly high-signal replies.
- When a tweet has replyToTweet, use that parent context to understand what the author was replying to and whether ${name} already joined the conversation.
- Use bullets under each section. Each bullet should be specific and explain why it matters.
${valueAngleLines(name)}- For tweets: cite every claim with inline tweet ids at the end of the relevant sentence or bullet, e.g. (tweet_123, tweet_456). These citations become hoverable source links.
- For links: emit normal Markdown links with no space between the label and URL, e.g. [title](https://example.com), then cite the sharing tweet ids in the same bullet.
- Prefer synthesis over chronology. Group repeated chatter into one bullet.
- Mention handles when useful, but do not make the report a list of handles.
- Do not include a generic "Action items" section.
- If there is no data, say that plainly in one short paragraph.

Dataset:
${JSON.stringify({ tweets: promptTweets })}`;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API (streaming)
// ---------------------------------------------------------------------------

function resolveModel(flagModel) {
  return (
    flagModel ||
    process.env.NANO_BIRDCLAW_MODEL ||
    process.env.BIRDCLAW_AI_MODEL ||
    "gpt-5.5"
  );
}

async function streamModel({ model, prompt, signal, onDelta }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const base = (
    process.env.BIRDCLAW_OPENAI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: process.env.BIRDCLAW_OPENAI_REASONING_EFFORT || "medium" },
      service_tier: process.env.BIRDCLAW_OPENAI_SERVICE_TIER || "priority",
      store: false,
      stream: true,
      max_output_tokens: 7000,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${body.slice(0, 400)}`);
  }
  if (!response.body) throw new Error("OpenAI response did not include a stream");

  let failure = null;
  const handleEvent = (event) => {
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta === "string") onDelta(event.delta);
    } else if (event.type === "response.error" || event.type === "error") {
      failure = event.error?.message || "OpenAI stream failed";
    } else if (event.type === "response.failed" || event.type === "response.incomplete") {
      failure =
        event.response?.error?.message ||
        (event.response?.incomplete_details?.reason
          ? `OpenAI response incomplete: ${event.response.incomplete_details.reason}`
          : "OpenAI stream failed");
    }
  };
  const handleBlock = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      handleEvent(JSON.parse(data));
    } catch {
      // A malformed SSE frame should not sink the partial output.
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        handleBlock(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleBlock(buffer);
  } finally {
    reader.releaseLock();
  }
  // Drain-then-throw, like birdclaw: partial output stays usable, error still surfaces.
  if (failure) throw new Error(failure);
}

// ---------------------------------------------------------------------------
// Cache — one JSON file, 5-minute freshness
// ---------------------------------------------------------------------------

const CACHE_PATH = join(homedir(), ".nano-birdclaw", "cache.json");
const CACHE_FRESH_MS = 5 * 60 * 1000;

function readCacheFile() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Corrupt or missing cache is the same as no cache.
  }
  return {};
}

function readCache(key) {
  const entry = readCacheFile()[key];
  if (
    entry &&
    typeof entry.markdown === "string" &&
    Date.now() - Date.parse(entry.updatedAt) <= CACHE_FRESH_MS
  ) {
    return entry;
  }
  return null;
}

function writeCache(key, entry) {
  try {
    const all = readCacheFile();
    all[key] = entry;
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(all));
  } catch {
    // Best-effort cache; never fail the digest over it.
  }
}

// ---------------------------------------------------------------------------
// Digest orchestrator — emits status/start/delta/done events
// ---------------------------------------------------------------------------

async function runDigest({ opts, period, refresh, signal, emit }) {
  const window = resolveWindow(period);
  const name = await resolveName(signal);
  const model = resolveModel(opts.model);
  const cacheKey = [period, opts.limit, opts.mentions, opts.following, model, name].join(":");

  if (!refresh) {
    const hit = readCache(cacheKey);
    if (hit) {
      emit({ type: "start", context: hit.context, cached: true });
      emit({ type: "delta", delta: hit.markdown });
      emit({
        type: "done",
        result: { markdown: hit.markdown, cached: true, updatedAt: hit.updatedAt, window: { label: window.label } },
      });
      return;
    }
  }

  const status = (label, detail) =>
    emit(detail ? { type: "status", label, detail } : { type: "status", label });

  const { tweets, counts } = await collectContext(opts, window, signal, status);
  const context = {
    window,
    counts,
    name,
    tweets: tweets.map(({ id, url, author, name: authorName, text }) => ({
      id,
      url,
      author,
      name: authorName,
      text,
    })),
  };
  emit({ type: "start", context, cached: false });

  await hydrateParents(tweets, signal, status);
  const prompt = buildPrompt({ window, counts, name, tweets });
  status("Streaming AI summary");

  let markdown = "";
  await streamModel({
    model,
    prompt,
    signal,
    onDelta: (delta) => {
      markdown += delta;
      emit({ type: "delta", delta });
    },
  });
  markdown = markdown.trim();

  const updatedAt = new Date().toISOString();
  writeCache(cacheKey, { markdown, context, updatedAt });
  emit({
    type: "done",
    result: { markdown, cached: false, updatedAt, window: { label: window.label } },
  });
}

// ---------------------------------------------------------------------------
// CLI mode — markdown to stdout, status to stderr
// ---------------------------------------------------------------------------

async function runCli(opts) {
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    process.exit(130);
  });
  let wroteMarkdown = false;
  const emit = (event) => {
    if (event.type === "status") {
      process.stderr.write(`· ${event.label}${event.detail ? ` — ${event.detail}` : ""}\n`);
    } else if (event.type === "start") {
      const { counts, window } = event.context;
      process.stderr.write(
        `· ${window.label}: ${counts.home} home, ${counts.mentions} mentions${event.cached ? " (cached)" : ""}\n`,
      );
    } else if (event.type === "delta") {
      wroteMarkdown = true;
      process.stdout.write(event.delta);
    } else if (event.type === "done") {
      if (wroteMarkdown) process.stdout.write("\n");
      process.stderr.write(`· done — ${event.result.window.label}${event.result.cached ? " (cached)" : ""}\n`);
    }
  };
  try {
    await runDigest({
      opts,
      period: opts.period,
      refresh: opts.refresh,
      signal: controller.signal,
      emit,
    });
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Server mode — NDJSON stream + inline page
// ---------------------------------------------------------------------------

function normalizePeriod(value) {
  return PERIODS.includes(value) ? value : "today";
}

async function handleDigestRequest(res, url, opts) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const emit = (event) => {
    if (!res.writableEnded && !controller.signal.aborted) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };
  try {
    await runDigest({
      opts,
      period: normalizePeriod(url.searchParams.get("period")),
      refresh: url.searchParams.get("refresh") === "true",
      signal: controller.signal,
      emit,
    });
  } catch (error) {
    emit({ type: "error", error: error?.message || String(error) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

function serve(opts) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    process.stderr.write(`${new Date().toISOString()} ${req.method} ${req.url}\n`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/digest") {
      void handleDigestRequest(res, url, opts);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });
  server.listen(opts.port, "127.0.0.1", () => {
    process.stderr.write(`Worth weighing in on → http://127.0.0.1:${opts.port}\n`);
  });
}

// ---------------------------------------------------------------------------
// The web page. One string. Client JS deliberately avoids backticks because
// it lives inside this template literal (String.raw keeps the regexes intact).
// ---------------------------------------------------------------------------

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Worth weighing in on</title>
<style>
:root {
  --bg: #ffffff;
  --ink: #0f1419;
  --soft: #536471;
  --line: #eff3f4;
  --accent: #1d9bf0;
  --accent-soft: rgb(29 155 240 / 10%);
  --alert: #f4212e;
  --alert-soft: rgb(244 33 46 / 10%);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0f14;
    --ink: #d8dee5;
    --soft: #8b98a5;
    --line: #26323d;
    --accent-soft: rgb(29 155 240 / 18%);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.55;
}
main { max-width: 700px; margin: 0 auto; border-left: 1px solid var(--line); border-right: 1px solid var(--line); min-height: 100vh; }
.top {
  position: sticky;
  top: 0;
  z-index: 5;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
  padding: 10px 16px 12px;
}
.bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.top h1 { margin: 0; font-size: 20px; font-weight: 700; }
.subtitle { font-size: 13px; color: var(--soft); margin-top: 2px; }
.actions { display: flex; gap: 8px; flex-shrink: 0; }
button {
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 9999px;
  padding: 6px 14px;
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--accent-soft); }
button:disabled { opacity: 0.5; cursor: default; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 9999px; padding: 3px; margin-top: 10px; gap: 2px; }
.seg button { border: none; padding: 4px 14px; font-weight: 600; color: var(--soft); }
.seg button[aria-pressed="true"] {
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.errorbox {
  margin: 12px 16px 0;
  padding: 10px 14px;
  border: 1px solid var(--alert);
  background: var(--alert-soft);
  border-radius: 12px;
  font-size: 14px;
}
.errorbox button { border: none; padding: 0 2px; color: var(--accent); text-decoration: underline; font-weight: 600; }
.statusline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--soft);
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
}
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }
.check { color: var(--accent); font-weight: 700; }
article { padding: 12px 16px 64px; }
article h1 { font-size: 20px; font-weight: 700; margin: 20px 0 8px; }
article h2 { font-size: 18px; font-weight: 700; margin: 20px 0 8px; }
article h3 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--soft); margin: 18px 0 6px; }
article p { margin: 10px 0; }
article ul { margin: 8px 0; padding-left: 24px; }
article li { margin: 4px 0; }
article li::marker { color: var(--soft); }
article li li { list-style-type: circle; }
article a { color: var(--accent); text-decoration: none; }
article a:hover { text-decoration: underline; background: var(--accent-soft); border-radius: 4px; }
.placeholder { color: var(--soft); }
.pdf-meta { display: none; }
@media print {
  .screen-only { display: none !important; }
  body { background: #fff; color: #0f1419; }
  main { border: none; max-width: none; }
  .top { position: static; background: #fff; border-bottom: 1px solid #cfd9de; }
  .subtitle { color: #536471; }
  article { font-size: 12pt; line-height: 1.55; }
  article p, article li, article h1, article h2, article h3 { break-inside: avoid; }
  article h3 { color: #536471; }
  article a { color: #0f1419; text-decoration: underline; }
  .pdf-meta { display: block; font-size: 10pt; color: #536471; margin-top: 4px; }
}
</style>
</head>
<body>
<main>
  <header class="top">
    <div class="bar">
      <div>
        <h1>Worth weighing in on</h1>
        <div class="subtitle" id="subtitle">Your timeline, summarized as it streams.</div>
        <div class="pdf-meta" id="pdfMeta"></div>
      </div>
      <div class="actions screen-only">
        <button id="exportBtn" hidden type="button">Export PDF</button>
        <button id="refreshBtn" type="button">Refresh</button>
      </div>
    </div>
    <div class="seg screen-only" role="group" aria-label="Period">
      <button type="button" data-period="today">Today</button>
      <button type="button" data-period="24h">24h</button>
      <button type="button" data-period="yesterday">Yesterday</button>
      <button type="button" data-period="week">Week</button>
    </div>
  </header>
  <div class="errorbox screen-only" id="errorBox" role="alert" hidden>
    <span id="errorText"></span>
    <button id="retryBtn" type="button">Retry</button>
  </div>
  <div class="statusline screen-only" id="statusLine">
    <span id="statusIcon" class="check">&#10003;</span>
    <span id="statusMsg">Ready</span>
  </div>
  <article id="report"></article>
</main>
<script>
(function () {
  "use strict";
  var PERIODS = ["today", "24h", "yesterday", "week"];
  var params = new URLSearchParams(location.search);
  var period = PERIODS.indexOf(params.get("period")) >= 0 ? params.get("period") : "today";
  var controller = null;
  var loading = false;
  var markdown = "";
  var context = null;
  var result = null;
  var errorMessage = null;
  var currentStatus = "Ready";
  var lookup = {};

  var subtitle = document.getElementById("subtitle");
  var exportBtn = document.getElementById("exportBtn");
  var refreshBtn = document.getElementById("refreshBtn");
  var errorBox = document.getElementById("errorBox");
  var errorText = document.getElementById("errorText");
  var retryBtn = document.getElementById("retryBtn");
  var statusIcon = document.getElementById("statusIcon");
  var statusMsg = document.getElementById("statusMsg");
  var report = document.getElementById("report");
  var pdfMeta = document.getElementById("pdfMeta");
  var segButtons = Array.prototype.slice.call(document.querySelectorAll(".seg button"));

  function text(value) { return document.createTextNode(value); }

  function anchor(href, label, title) {
    var a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noreferrer";
    if (title) a.title = title;
    a.appendChild(text(label));
    return a;
  }

  // -- citations ------------------------------------------------------------

  function extractRefs(token) {
    var refs = [];
    var re = /\b(?:tweet_)?[A-Za-z0-9_:-]{3,}\b/g;
    var m;
    while ((m = re.exec(token))) {
      var v = m[0];
      if (v.indexOf("tweet_") === 0 || /^\d{12,25}$/.test(v)) refs.push(v);
    }
    return refs;
  }

  function resolveRef(ref) {
    var bare = ref.replace(/^tweet_/, "");
    var tweet = lookup[ref] || lookup[bare];
    if (tweet) {
      return {
        href: tweet.url || "https://x.com/" + tweet.author + "/status/" + tweet.id,
        title: "@" + tweet.author + ": " + String(tweet.text || "").slice(0, 140)
      };
    }
    if (/^\d{12,25}$/.test(bare)) {
      return { href: "https://x.com/i/status/" + bare, title: null };
    }
    return null;
  }

  function appendCitations(target, token) {
    var wrapped = token.charAt(0) === "(";
    var refs = extractRefs(token);
    var links = [];
    for (var i = 0; i < refs.length; i++) {
      var resolved = resolveRef(refs[i]);
      if (resolved) links.push(resolved);
    }
    if (links.length === 0) { target.appendChild(text(token)); return; }
    if (wrapped) target.appendChild(text("("));
    for (var j = 0; j < links.length; j++) {
      if (j > 0) target.appendChild(text(", "));
      var label = links.length === 1 ? "source" : "source " + (j + 1);
      target.appendChild(anchor(links[j].href, label, links[j].title));
    }
    if (wrapped) target.appendChild(text(")"));
  }

  // -- inline markdown --------------------------------------------------------

  var INLINE = /(\[[^\]\n]+\]\s*\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|@[A-Za-z0-9_]{1,20}|\((?:\s*(?:tweet_[A-Za-z0-9_:-]+|\d{12,25})\s*,?)+\)|\btweet_[A-Za-z0-9_:-]+\b|\b\d{12,25}\b)/g;

  function appendToken(target, token) {
    var link = /^\[([^\]\n]+)\]\s*\((https?:\/\/[^\s)]+)\)$/.exec(token);
    if (link) { target.appendChild(anchor(link[2], link[1], null)); return; }
    if (token.slice(0, 2) === "**") {
      var strong = document.createElement("strong");
      renderInline(strong, token.slice(2, -2));
      target.appendChild(strong);
      return;
    }
    if (token.charAt(0) === "@") {
      target.appendChild(anchor("https://x.com/" + token.slice(1), token, null));
      return;
    }
    appendCitations(target, token);
  }

  function renderInline(target, source) {
    // Fresh instance per call: renderInline recurses (bold), and a shared
    // global regex would have its lastIndex clobbered mid-iteration.
    var pattern = new RegExp(INLINE.source, "g");
    var last = 0;
    var match;
    while ((match = pattern.exec(source))) {
      if (match.index > last) target.appendChild(text(source.slice(last, match.index)));
      appendToken(target, match[0]);
      last = match.index + match[0].length;
    }
    if (last < source.length) target.appendChild(text(source.slice(last)));
  }

  // -- block markdown ---------------------------------------------------------

  function renderReport() {
    report.textContent = "";
    if (!markdown.trim()) {
      var p = document.createElement("p");
      p.className = "placeholder";
      var placeholder = "Waiting for the first tokens...";
      if (loading) placeholder = currentStatus;
      else if (errorMessage) placeholder = "No digest was generated. Retry to start a new run.";
      p.appendChild(text(placeholder));
      report.appendChild(p);
      return;
    }
    var joined = markdown.replace(/\]\s*\r?\n\s*\((https?:\/\/[^\s)]+)\)/g, "]($1)");
    var lines = joined.split(/\r?\n/);
    var list = null;
    var lastItem = null;
    var childList = null;
    function flushList() { list = null; lastItem = null; childList = null; }
    function ensureList() {
      if (!list) { list = document.createElement("ul"); report.appendChild(list); }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) { flushList(); continue; }
      var heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        flushList();
        var h = document.createElement("h" + heading[1].length);
        renderInline(h, heading[2]);
        report.appendChild(h);
        continue;
      }
      var sub = /^\s+[-*]\s+(.*)$/.exec(line);
      if (sub && lastItem) {
        if (!childList) { childList = document.createElement("ul"); lastItem.appendChild(childList); }
        var childItem = document.createElement("li");
        renderInline(childItem, sub[1]);
        childList.appendChild(childItem);
        continue;
      }
      var top = /^\s*[-*]\s+(.*)$/.exec(line);
      if (top) {
        ensureList();
        lastItem = document.createElement("li");
        childList = null;
        renderInline(lastItem, top[1]);
        list.appendChild(lastItem);
        continue;
      }
      flushList();
      var para = document.createElement("p");
      renderInline(para, line);
      report.appendChild(para);
    }
  }

  // -- UI state -----------------------------------------------------------------

  function setStatus(value) {
    currentStatus = value;
    syncUi();
  }

  function syncUi() {
    subtitle.textContent = context
      ? context.counts.home + " home · " + context.counts.mentions + " mentions"
      : "Your timeline, summarized as it streams.";
    refreshBtn.disabled = loading;
    exportBtn.hidden = !(result && !loading && markdown.trim());
    errorBox.hidden = !errorMessage;
    if (errorMessage) errorText.textContent = errorMessage;
    for (var i = 0; i < segButtons.length; i++) {
      segButtons[i].setAttribute(
        "aria-pressed",
        segButtons[i].getAttribute("data-period") === period ? "true" : "false"
      );
    }
    if (loading) {
      statusIcon.className = "spinner";
      statusIcon.textContent = "";
      statusMsg.textContent = currentStatus;
    } else if (errorMessage) {
      statusIcon.className = "";
      statusIcon.textContent = "!";
      statusMsg.textContent = "Digest failed";
    } else if (result) {
      statusIcon.className = "check";
      statusIcon.textContent = "✓";
      statusMsg.textContent = (result.cached ? "Cached · " : "Ready · ") + result.window.label;
    } else {
      statusIcon.className = "check";
      statusIcon.textContent = "✓";
      statusMsg.textContent = "Ready";
    }
    if (result && context) {
      pdfMeta.textContent =
        result.window.label +
        " · Sources: " + context.counts.home + " home, " + context.counts.mentions + " mentions" +
        " · Generated " + new Date(result.updatedAt).toLocaleString();
    } else {
      pdfMeta.textContent = "";
    }
  }

  function buildLookup() {
    lookup = {};
    if (!context || !context.tweets) return;
    for (var i = 0; i < context.tweets.length; i++) {
      var tweet = context.tweets[i];
      lookup[tweet.id] = tweet;
      lookup["tweet_" + tweet.id] = tweet;
    }
  }

  function formatError(error) {
    if (error instanceof SyntaxError) {
      return "Digest stream returned invalid data while " + currentStatus.toLowerCase() + ". Retry to continue.";
    }
    if (error instanceof TypeError && /network error|failed to fetch|load failed/i.test(error.message)) {
      return "Digest connection was interrupted while " + currentStatus.toLowerCase() + ". Retry to continue.";
    }
    return error && error.message ? error.message : String(error);
  }

  // -- stream loop ----------------------------------------------------------------

  async function runStream(refresh) {
    if (controller) controller.abort();
    var c = new AbortController();
    controller = c;
    function isActive() { return controller === c && !c.signal.aborted; }
    loading = true;
    errorMessage = null;
    markdown = "";
    result = null;
    context = null;
    lookup = {};
    currentStatus = "Starting digest";
    syncUi();
    renderReport();
    var terminal = false;
    function handleLine(raw) {
      var line = raw.trim();
      if (!line) return;
      var ev = JSON.parse(line);
      if (ev.type === "status") {
        setStatus(ev.detail ? ev.label + " · " + ev.detail : ev.label);
      } else if (ev.type === "start") {
        context = ev.context;
        buildLookup();
        syncUi();
      } else if (ev.type === "delta") {
        currentStatus = "Streaming AI summary";
        markdown += ev.delta;
        renderReport();
        syncUi();
      } else if (ev.type === "done") {
        result = ev.result;
        markdown = ev.result.markdown;
        renderReport();
        setStatus(ev.result.cached ? "Loaded cached report" : "Ready");
        terminal = true;
      } else if (ev.type === "error") {
        terminal = true;
        throw new Error(ev.error);
      }
    }
    try {
      var url = "/api/digest?period=" + encodeURIComponent(period) + (refresh ? "&refresh=true" : "");
      var res = await fetch(url, { cache: "no-store", signal: c.signal });
      if (!res.ok) throw new Error("Digest request failed (" + res.status + " " + res.statusText + ")");
      if (!res.body) throw new Error("Digest request failed: empty response body");
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        var nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer);
      if (!terminal) {
        throw new Error("Digest connection closed while " + currentStatus.toLowerCase() + ". Retry to continue.");
      }
    } catch (error) {
      if (isActive()) errorMessage = formatError(error);
    } finally {
      if (isActive()) {
        loading = false;
        syncUi();
        renderReport();
      }
    }
  }

  // -- controls --------------------------------------------------------------------

  function setPeriod(next) {
    if (period === next) return;
    period = next;
    var url = new URL(location.href);
    url.searchParams.set("period", period);
    history.replaceState(null, "", url);
    runStream(false);
  }

  function exportPdf() {
    if (!result) return;
    var previous = document.title;
    var restored = false;
    function cleanup() {
      if (restored) return;
      restored = true;
      document.title = previous;
      window.removeEventListener("afterprint", cleanup);
    }
    document.title = "Worth weighing in on — " + result.window.label;
    window.addEventListener("afterprint", cleanup, { once: true });
    window.setTimeout(cleanup, 3000);
    window.print();
  }

  for (var i = 0; i < segButtons.length; i++) {
    (function (button) {
      button.addEventListener("click", function () {
        setPeriod(button.getAttribute("data-period"));
      });
    })(segButtons[i]);
  }
  refreshBtn.addEventListener("click", function () { runStream(true); });
  retryBtn.addEventListener("click", function () { runStream(true); });
  exportBtn.addEventListener("click", exportPdf);

  runStream(false);
})();
</script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
if (opts.help) {
  process.stdout.write(HELP);
} else if (opts.period) {
  await runCli(opts);
} else {
  serve(opts);
}
