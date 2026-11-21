#!/usr/bin/env node
/**
 * Free, zero-LLM keyword demand check for the autowriter queue.
 * Uses Bing Webmaster keyword research (GetKeywordStats, GetRelatedKeywords)
 * and Google Autocomplete. Rewrites zero-demand todos to a real on-topic
 * variant when one exists, then reorders todos by demand strength.
 *
 * Key: env BING_WEBMASTER_API_KEY, or ~/.secrets/bing_webmaster_api_key locally.
 * Never prints the key.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const QUEUE = join(import.meta.dirname, "autowriter/queue.json");
const SLEEP_MS = 500;
const COUNTRY = "us";
const LANGUAGE = "en-US";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

const STOP = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "but", "in", "on", "at",
  "from", "you", "your", "they", "them", "their", "so", "how", "do", "does",
  "did", "is", "are", "be", "it", "its", "i", "we", "my", "our", "me", "with",
  "a", "off",
]);

const NOISE = new Set([
  "youtube", "reddit", "tiktok", "uk", "lyrics", "amazon", "walmart",
  "target", "homedepot", "ebay",
]);

const MINOR = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "at", "from",
  "how", "do", "does", "did", "best", "way", "should", "you", "i", "my",
  "easily", "together", "fast", "quickly", "new", "machine", "tool",
  "attachment", "sprayer", "nozzle", "reddit", "youtube", "uk", "abroad",
  "easily", "really",
]);

function loadBingKey() {
  const fromEnv = process.env.BING_WEBMASTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const p = join(homedir(), ".secrets/bing_webmaster_api_key");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function nowCheckedAt() {
  // America/Fortaleza and America/Sao_Paulo are UTC-3 in November
  const d = new Date();
  const local = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return local.toISOString().replace("Z", "-03:00");
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/won't/g, "will not")
    .replace(/can't/g, "cannot")
    .replace(/n't/g, " not")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return normalize(s).split(" ").filter(Boolean);
}

function contentTokens(s) {
  return tokens(s).filter((t) => !STOP.has(t) && t.length > 1);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}

function stripNoiseTokens(list) {
  return list.filter((t) => !NOISE.has(t));
}

function isClose(query, suggestion) {
  const qn = normalize(query);
  const sn = normalize(suggestion);
  if (!qn || !sn) return false;
  if (qn === sn) return true;

  const qt = stripNoiseTokens(tokens(query));
  const st = stripNoiseTokens(tokens(suggestion));
  const qn2 = qt.join(" ");
  const sn2 = st.join(" ");
  if (qn2 === sn2) return true;

  if (sn2.startsWith(`${qn2} `) || qn2.startsWith(`${sn2} `)) {
    const longer = sn2.length > qn2.length ? st : qt;
    const shorter = sn2.length > qn2.length ? qt : st;
    const extra = longer.filter((t) => !shorter.includes(t));
    if (extra.length <= 3 && extra.every((t) => MINOR.has(t) || NOISE.has(t))) return true;
    if (sn2.startsWith(`${qn2} `) && extra.length <= 2) return true;
  }

  const qc = contentTokens(query);
  const sc = contentTokens(suggestion);
  if (qc.length >= 3 && sc.length >= 3) {
    const inter = qc.filter((t) => sc.includes(t)).length;
    if (inter >= Math.min(qc.length, sc.length) - 1 && Math.abs(qc.length - sc.length) <= 2) return true;
    if (jaccard(qc, sc) >= 0.8 && Math.abs(qc.length - sc.length) <= 2) return true;
  }
  return false;
}

function isPartial(query, suggestion) {
  if (isClose(query, suggestion)) return true;
  const qc = contentTokens(query);
  const sc = contentTokens(suggestion);
  if (qc.length < 2 || sc.length < 2) return false;
  const inter = qc.filter((t) => sc.includes(t)).length;
  const need = Math.max(2, Math.ceil(Math.min(qc.length, sc.length) * 0.5));
  return inter >= need;
}

function topicFit(keyword, topic, candidate) {
  const need = [...new Set(contentTokens(`${keyword} ${topic}`))];
  const c = contentTokens(candidate);
  if (!need.length || !c.length) return 0;
  return need.filter((t) => c.includes(t)).length / need.length;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

async function bingKeywordStats(key, q) {
  const url = new URL("https://ssl.bing.com/webmaster/api.svc/json/GetKeywordStats");
  url.searchParams.set("q", q);
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("language", LANGUAGE);
  url.searchParams.set("apikey", key);
  const { ok, status, data } = await fetchJson(url);
  if (!ok) {
    console.warn(`Bing GetKeywordStats HTTP ${status} for "${q}"`);
    return { impressions: 0, error: status };
  }
  const rows = Array.isArray(data?.d) ? data.d : [];
  const impressions = rows.reduce((sum, row) => sum + (Number(row.Impressions) || 0), 0);
  return { impressions, weeks: rows.length };
}

async function bingRelatedKeywords(key, q) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 180);
  const url = new URL("https://ssl.bing.com/webmaster/api.svc/json/GetRelatedKeywords");
  url.searchParams.set("q", q);
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("language", LANGUAGE);
  url.searchParams.set("startDate", isoDate(start));
  url.searchParams.set("endDate", isoDate(end));
  url.searchParams.set("apikey", key);
  const { ok, status, data } = await fetchJson(url);
  if (!ok) {
    console.warn(`Bing GetRelatedKeywords HTTP ${status} for "${q}"`);
    return [];
  }
  return (Array.isArray(data?.d) ? data.d : [])
    .map((row) => ({
      query: String(row.Query || "").trim(),
      impressions: Number(row.Impressions) || 0,
      broad: Number(row.BroadImpressions) || 0,
    }))
    .filter((row) => row.query);
}

async function googleSuggest(q) {
  const url = new URL("https://suggestqueries.google.com/complete/search");
  url.searchParams.set("client", "firefox");
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "us");
  url.searchParams.set("q", q);
  const { ok, status, data } = await fetchJson(url);
  if (!ok) {
    console.warn(`Google Autocomplete HTTP ${status} for "${q}"`);
    return [];
  }
  if (Array.isArray(data) && Array.isArray(data[1])) return data[1].map((s) => String(s));
  return [];
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const s = String(raw || "").trim();
    const key = normalize(s);
    if (!s || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function extraSeeds(item, suggestions) {
  const seeds = [];
  const topic = String(item.topic || "").trim();
  if (topic && normalize(topic) !== normalize(item.keyword)) seeds.push(topic);
  if (!suggestions.some((s) => isClose(item.keyword, s))) {
    const t = tokens(item.keyword);
    for (let drop = 1; drop <= 3 && t.length - drop >= 4; drop += 1) {
      seeds.push(t.slice(0, t.length - drop).join(" "));
    }
  }
  return uniqueStrings(seeds);
}

function keywordToTopic(keyword, previousTopic) {
  const trimmed = String(keyword || "").trim();
  if (!trimmed) return previousTopic;
  const titled = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  if (String(previousTopic || "").trim().endsWith("?")) {
    return titled.endsWith("?") ? titled : `${titled}?`;
  }
  return titled;
}

function rankVariant(candidate, item) {
  const query = candidate.query;
  const clen = contentTokens(query).length;
  const olen = contentTokens(item.keyword).length;
  let score = 0;
  if (clen < 3) score -= 20;
  if (tokens(query).some((t) => NOISE.has(t))) score -= 8;
  if (candidate.fromAutocomplete) score += 10;
  if (candidate.selfSuggested) score += 8;
  if (isClose(item.topic, query)) score += 6;
  if (isClose(item.keyword, query)) score += 4;
  score += topicFit(item.keyword, item.topic, query) * 12;
  if (clen >= Math.max(4, olen - 1)) score += 3;
  if (candidate.impressions) score += Math.min(5, Math.log10(candidate.impressions + 1));
  // Prefer keeping distinctive intent words from the original topic or keyword
  const distinctive = contentTokens(`${item.keyword} ${item.topic}`);
  const have = contentTokens(query);
  score += distinctive.filter((t) => have.includes(t)).length;
  return score;
}

function pickVariant(item, candidates) {
  const viable = candidates
    .filter((c) => {
      if (normalize(c.query) === normalize(item.keyword)) return false;
      if (contentTokens(c.query).length < 3) return false;
      if (tokens(c.query).some((t) => NOISE.has(t))) return false;
      return topicFit(item.keyword, item.topic, c.query) >= 0.4 || isPartial(item.keyword, c.query) || isPartial(item.topic, c.query);
    })
    .map((c) => ({ ...c, score: rankVariant(c, item) }))
    .sort((a, b) => b.score - a.score);
  return viable[0] || null;
}

function demandStrength(item) {
  const level = item.demand?.level;
  const levelScore = level === "ok" ? 2 : level === "weak" ? 1 : 0;
  const bing = Number(item.demand?.bing) || 0;
  const auto = item.demand?.autocomplete ? 1 : 0;
  return levelScore * 1_000_000 + bing * 10 + auto;
}

function reorderTodos(todos) {
  const left = [...todos].sort((a, b) => demandStrength(b) - demandStrength(a));
  const out = [];
  while (left.length) {
    let idx = 0;
    if (out.length) {
      const prev = out[out.length - 1];
      const topLevel = demandStrength(left[0]) >= 2_000_000 ? 2 : demandStrength(left[0]) >= 1_000_000 ? 1 : 0;
      if (prev.product && left[0].product === prev.product) {
        const alt = left.findIndex((x) => {
          const lvl = demandStrength(x) >= 2_000_000 ? 2 : demandStrength(x) >= 1_000_000 ? 1 : 0;
          return x.product !== prev.product && lvl === topLevel;
        });
        if (alt > 0) idx = alt;
      }
    }
    out.push(left.splice(idx, 1)[0]);
  }
  return out;
}

function writeQueue(queue) {
  const body = `{\n  "_readme": ${JSON.stringify(queue._readme)},\n  "items": [\n${queue.items.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]\n}\n`;
  writeFileSync(QUEUE, body);
}

function pad(s, n) {
  const str = String(s ?? "");
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

async function checkItem(item, bingKey) {
  const keyword = String(item.keyword || "").trim();
  const notes = [];
  let bing = 0;
  let related = [];
  let suggestions = [];

  if (bingKey) {
    const stats = await bingKeywordStats(bingKey, keyword);
    await sleep(SLEEP_MS);
    bing = stats.impressions;
    if (stats.error) notes.push(`bing stats HTTP ${stats.error}`);
    else if (!stats.weeks) notes.push("bing stats empty (no weekly impressions for this query)");
    related = await bingRelatedKeywords(bingKey, keyword);
    await sleep(SLEEP_MS);
  } else {
    notes.push("bing key missing; skipped Webmaster APIs");
  }

  suggestions = await googleSuggest(keyword);
  await sleep(SLEEP_MS);

  const collected = new Map();
  const addCand = (query, extra = {}) => {
    const q = String(query || "").trim();
    if (!q) return;
    const key = normalize(q);
    const prev = collected.get(key) || { query: q, impressions: 0, fromAutocomplete: false, selfSuggested: false };
    collected.set(key, {
      query: prev.query,
      impressions: Math.max(prev.impressions, extra.impressions || 0),
      fromAutocomplete: prev.fromAutocomplete || !!extra.fromAutocomplete,
      selfSuggested: prev.selfSuggested || !!extra.selfSuggested,
    });
  };

  for (const s of suggestions) addCand(s, { fromAutocomplete: true, selfSuggested: isClose(keyword, s) && normalize(s) === normalize(keyword) ? true : isClose(keyword, s) });
  for (const r of related) addCand(r.query, { impressions: r.impressions });

  // Pull more long-tail ideas when the exact query is not a known suggestion
  for (const seed of extraSeeds(item, suggestions)) {
    const extra = await googleSuggest(seed);
    await sleep(SLEEP_MS);
    for (const s of extra) addCand(s, { fromAutocomplete: true, selfSuggested: normalize(s) === normalize(seed) });
  }

  const autocomplete = suggestions.some((s) => isClose(keyword, s));
  const partialAuto = suggestions.some((s) => isPartial(keyword, s));
  const relatedClose = related.some((r) => isClose(keyword, r.query) && r.impressions > 0);
  const relatedPartial = related.some((r) => isPartial(keyword, r.query) && r.impressions > 0);

  let level = "none";
  if (bing > 0 || autocomplete || relatedClose) level = "ok";
  else if (partialAuto || relatedPartial) level = "weak";

  const result = {
    level,
    bing,
    autocomplete,
    checkedAt: nowCheckedAt(),
    previousKeyword: undefined,
    previousTopic: undefined,
    notes,
    suggestions,
    related,
    candidates: [...collected.values()],
  };

  if (level === "none") {
    const variant = pickVariant(item, result.candidates);
    if (variant) {
      result.previousKeyword = item.keyword;
      result.previousTopic = item.topic;
      item.keyword = variant.query;
      item.topic = keywordToTopic(variant.query, item.topic);
      result.level = variant.selfSuggested || variant.fromAutocomplete || variant.impressions > 0 ? "ok" : "weak";
      result.autocomplete = variant.fromAutocomplete || result.autocomplete;
      if (variant.impressions > result.bing) result.bing = variant.impressions;
      notes.push(`rewrote to "${variant.query}"`);
    }
  }

  return result;
}

function applyDemand(item, result) {
  const demand = {
    level: result.level,
    bing: result.bing,
    autocomplete: !!result.autocomplete,
    checkedAt: result.checkedAt,
  };
  if (result.previousKeyword) demand.previousKeyword = result.previousKeyword;
  item.demand = demand;
}

async function main() {
  const queue = JSON.parse(readFileSync(QUEUE, "utf8"));
  const bingKey = loadBingKey();
  if (!bingKey) {
    console.warn("No Bing Webmaster API key found (BING_WEBMASTER_API_KEY or ~/.secrets/bing_webmaster_api_key). Continuing with Google Autocomplete only.");
  }

  const todos = queue.items.filter((item) => item.status === "todo" && String(item.keyword || "").trim());
  const report = [];

  for (const item of todos) {
    const before = item.keyword;
    const result = await checkItem(item, bingKey);
    applyDemand(item, result);
    report.push({
      id: item.id,
      before,
      after: item.keyword,
      topic: item.topic,
      level: item.demand.level,
      bing: item.demand.bing,
      autocomplete: item.demand.autocomplete,
      changed: before !== item.keyword,
      notes: result.notes,
      suggestions: result.suggestions.slice(0, 5),
    });
    console.log(
      `${item.id}: ${item.demand.level}  bing=${item.demand.bing}  autocomplete=${item.demand.autocomplete}` +
        (before !== item.keyword ? `  REWROTE: "${before}" → "${item.keyword}"` : `  "${item.keyword}"`),
    );
  }

  const doneOrOther = [];
  const pending = [];
  const rechecked = [];
  for (const item of queue.items) {
    if (item.status === "todo" && String(item.keyword || "").trim()) rechecked.push(item);
    else if (item.status === "pending") pending.push(item);
    else doneOrOther.push(item);
  }
  queue.items = [...doneOrOther, ...reorderTodos(rechecked), ...pending];
  writeQueue(queue);

  console.log("");
  console.log(`${pad("id", 22)} ${pad("level", 6)} ${pad("bing", 8)} ${pad("auto", 5)} keyword`);
  console.log("-".repeat(100));
  for (const row of report) {
    const kw = row.changed ? `${row.before}  →  ${row.after}` : row.after;
    console.log(`${pad(row.id, 22)} ${pad(row.level, 6)} ${pad(row.bing, 8)} ${pad(row.autocomplete, 5)} ${kw}`);
  }
  console.log("");
  console.log(`Checked ${report.length} todo keyword(s). Queue updated and reordered by demand.`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
