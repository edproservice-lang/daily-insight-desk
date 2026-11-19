// Daily Insight Desk autowriter: writes N guides with the free Gemini API.
// Usage: GEMINI_API_KEY=... node scripts/autowriter/write.mjs [count]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import sharp from "sharp";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const QUEUE = join(import.meta.dirname, "queue.json");
const SUMMARY = join(import.meta.dirname, "..", "..", "autowriter-summary.md");
const KEY = (process.env.GEMINI_API_KEY || "").trim();
const MODELS = (process.env.GEMINI_MODELS || "gemini-3.8-flash,gemini-3.5-flash,gemini-3.7-flash,gemini-flash-latest").split(",").map((s) => s.trim()).filter(Boolean);
const LITE = (process.env.GEMINI_LITE_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash").split(",").map((x) => x.trim()).filter(Boolean);
const COUNT = Number(process.argv[2] || process.env.ARTICLES || 1);
const UA = "DailyInsightDeskBot/1.0 (+https://dailyinsightdesk.com/contact/)";
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const AFFIL_HOSTS = ["clickrtrckr.com", "clickomundo.com", "treejammer.com", "tricklyn.com"];

if (!KEY) { console.error("GEMINI_API_KEY is missing"); process.exit(1); }
const T0 = Date.now();
const log = (...a) => console.log(`[autowriter +${Math.round((Date.now() - T0) / 1000)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "pipe", encoding: "utf8", maxBuffer: 64 << 20 });

function slugify(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------- site inventory ----------
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name.startsWith("_") || e.name === "assets" ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]);
}
function readGuide(file) {
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const data = yaml.load(m[1]);
  if (!data || data.tags !== "guide") return null;
  return { file, raw, fm: m[1], body: m[2], data, url: data.permalink };
}
const guides = () => walk(SRC).filter((f) => f.endsWith(".md")).map(readGuide).filter(Boolean);
const productsMod = await import(join(SRC, "_data", "products.js") + `?t=${Date.now()}`);
const PRODUCTS = productsMod.default;
const silos = (await import(join(SRC, "_data", "silos.js"))).default;

// ---------- Gemini ----------
async function gemini(prompt, { json = true, temperature = 0.8, models = MODELS, parts = [] } = {}) {
  // curl instead of fetch: Node's fetch drops responses that take >5 min to start.
  const tmp = mkdtempSync(join(tmpdir(), "aw-"));
  const hdr = join(tmp, "h"), req = join(tmp, "req.json");
  writeFileSync(hdr, `x-goog-api-key: ${KEY}\nContent-Type: application/json\n`, { mode: 0o600 });
  writeFileSync(req, JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }, ...parts] }],
    generationConfig: { temperature, maxOutputTokens: 32000, ...(json ? { responseMimeType: "application/json" } : {}) },
  }));
  let lastErr = "";
  try {
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let raw = "", code = 0;
        try {
          raw = execFileSync("curl", ["-sS", "-m", "600", "-H", `@${hdr}`, "--data-binary", `@${req}`, "-w", "\n%{http_code}",
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`], { encoding: "utf8", maxBuffer: 64 << 20 });
          const cut = raw.lastIndexOf("\n");
          code = Number(raw.slice(cut + 1)); raw = raw.slice(0, cut);
        } catch (e) { lastErr = `${model} curl failed (${String(e.message).split("\n")[0].slice(0, 120)})`; log(lastErr); continue; }
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        if (code !== 200) {
          lastErr = `${model} HTTP ${code} ${data?.error?.status || ""}`;
          log(lastErr);
          if ([400, 403, 404].includes(code) || (code === 429 && /limit: 0|per day|PerDay/i.test(JSON.stringify(data)))) break;
          await sleep(15000);
          continue;
        }
        const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (!text) { lastErr = `${model} empty response (${data.candidates?.[0]?.finishReason || "?"})`; log(lastErr); continue; }
        log(`model ${model} answered (${text.length} chars)`);
        if (!json) return { model, out: text };
        try {
          return { model, out: JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")) };
        } catch { lastErr = `${model} returned invalid JSON`; log(lastErr); }
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  throw new Error(`All Gemini models failed: ${lastErr}`);
}

// ---------- link + content checks ----------
async function urlOk(url) {
  try {
    const host = new URL(url).hostname;
    if (AFFIL_HOSTS.some((h) => host.endsWith(h))) return false;
    for (const method of ["HEAD", "GET"]) {
      const r = await fetch(url, { method, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" }, signal: AbortSignal.timeout(20000) });
      if (r.status === 200) return true;
      if (method === "GET") return false;
    }
  } catch { return false; }
  return false;
}
const BANNED_HOST = /(^|\.)(amazon\.|amzn\.to|walmart\.|ebay\.|target\.com|bestbuy\.|homedepot\.|lowes\.|wayfair\.|etsy\.|aliexpress\.|costco\.|temu\.|shein\.)/i;
const AUTH_HOST = /\.(gov|edu|mil)$|\.gov\.uk$|\.ac\.uk$/i;
const RISKY = [
  /\bwe (?:tested|tried|used|reviewed)\b/i, /\b(?:our|my) (?:test|tests|testing|team tested)\b/i, /\bin our (?:testing|experience|kitchen|home)\b/i,
  /\bhands-on\b/i, /\b\d(?:\.\d)?\s?(?:out of|\/)\s?(?:5|10)\b/i, /\b\d(?:\.\d)?[- ]stars?\b/i, /\btestimonial/i,
  /\bcustomers (?:say|love|rave|report)\b/i, /\breviewers (?:say|love|rave|report)\b/i, /\bcures?\b/i, /\bclinically\b/i,
  /\bdoctor[- ]recommended\b/i, /\bkills? (?:99|germs|bacteria|viruses)/i, /\bguaranteed results\b/i,
];
function riskyHits(text) {
  const hits = [];
  for (const re of RISKY) {
    const g = new RegExp(re.source, "gi");
    for (const m of text.matchAll(g)) {
      const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
      if (/\b(not|never|no|n't|haven't|didn't)\b|n't /.test(before)) continue;
      hits.push(m[0]);
    }
  }
  return [...new Set(hits)];
}
const words = (md) => md.replace(/\{%[\s\S]*?%\}/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_>`|-]/g, " ").split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
const mdLinks = (md) => [...md.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => ({ full: m[0], text: m[1], href: m[2], index: m.index }));

function checkArticle(a, ctx) {
  const errs = [];
  for (const k of ["title", "metaTitle", "description", "dek", "slug", "body", "faq", "story", "sources", "related", "heroQuery", "heroAlt"]) if (!a[k]) errs.push(`missing field ${k}`);
  if (errs.length) return errs;
  const body = a.body;
  const wc = words(body);
  if (wc < 1150 || wc > 1900) errs.push(`body has ${wc} words; it must be 1,250-1,750 words`);
  if (/^# /m.test(body)) errs.push("body must not contain an H1 (# ). Start sections with ## ");
  if ((body.match(/^## /gm) || []).length < 5) errs.push("body needs at least 5 H2 sections");
  if (!/^### /m.test(body)) errs.push("body needs at least one H3 (###) subsection");
  if (!/^## .*pros and cons/im.test(body)) errs.push('body needs a "## Pros and cons" section (or "## ... pros and cons ...")');
  if (!/^## .*who (it|this) is (for|not for)/im.test(body)) errs.push('body needs a "## Who it is for (and who it is not for)" style section');
  if (/^## (sources|faq|frequently asked)/im.test(body)) errs.push("do not write Sources or FAQ sections in body; they come from fields");
  if (ctx.product) {
    const n = (body.match(new RegExp(`\\{%\\s*product\\s+"${ctx.product}"\\s*%\\}`, "g")) || []).length;
    if (n !== 1) errs.push(`body must contain the line {% product "${ctx.product}" %} exactly once`);
  } else if (/\{%\s*product/.test(body)) errs.push("this article has no product; remove the product shortcode");
  if (/\{%(?!\s*product\s+"[a-z0-9]+"\s*%\})/.test(body)) errs.push("no Nunjucks tags other than the product shortcode");
  const internal = mdLinks(body).filter((l) => l.href.startsWith("/"));
  const known = new Set(ctx.existing.map((g) => g.url));
  const targets = internal.map((l) => l.href.split("#")[0]);
  for (const t of targets) if (!known.has(t)) errs.push(`internal link ${t} is not an existing article URL`);
  if (new Set(targets).size !== targets.length) errs.push("each internal target may be linked only once in body");
  if (new Set(targets).size < Math.min(3, known.size)) errs.push(`only ${new Set(targets).size} in-sentence internal links; need 3-6 different articles`);
  if (new Set(targets).size > 6) errs.push("more than 6 internal links");
  for (const l of internal) {
    const line = body.slice(body.lastIndexOf("\n", l.index) + 1, body.indexOf("\n", l.index) === -1 ? undefined : body.indexOf("\n", l.index));
    if (/^#/.test(line)) errs.push(`internal link inside a heading: ${l.full}`);
    if (/^(click here|here|this|read more|this guide)$/i.test(l.text.trim())) errs.push(`weak anchor text "${l.text}"`);
  }
  for (const l of mdLinks(body).filter((x) => /^https?:/i.test(x.href))) {
    let host = ""; try { host = new URL(l.href).hostname.replace(/^www\./, ""); } catch {}
    if (BANNED_HOST.test(host) || AFFIL_HOSTS.includes(host)) errs.push(`forbidden external link ${host}`);
  }
  const hits = riskyHits([body, ...a.faq.map((f) => `${f.q} ${f.a}`), a.description, a.dek].join("\n"));
  if (hits.length) errs.push(`remove these claims (no tests, ratings, testimonials or medical claims): ${hits.join("; ")}`);
  if (!Array.isArray(a.story) || a.story.length !== 7) errs.push("story must have exactly 7 cards");
  if (a.faq.length < 4) errs.push("faq needs 4-6 items");
  if (a.metaTitle.length > 65) errs.push("metaTitle must be at most 60 characters");
  if (a.description.length < 110 || a.description.length > 170) errs.push("description must be 140-160 characters");
  if (!/^[a-z0-9-]{8,80}$/.test(a.slug)) errs.push("slug must be lowercase-hyphenated");
  if (ctx.existing.some((g) => g.url.endsWith(`/${a.slug}/`))) errs.push("slug already exists");
  return errs;
}

// ---------- prompt ----------
function buildPrompt(item, existing, feedback) {
  const product = item.product ? PRODUCTS[item.product] : null;
  const list = existing.map((g) => `- ${g.url} | ${g.data.title} | ${g.data.description}`).join("\n");
  const productBlock = product ? `
PRODUCT FOR THIS ARTICLE (the only facts you may state about it; do NOT invent a price, spec, size, rating, or review):
key: ${item.product}
name: ${product.name}
facts: ${product.summary} ${product.points.join(" ")}
Place this exact line on its own line, once, right after the "who it is for" section: {% product "${item.product}" %}
The product box shows the affiliate link and disclosure. Do not write the affiliate URL yourself.
Mention the product naturally and honestly where relevant, as one option, never as the only answer. Say plainly that Daily Insight Desk has not tested it.` : `
This is a helpful guide with no product box. Do not include any product shortcode.`;
  return `You write for Daily Insight Desk (dailyinsightdesk.com), a US home & garden guide site. Voice: plain, specific, confident, a little dry; short declarative sentences; practical steps; honest about trade-offs; persuasive because it is useful, never bland filler, never hype. US English, US units.

ARTICLE TOPIC: ${item.topic}
TARGET LONG-TAIL SEARCH: "${item.keyword}" (write for the real intent behind it; answer it in the first section)
SILO: ${item.silo}
TODAY: ${TODAY}
${productBlock}

HARD RULES
1. Body: 1,300-1,700 words of Markdown. Use ## for sections and ### for subsections. No H1. First section is "## The short answer". Include "## Pros and cons" (bold **Pros** and **Cons** bullet lists) and "## Who it is for, and who should skip it" (or similar wording containing "who it is for"). Do NOT write a Sources or FAQ section in the body.
2. Never claim we tested, tried, used, measured or reviewed anything. No testimonials, quotes from customers, review counts, star ratings, or invented statistics. No medical or health claims. No prices or specs unless given above.
3. INTERNAL LINKS: put 3-6 links to DIFFERENT existing articles from the list below INSIDE normal sentences, as Markdown links [descriptive anchor](/path/). Anchors are 2-6 natural words describing the target topic (vary them; never "click here"/"this guide"). Each target at most once. Never inside headings. Only use URLs from this list:
${list}
4. EXTERNAL SOURCES: cite 2-3 real, neutral authority pages (US .gov, .edu extension services, or an official manufacturer care/manual page) that you are confident exist at that exact URL; link each once inside a sentence in the body and list it in "sources". Also add 2 extra backup candidates at the end of "sources" with "inline": false (prefer stable top-level pages like epa.gov, cdc.gov, usda.gov, extension.umn.edu, extension.psu.edu that are certain to exist). Mark the linked ones "inline": true. Never link to stores, Amazon, marketplaces, or blogs/roundups with affiliate links.
5. FAQ: 4-6 real questions people search, answers 2-4 sentences.
5b. STYLE: US spelling (color, not colour). No brand names except the product above. Do not copy the product facts word for word; paraphrase briefly and let the product box carry the details. Only attribute a claim to a source if that page is specifically about it; otherwise state general advice without attribution. Internal links must read naturally: if a target is only loosely related, write a short bridging sentence that gives the reader a real reason to click.
6. Web Story: exactly 7 cards. Card 1 is a cover. The last card invites reading the full guide. Card titles 3-7 words, text max 18 words. For each card give a concrete stock-photo search query (2-4 plain words, a real scene, no brand names, no text) and alt text describing that scene. ${product ? 'Set "kind":"product" on exactly one card about the product itself; other cards "kind":"stock".' : 'All cards "kind":"stock".'}
7. "related": choose the 3 most related existing articles (href from the list) with a one-sentence note on why.

Return ONLY JSON with this shape:
{"title": "question or how-to headline, max 70 chars", "metaTitle": "max 60 chars", "description": "meta description 140-160 chars", "dek": "1-2 sentence standfirst", "slug": "lowercase-hyphen-slug", "readTimeNote": "", "heroQuery": "stock photo search for a wide hero image, 2-4 words", "heroAlt": "alt text for that hero", "body": "markdown", "toc": [{"heading": "exact H2 text", "label": "2-4 word label"}], "faq": [{"q": "", "a": ""}], "sources": [{"name": "Publisher, page title", "url": "https://...", "note": "one sentence on what it supports"}], "related": [{"href": "/path/", "title": "", "note": ""}], "story": [{"id": "short-id", "title": "", "text": "", "imageQuery": "", "alt": "", "kind": "stock"}]}
${feedback ? `\nYOUR PREVIOUS DRAFT FAILED THESE CHECKS. Fix every one:\n- ${feedback.join("\n- ")}\n` : ""}`;
}

// ---------- images ----------
const usedImages = new Set();
let openverseBlocked = false;
const JUNK = /poster|painting|drawing|illustration|engraving|lithograph|map\b|specimen|logo|diagram|coat of arms|flag|film|movie|catalog|catalogue|page \d|book|scan|statue|temple|church|cathedral|saint|god|goddess|shrine|buddha|krishna|shiva|ganesh|idol|deity|religio|bible|cross\b|portrait of|stamp|coin|advert|\bad\b|magazine|newspaper/i;
async function candidates(query, aspect, n = 4) {
  const out = [];
  const qs = [...new Set([query, query.split(" ").slice(0, 2).join(" ")])];
  for (const q of qs) {
    const lists = [];
    if (!openverseBlocked) {
      try {
        const u = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=cc0,pdm&category=photograph&page_size=20&mature=false${aspect ? `&aspect_ratio=${aspect}` : ""}`;
        const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
        if (r.status === 403 || r.status === 429) { openverseBlocked = true; log(`openverse ${r.status}; using Wikimedia Commons only`); }
        else if (r.ok) lists.push((await r.json()).results.map((x) => ({ url: x.url, w: x.width, h: x.height, title: `${x.title} ${(x.tags || []).map((t) => t.name).join(" ")}`, credit: `${x.title || "Photo"}${x.creator ? ` by ${x.creator}` : ""}, ${String(x.license).toUpperCase()} via Openverse` })));
        else log(`openverse ${r.status}`);
      } catch (e) { log(`openverse ${e.message}`); }
    }
    try {
      const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=30&gsrsearch=${encodeURIComponent(q + " filetype:bitmap filemime:jpeg")}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600`;
      const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const pages = Object.values((await r.json()).query?.pages || {});
        lists.push(pages.map((p) => ({ p, ii: p.imageinfo?.[0] })).filter(({ ii }) => ii && /^(cc0|public domain|pd)/i.test(ii.extmetadata?.LicenseShortName?.value || ""))
          .map(({ p, ii }) => ({ url: ii.thumburl || ii.url, w: ii.width, h: ii.height, title: `${p.title} ${(ii.extmetadata?.ImageDescription?.value || "").replace(/<[^>]+>/g, "").slice(0, 200)}`, credit: `${p.title.replace(/^File:/, "").replace(/\.\w+$/, "")}, ${ii.extmetadata.LicenseShortName.value}, Wikimedia Commons` })));
      }
    } catch (e) { log(`commons ${e.message}`); }
    for (const x of lists.flat()) {
      if (out.length >= n) break;
      if (!x.url || usedImages.has(x.url) || out.some((o) => o.url === x.url) || JUNK.test(x.title) || Math.min(x.w || 0, x.h || 0) < 600) continue;
      try {
        const r = await fetch(x.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const meta = await sharp(buf).metadata();
        if (!meta.width || Math.min(meta.width, meta.height) < 540) continue;
        const thumb = await sharp(buf).rotate().resize(320, 320, { fit: "inside" }).jpeg({ quality: 60 }).toBuffer();
        out.push({ ...x, buf, thumb });
      } catch { /* next */ }
    }
    if (out.length >= n) break;
  }
  return out;
}
// One Gemini vision call picks a fitting photo for every slot (or none).
async function pickImages(slots) {
  const parts = [];
  let text = "Pick photos for a US home & garden article and its Web Story. For each slot below, choose the ONE candidate that is a real photograph clearly showing the described scene (or very close). Reject drawings, posters, scans, documents, specimens, religious or political imagery, close-up faces of identifiable people, images with visible text or logos, and anything off-topic. If no candidate fits, answer -1. Never pick the same candidate for two slots.\n";
  let k = 0;
  for (const s of slots) {
    text += `\nSLOT ${s.key}: "${s.want}". Candidates: ${s.cands.map((c) => { c.id = k++; return `#${c.id}`; }).join(", ") || "none"}`;
    for (const c of s.cands) parts.push({ text: `Candidate #${c.id}:` }, { inline_data: { mime_type: "image/jpeg", data: c.thumb.toString("base64") } });
  }
  text += `\n\nReturn JSON {"picks": {"<slot key>": <candidate number or -1>}}`;
  try {
    const { out } = await gemini(text, { temperature: 0, models: LITE, parts });
    return out.picks || {};
  } catch (e) { log(`image pick failed: ${e.message}`); return {}; }
}
async function portrait(buf, out, contain = false) {
  mkdirSync(dirname(out), { recursive: true });
  if (!contain) return sharp(buf).rotate().resize(720, 960, { fit: "cover", position: "attention" }).webp({ quality: 72 }).toFile(out);
  const bg = await sharp(buf).rotate().resize(720, 960, { fit: "cover" }).blur(30).modulate({ brightness: 0.85 }).toBuffer();
  const fg = await sharp(buf).rotate().resize(680, 900, { fit: "inside" }).toBuffer();
  return sharp(bg).composite([{ input: fg, gravity: "centre" }]).webp({ quality: 74 }).toFile(out);
}

// ---------- writing an article ----------
function frontMatter(a, item, wc, heroCredit, storyPages) {
  const silo = silos.find((s) => s.slug === item.silo);
  const tocMap = new Map((a.toc || []).map((t) => [t.heading.trim(), t.label]));
  const toc = [...a.body.matchAll(/^## (.+)$/gm)].map((m) => ({ id: slugify(m[1].trim()), label: tocMap.get(m[1].trim()) || m[1].trim() }));
  toc.push({ id: "sources", label: "Sources" });
  const fm = {
    layout: "layouts/article.njk", tags: "guide", title: a.title, metaTitle: a.metaTitle, description: a.description, dek: a.dek,
    silo: item.silo, siloName: silo ? silo.name : item.silo, date: TODAY, updated: TODAY, readTime: `${Math.max(4, Math.round(wc / 200))} min read`,
    hero: `/assets/images/guide-${a.slug}`, heroHeight: 900, heroAlt: a.heroAlt, heroCaption: heroCredit.startsWith("Daily Insight Desk") ? "Illustration by Daily Insight Desk." : `Stock photo: ${heroCredit}. Illustrative only, not a test by Daily Insight Desk.`,
    ogImage: `/assets/images/guide-${a.slug}-1600.webp`, ogAlt: a.heroAlt, permalink: `/${item.silo}/${a.slug}/`,
    story: { slug: a.slug, ...(item.product ? { product: item.product } : {}), pages: storyPages },
    related: a.related.slice(0, 3), toc, faq: a.faq.map((f) => ({ q: f.q, a: f.a })),
    autowriter: { model: a._model, queueId: item.id },
  };
  return yaml.dump(fm, { lineWidth: -1, noRefs: true, quotingType: '"' }).replace(/^(date|updated): ["']?(\d{4}-\d\d-\d\d)["']?$/gm, "$1: $2");
}

async function draft(item, existing, feedback) {
  const { model, out } = process.env.AW_FAKE_DRAFT ? { model: "fake", out: JSON.parse(readFileSync(process.env.AW_FAKE_DRAFT, "utf8")) } : await gemini(buildPrompt(item, existing, feedback));
  out._model = model;
  out.slug = slugify(out.slug || out.title || item.topic);
  out.related = (out.related || []).filter((r) => existing.some((g) => g.url === r.href));
  // verify sources; unlink any failing or non-authority URL
  const okSources = [];
  for (const s of (out.sources || []).slice(0, 6)) {
    if (okSources.length >= 3) break;
    let host = ""; try { host = new URL(s.url).hostname; } catch {}
    const allowed = host && !BANNED_HOST.test(host) && !AFFIL_HOSTS.some((h) => host.endsWith(h));
    if (allowed && await urlOk(s.url)) { if (new URL(s.url).pathname.replace(/\/+$/, "") === "") s.name = String(s.name).split(",")[0] + " (home page)"; okSources.push(s); } else log(`dropping source ${s.url}`);
  }
  out.sources = okSources;
  const okSet = new Set(okSources.map((s) => s.url));
  out.body = String(out.body || "").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, t, u) => (okSet.has(u) ? m : t));
  return out;
}

async function rescueSources(a) {
  log("no source verified; asking for replacement sources");
  try {
    const { out } = await gemini(`For a US home & garden article titled "${a.title}" (${a.description}), list 8 real, stable, neutral authority web pages (specific pages, not home pages) (US .gov, .edu extension service, or official manufacturer care page) that support general advice in it. Prefer top-level pages that certainly exist. Return JSON {"sources":[{"name":"Publisher, page title","url":"https://...","note":"one sentence on what it supports"}]}`, { temperature: 0.2, models: LITE });
    const ok = [];
    for (const s of out.sources || []) {
      if (ok.length >= 2) break;
      let host = ""; try { host = new URL(s.url).hostname; } catch {}
      if (host && new URL(s.url).pathname.replace(/\/+$/, "") !== "" && !BANNED_HOST.test(host) && await urlOk(s.url)) ok.push(s);
    }
    return ok;
  } catch (e) { log(`rescue failed: ${e.message}`); return []; }
}

async function writeArticle(item, existing) {
  let a = await draft(item, existing, item._buildError ? [`The site build failed on the last try; avoid whatever caused this: ${item._buildError.slice(-1200)}`] : undefined);
  let errs = checkArticle(a, { product: item.product, existing });
  if (!a.sources.length) a.sources = await rescueSources(a);
  if (!a.sources.length) errs.push("none of your source URLs returned HTTP 200; give real, stable .gov/.edu/manufacturer URLs");
  if (errs.length) {
    log(`draft 1 issues: ${errs.join(" | ")}`);
    a = await draft(item, existing, errs);
    errs = checkArticle(a, { product: item.product, existing });
    if (!a.sources.length) a.sources = await rescueSources(a);
    if (!a.sources.length) errs.push("no verified sources");
    if (errs.length) throw new Error(`draft 2 still fails: ${errs.join(" | ")}`);
  }
  // images
  const imgDir = join(SRC, "assets", "images");
  const product = item.product ? PRODUCTS[item.product] : null;
  const productImgs = product ? [product.image, ...(product.storyImages || [])] : [];
  const slots = [{ key: "hero", want: a.heroAlt || a.heroQuery, cands: await candidates(a.heroQuery, "wide") }];
  for (const c of slots[0].cands) usedImages.add(c.url);
  for (const [i, card] of a.story.entries()) {
    if (card.kind === "product" && productImgs.length) continue;
    const cands = await candidates(card.imageQuery || a.heroQuery, "tall", 3);
    for (const c of cands) usedImages.add(c.url);
    slots.push({ key: `card${i + 1}`, want: card.alt || card.imageQuery, cands });
  }
  const picks = await pickImages(slots);
  const chosen = {};
  const taken = new Set();
  for (const s of slots) {
    const c = s.cands.find((x) => x.id === Number(picks[s.key]));
    if (c && !taken.has(c.url)) { chosen[s.key] = c; taken.add(c.url); }
  }
  const silo = silos.find((x) => x.slug === item.silo);
  const fallbacks = [silo?.image, "/assets/images/hero-patio", "/assets/images/still-tools", "/assets/images/still-kitchen", "/assets/images/still-patio"].filter(Boolean)
    .map((b) => join(SRC, `${b}-1600.webp`)).filter((f, i, arr) => arr.indexOf(f) === i && existsSync(f));
  let fb = 0;
  const hero = chosen.hero || { buf: readFileSync(fallbacks[fb++ % fallbacks.length]), credit: "Daily Insight Desk illustration", house: true };
  for (const w of [1600, 800]) {
    await sharp(hero.buf).rotate().resize(w, Math.round((w * 9) / 16), { fit: "cover", position: "attention" }).webp({ quality: 72 }).toFile(join(imgDir, `guide-${a.slug}-${w}.webp`));
  }
  const imageReport = [`hero: ${chosen.hero ? "stock photo" : "site illustration (no fitting stock photo)"}`];
  const storyPages = [];
  const tones = ["ink", "moss"];
  for (const [i, card] of a.story.entries()) {
    const out = join(imgDir, "stories", a.slug, `p${i + 1}.webp`);
    let alt = card.alt;
    if (card.kind === "product" && productImgs.length) {
      await portrait(readFileSync(join(SRC, productImgs.shift())), out, true);
      alt = `Seller photo: ${product.name}. ${product.alt || ""}`.trim();
      imageReport.push(`card ${i + 1}: seller photo`);
    } else if (chosen[`card${i + 1}`]) {
      await portrait(chosen[`card${i + 1}`].buf, out);
      imageReport.push(`card ${i + 1}: stock photo`);
    } else {
      const f = fallbacks[fb++ % fallbacks.length];
      await portrait(readFileSync(f), out, true);
      alt = "Illustration of home and garden tools";
      imageReport.push(`card ${i + 1}: site illustration (no fitting stock photo)`);
    }
    storyPages.push({ id: slugify(card.id || `card-${i + 1}`) || `card-${i + 1}`, title: card.title, text: card.text, image: `/assets/images/stories/${a.slug}/p${i + 1}.webp`, imageWidth: 720, imageHeight: 960, alt, tone: tones[i % 2] });
  }
  a._imageReport = imageReport;
  if (hero.house) a.heroAlt = silo?.alt || "Illustration of home and garden tools";
  await sharp(join(imgDir, "stories", a.slug, "p1.webp")).toFile(join(imgDir, "stories", `${a.slug}.webp`));
  // body + sources section
  const wc = words(a.body);
  const sourcesMd = `## Sources\n\n${a.sources.map((s) => `- [${s.name}](${s.url}). ${s.note}`).join("\n")}\n\nDaily Insight Desk has not tested the products mentioned here. Product details come from the seller's page and can change.\n`;
  const md = `---\n${frontMatter(a, item, wc, hero.credit, storyPages)}---\n\n${a.body.trim()}\n\n${sourcesMd}`;
  const dir = join(SRC, item.silo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${a.slug}.md`), md);
  const internal = new Set(mdLinks(a.body).filter((l) => l.href.startsWith("/")).map((l) => l.href)).size;
  return { a, url: `/${item.silo}/${a.slug}/`, file: join(dir, `${a.slug}.md`), wc, internal };
}

// ---------- backlinks from older articles ----------
async function addBacklinks(newUrl, a, existing) {
  const cands = [];
  for (const g of existing) {
    if (g.raw.includes(`](${newUrl})`)) continue;
    const paras = g.body.split("\n").map((t, i) => ({ i, t })).filter((p) => p.t.length > 120 && !/^(#|-|\*|\{%|\||>|\d+\.)/.test(p.t) && (p.t.match(/\]\(/g) || []).length < 2);
    for (const p of paras.slice(0, 8)) cands.push({ file: g.file.slice(ROOT.length + 1), line: p.i, text: p.t });
  }
  if (!cands.length) return [];
  const prompt = `A new article was published: "${a.title}" at ${newUrl}. Summary: ${a.description}
From the paragraphs below (from OTHER articles on the same site), pick up to 3 where a reader would genuinely benefit from a link to the new article. For each, return an EXACT phrase copied character-for-character from that paragraph (2-7 words, not already inside [...](...), not a heading) that naturally describes the new article's topic. At most one per file. If nothing fits naturally, return fewer or none. Do not rewrite anything.
Return JSON: {"links":[{"file":"","line":0,"phrase":""}]}
PARAGRAPHS:
${cands.map((c) => JSON.stringify(c)).join("\n")}`;
  let out;
  try { out = (await gemini(prompt, { temperature: 0.2, models: LITE })).out; } catch (e) { log(`backlink call failed: ${e.message}`); return []; }
  const done = [];
  const seen = new Set();
  for (const l of (out.links || []).slice(0, 3)) {
    const c = cands.find((x) => x.file === l.file && x.line === l.line);
    const phrase = String(l.phrase || "");
    if (!c || seen.has(c.file) || phrase.split(/\s+/).length < 2 || phrase.split(/\s+/).length > 8) continue;
    const idx = c.text.indexOf(phrase);
    if (idx < 0 || c.text.indexOf(phrase, idx + 1) >= 0) continue;
    const inLink = mdLinks(c.text).some((m) => idx < m.index + m.full.length && idx + phrase.length > m.index);
    if (inLink) continue;
    const path = join(ROOT, c.file);
    const raw = readFileSync(path, "utf8");
    if (raw.split(c.text).length !== 2) continue;
    const newText = c.text.slice(0, idx) + `[${phrase}](${newUrl})` + c.text.slice(idx + phrase.length);
    writeFileSync(path, raw.replace(c.text, () => newText));
    seen.add(c.file);
    done.push({ file: c.file, phrase });
  }
  return done;
}

function removeSoon(topic) {
  const p = join(SRC, "_data", "silos.js");
  const raw = readFileSync(p, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== `${JSON.stringify(topic)},` && l.trim() !== JSON.stringify(topic));
  writeFileSync(p, lines.join("\n"));
}

function build() {
  try { sh("npx eleventy --quiet && node scripts/check-site.js"); return null; }
  catch (e) { return `${e.stdout || ""}\n${e.stderr || ""}`.trim().slice(-3000); }
}

// ---------- main ----------
const queue = JSON.parse(readFileSync(QUEUE, "utf8"));
const results = [];
let made = 0;
for (const item of queue.items) {
  if (made >= COUNT) break;
  if (item.status !== "todo") continue;
  if ((process.env.SKIP_IDS || "").split(",").includes(item.id)) { log(`skip ${item.id}: already drafted in an open PR`); continue; }
  if (item.product && !PRODUCTS[item.product]) { log(`skip ${item.id}: product ${item.product} is not in products.js`); continue; }
  log(`writing ${item.id}: ${item.topic}`);
  let ok = false;
  let attemptNote = null;
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    try {
      const existing = guides();
      if (attemptNote) item._buildError = attemptNote;
      const r = await writeArticle(item, existing);
      const backs = await addBacklinks(r.url, r.a, existing);
      removeSoon(item.topic);
      const err = build();
      if (err) throw Object.assign(new Error("build failed"), { buildLog: err });
      item.status = "done"; item.slug = r.a.slug; item.url = r.url; item.date = TODAY; delete item._buildError;
      writeFileSync(QUEUE, `{\n  "_readme": ${JSON.stringify(queue._readme)},\n  "items": [\n${queue.items.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]\n}\n`);
      sh(`git add -A src scripts/autowriter/queue.json && git commit -q -m ${JSON.stringify(`Autowriter: ${r.a.title}`)}`);
      results.push({ ...r, backs, model: r.a._model, sources: r.a.sources.length, images: r.a._imageReport });
      made++; ok = true;
      log(`done ${r.url} (${r.wc} words, ${r.internal} internal links, ${backs.length} backlinks)`);
    } catch (e) {
      log(`attempt ${attempt + 1} failed for ${item.id}: ${e.message}${e.buildLog ? `\n${e.buildLog}` : ""}`);
      attemptNote = e.buildLog || e.message;
      sh("git checkout -q -- src scripts/autowriter/queue.json && git clean -fdq src");
      usedImages.clear();
    }
  }
  if (!ok) results.push({ failed: item.id, topic: item.topic, reason: String(attemptNote).slice(0, 300) });
}

const lines = [`## Autowriter run ${TODAY}`, "", "Drafts written with the free Gemini API. **Review and edit before merging.** Nothing here is merged automatically.", "",
  "| Article | Words | In-text internal links | Backlinks added | Verified sources | Model |", "|---|---|---|---|---|---|"];
for (const r of results.filter((x) => !x.failed)) {
  lines.push(`| [${r.a.title}](https://dailyinsightdesk.com${r.url}) (\`${r.file.slice(ROOT.length + 1)}\`) | ${r.wc} | ${r.internal} | ${r.backs.length} | ${r.sources} | ${r.model} |`);
}
for (const r of results.filter((x) => x.failed)) lines.push("", `Skipped **${r.topic}** (${r.failed}): ${r.reason.replace(/\n/g, " ")}`);
const imgLines = results.filter((r) => r.images).map((r) => `- ${r.a.title}: ${r.images.join("; ")}`);
if (imgLines.length) lines.push("", "### Images", ...imgLines);
const backs = results.flatMap((r) => (r.backs || []).map((b) => `- ${b.file}: linked “${b.phrase}” → ${r.url}`));
if (backs.length) lines.push("", "### Backlinks inserted in older articles", ...backs);
lines.push("", "Checklist: read for accuracy, confirm no invented specs or prices, check story images, then merge.");
writeFileSync(SUMMARY, lines.join("\n") + "\n");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `made=${made}\n`);
log(`made ${made} article(s)`);
