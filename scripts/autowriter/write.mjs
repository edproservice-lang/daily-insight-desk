// Daily Insight Desk autowriter: writes N guides with the free Gemini API.
// Usage: GEMINI_API_KEY=... node scripts/autowriter/write.mjs [count]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
const TEST_PIXABAY = process.argv[2] === "--test-pixabay";
function loadPixabayKey() {
  const fromEnv = (process.env.PIXABAY_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  if (TEST_PIXABAY) {
    const p = join(process.env.HOME || "", ".secrets", "pixabay_api_key");
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  }
  return "";
}
const PIXABAY = loadPixabayKey();
const PEXELS = (process.env.PEXELS_API_KEY || "").trim(); // dormant; Pexels paused new API keys
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const AFFIL_HOSTS = ["clickrtrckr.com", "clickomundo.com", "treejammer.com", "tricklyn.com"];

if (!KEY && !TEST_PIXABAY) { console.error("GEMINI_API_KEY is missing"); process.exit(1); }
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
const UNTESTED = [
  /\b(?:we|this desk|daily insight desk)\s+(?:have|has|had)\s+not\s+(?:tested|used|run|tried|measured|held|ordered|watched)/i,
  /\bwe\s+(?:did not|didn't|do not|don't)\s+(?:test|use|run|measure|hold|order|watch|try)\b/i,
  /\b(?:have|has|had)(?:n't| not)\s+tested\b/i,
  /\bnot\s+hands-?on\b/i,
  /\bhands-?on\s+tested\b/i,
  /\bnot a test(?:\s+by|\s+we|\s+from|\s+of|\s+this)?\b/i,
  /\bthis desk has not\b/i,
  /\bwe have not (?:stood|confirmed|repeated|been)\b/i,
];
function untestedHits(text) {
  const hits = [];
  for (const re of UNTESTED) {
    const g = new RegExp(re.source, "gi");
    for (const m of text.matchAll(g)) hits.push(m[0]);
  }
  return [...new Set(hits)];
}
function sameOffer(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (u) => `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`;
    return norm(ua) === norm(ub);
  } catch {
    return false;
  }
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
  if (!/\*\*Pros:?\*\*/.test(body)) errs.push('Pros and cons section must lead with a **Pros** list');
  if (!/\*\*Good to know:?\*\*|\*\*Best results(?: when)?:?\*\*|^### Good to know|^### Best results/im.test(body)) {
    errs.push('Pros and cons section needs a **Good to know** or **Best results when** list, not a drawback-style **Cons** list');
  }
  if (/^###?\s+Cons\b/m.test(body) || /\*\*Cons:?\*\*/.test(body)) {
    errs.push('use **Good to know** or **Best results when** instead of a **Cons** heading');
  }
  if (!/^## .*who .{0,40}(ideal for|(it|this) is for)/im.test(body)) {
    errs.push('body needs a "## Who it\'s ideal for" section (or similar positive fit wording)');
  }
  if (/^## .*who should skip/im.test(body) || /^###?\s+Who should skip/im.test(body)) {
    errs.push('reframe "who should skip it" as "## Who it\'s ideal for" with a positive fit note');
  }
  if (/^## (sources|faq|frequently asked)/im.test(body)) errs.push("do not write Sources or FAQ sections in body; they come from fields");
  if (!/^## The short answer\n/i.test(body.trimStart())) errs.push('body must open with "## The short answer"');
  else {
    const afterHeading = body.trimStart().replace(/^##[^\n]*\n+/, "");
    const opening = (afterHeading.split(/\n\s*\n/)[0] || "")
      .replace(/\[([^\]]+)\](\([^)]*\))/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const openingWords = opening.split(/\s+/).filter(Boolean).length;
    if (openingWords < 40 || openingWords > 60) {
      errs.push(`opening answer is ${openingWords} words; it must be a 40-60 word direct answer to the title`);
    }
  }
  if (ctx.product) {
    const n = (body.match(new RegExp(`\\{%\\s*product\\s+"${ctx.product}"\\s*%\\}`, "g")) || []).length;
    if (n !== 1) errs.push(`body must contain the line {% product "${ctx.product}" %} exactly once`);
    const short = body.search(/\{%\s*product\s+"[a-z0-9]+"\s*%\}/);
    if (short !== -1) {
      const start = body.lastIndexOf("\n## ", short);
      const slice = body.slice(start === -1 ? 0 : start, short);
      const cons = slice.match(/\b(trade-?offs?|drawbacks?|limitations?|not a replacement|it is not for|who should skip|does not add a pump|not a pressure washer|treat it as a second surface|hard on (?:a |the )?knife)\b/i);
      if (cons) errs.push(`sales section must be benefits-only (remove "${cons[0]}" from the paragraphs above the product box)`);
    }
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
  const productHref = ctx.product && PRODUCTS[ctx.product] ? PRODUCTS[ctx.product].href : "";
  for (const l of mdLinks(body).filter((x) => /^https?:/i.test(x.href))) {
    let host = ""; try { host = new URL(l.href).hostname.replace(/^www\./, ""); } catch {}
    if (BANNED_HOST.test(host)) errs.push(`forbidden external link ${host}`);
    else if (AFFIL_HOSTS.includes(host) && !sameOffer(l.href, productHref)) errs.push(`forbidden external link ${host}`);
  }
  if (ctx.product && productHref) {
    const ctas = mdLinks(body).filter((l) => sameOffer(l.href, productHref));
    if (!ctas.length) errs.push("body needs at least one in-sentence call to action linking to the product's affiliate URL");
    for (const l of ctas) {
      if (/^(click here|here|this|read more|this guide|buy now)$/i.test(l.text.trim())) errs.push(`weak affiliate anchor text "${l.text}"`);
    }
  }
  const hay = [body, ...a.faq.map((f) => `${f.q} ${f.a}`), a.description, a.dek, ...(Array.isArray(a.story) ? a.story.map((s) => `${s.title || ""} ${s.text || ""}`) : [])].join("\n");
  const hits = riskyHits(hay);
  if (hits.length) errs.push(`remove these claims (no tests, ratings, testimonials or medical claims): ${hits.join("; ")}`);
  const untested = untestedHits(hay);
  if (untested.length) errs.push(`do not say or imply we did not test or use the product (remove: ${untested.join("; ")})`);
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
affiliate URL (use this exact URL for in-text calls to action): ${product.href}
facts: ${product.summary} ${product.points.join(" ")}
Write a short section near the end titled "Where ${product.name} fits" (or similar). In that section, and in every paragraph that sells the product, mention ONLY benefits and persuade the reader to look at the offer. Never mention cons, trade-offs, drawbacks, limitations, or what the product is not. Do not undercut the product there (no "but it won't...", no "treat it as a second surface", no "not a replacement for..."). Elsewhere in the article, keep the how-to honest, but do not undercut the product: the "## Pros and cons" section should lead with strong **Pros**, then a **Good to know** or **Best results when** list of constructive usage, care, or fit tips (not a drawback list). Frame the audience section as "## Who it's ideal for" (or similar), with a short positive fit note rather than a "who should skip it" or "it is not for" block.
Place this exact line on its own line, once, at the end of that benefits-only sales section: {% product "${item.product}" %}
The product box already includes a button to the same offer. Still include in-sentence Markdown links to the affiliate URL: [natural, specific anchor](${product.href}). Write at least two of these CTAs in benefit-focused sentences, where a reader who is ready to look at the offer would naturally want them. Never use "click here", "buy now", or "this guide" as the anchor. Do not place a CTA immediately after a list of drawbacks.
Do not write an affiliate disclosure, a commission notice, or a "we may earn" line; the site inserts a short note automatically before the first offer link.` : `
This is a helpful guide with no product box. Do not include any product shortcode or affiliate URL.`;
  return `You write for Daily Insight Desk (dailyinsightdesk.com), a US home & garden guide site. US English, US units.

Every article must balance three goals. The piece should read as a useful guide first, not as an ad:
1) ATTRACT TRAFFIC (SEO). Write for this target long-tail search and the real intent behind it: "${item.keyword}". Put the target keyword, or a very close natural variant, in the title (the title becomes the on-page H1), in the 40-60 word opening answer, and in exactly one H2. Use descriptive, specific H2/H3s a searcher would scan. The first paragraph must be a direct 40-60 word answer to the title question, so a search or AI system can quote it. The FAQ field should cover related questions people actually search.
2) ADD REAL VALUE. The guide must stand on its own as practical how-to help even if the reader never clicks a product link. Give clear steps, constructive "good to know" tips, and advice they can use today. Be specific, never filler.
3) SELL, WITHOUT READING AS AN AD. When a product is provided, give it a benefits-only sales section: concrete benefits, a next step, and in-sentence calls to action to the affiliate URL. In that section, and in any paraphrase of the product box, never mention cons, trade-offs, or drawbacks. Do not write a sales letter, and do not treat the product as the only possible answer in the rest of the guide.

Voice: plain, specific, confident, a little dry; short declarative sentences; practical steps; in Pros and cons, lead with benefits and frame the rest as gentle "good to know" or "best results when" tips, not drawbacks; in the product sales section, only benefits. Persuasive because it is useful, never bland filler, never hype.

ARTICLE TOPIC: ${item.topic}
TARGET LONG-TAIL SEARCH: "${item.keyword}"
SILO: ${item.silo}
TODAY: ${TODAY}
${productBlock}

HARD RULES
1. Body: 1,300-1,700 words of Markdown. Use ## for sections and ### for subsections. No H1. Open with "## The short answer", then immediately a single 40-60 word paragraph that directly answers the title question in plain English. No preamble, no "in this guide", no throat-clearing. Then continue the article. Include "## Pros and cons" that leads with a strong bold **Pros** list, then a bold **Good to know** or **Best results when** list of constructive usage, care, or fit tips (never a drawback-style **Cons** list). Include "## Who it's ideal for" (or similar positive wording) with a short positive fit note; do not write a "who should skip it" or "it is not for" block. Do NOT write a Sources or FAQ section in the body.
2. Never claim we tested, tried, used, measured, or reviewed anything. Also never state or imply that we did not test or use a product. Do not write phrases such as "we haven't tested", "we have not used", "we did not use", "not hands-on", "this desk has not tested", or "not a test by Daily Insight Desk." No testimonials, quotes from customers, review counts, star ratings, or invented statistics. No medical or health claims. No prices or specs unless given above. Attribute seller claims and other publications clearly.
2b. PRODUCT SALES SECTION: when a product is provided, the "Where X fits" section (or equivalent) and any paragraph that sells the product must be benefits-only and should persuade the reader to look at the offer. Never mention cons, trade-offs, drawbacks, or what the product cannot do in that section.
2c. PROS AND AUDIENCE: do not undercut the product in "## Pros and cons" or the audience section either. Lead with strong benefits. Turn any limitations into gentle, constructive "good to know" / "best results when" tips (usage, care, or fit). Frame the audience as "who it's ideal for," not "who should skip it." Stay honest: no false claims, no medical claims, no fake testimonials, and never say or imply that we did not test or use the product.
3. INTERNAL LINKS: put 3-6 links to DIFFERENT existing articles from the list below INSIDE normal sentences, as Markdown links [descriptive anchor](/path/). Anchors are 2-6 natural words describing the target topic (vary them; never "click here"/"this guide"). Each target at most once. Never inside headings. Only use URLs from this list:
${list}
4. EXTERNAL SOURCES: cite 2-3 real, neutral authority pages (US .gov, .edu extension services, or an official manufacturer care/manual page) that you are confident exist at that exact URL; link each once inside a sentence in the body and list it in "sources". Also add 2 extra backup candidates at the end of "sources" with "inline": false (prefer stable top-level pages like epa.gov, cdc.gov, usda.gov, extension.umn.edu, extension.psu.edu that are certain to exist). Mark the linked ones "inline": true. Never link to stores, Amazon, marketplaces, or blogs/roundups with affiliate links.
5. FAQ: 4-6 real questions people search, answers 2-4 sentences.
5b. STYLE: US spelling (color, not colour). No brand names except the product above. Do not copy the product facts word for word; paraphrase briefly and let the product box carry the details. Only attribute a claim to a source if that page is specifically about it; otherwise state general advice without attribution. Internal links must read naturally: if a target is only loosely related, write a short bridging sentence that gives the reader a real reason to click.
6. Web Story: exactly 7 cards. Card 1 is a cover. The last card invites reading the full guide. Card titles 3-7 words, text max 18 words. For each card give a concrete stock-photo search query (2-4 plain words, a real scene, no brand names, no text) and alt text describing that scene. ${product ? 'Set "kind":"product" on exactly one card about the product itself; other cards "kind":"stock".' : 'All cards "kind":"stock".'}
7. "related": choose the 3 most related existing articles (href from the list) with a one-sentence note on why.
8. Mid-article photo: do not put any image, figure, or HTML in the body (the publisher inserts one photo later). Set "midImageSection" to the exact H2 text of a practical how-to section near the middle (not "The short answer", not pros/cons, not "who it's ideal for" or "who it is for"). Set "midImageQuery" to a 2-4 word stock-photo search for a real scene that illustrates that section (no brand names, no text in the scene). Set "midImageAlt" to one descriptive sentence for that photo that naturally includes the target keyword.

Return ONLY JSON with this shape:
{"title": "question or how-to headline, max 70 chars", "metaTitle": "max 60 chars", "description": "meta description 140-160 chars", "dek": "1-2 sentence standfirst", "slug": "lowercase-hyphen-slug", "readTimeNote": "", "heroQuery": "stock photo search for a wide hero image, 2-4 words", "heroAlt": "alt text for that hero", "midImageSection": "exact H2 text", "midImageQuery": "2-4 word photo search", "midImageAlt": "descriptive alt including the keyword", "body": "markdown", "toc": [{"heading": "exact H2 text", "label": "2-4 word label"}], "faq": [{"q": "", "a": ""}], "sources": [{"name": "Publisher, page title", "url": "https://...", "note": "one sentence on what it supports"}], "related": [{"href": "/path/", "title": "", "note": ""}], "story": [{"id": "short-id", "title": "", "text": "", "imageQuery": "", "alt": "", "kind": "stock"}]}
${feedback ? `\nYOUR PREVIOUS DRAFT FAILED THESE CHECKS. Fix every one:\n- ${feedback.join("\n- ")}\n` : ""}`;
}


function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function midFigureHtml({ src, src800, src1600, alt, width, height, caption, captionHtml, product }) {
  const img = src
    ? `<img src="${src}" alt="${esc(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async">`
    : `<img src="${src800}" srcset="${src800} 800w, ${src1600} 1600w" sizes="(min-width: 1040px) 40rem, calc(100vw - 2.5rem)" alt="${esc(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async">`;
  const photo = product
    ? `<a class="product-photo-link affiliate-link" data-product="${esc(product.name)}" href="${esc(product.href)}" rel="sponsored nofollow noopener" target="_blank">${img}</a>`
    : img;
  return `<figure class="frame mid-figure">\n${photo}\n<figcaption>${captionHtml || esc(caption)}</figcaption>\n</figure>`;
}
function insertMidImage(body, figure, headingHint) {
  const headings = [...body.matchAll(/^## .+$/gm)];
  const skip = /the short answer|who (it|this) is for|who it.?s ideal for|pros and cons|good to know|best results/i;
  const usable = headings.filter((h) => !skip.test(h[0]));
  const pool = usable.length ? usable : headings.slice(1);
  if (!pool.length) {
    const midAt = Math.max(0, Math.floor(body.length / 2));
    const cut = body.indexOf("\n\n", midAt);
    const at = cut === -1 ? midAt : cut;
    return `${body.slice(0, at)}\n\n${figure}\n${body.slice(at)}`;
  }
  let target;
  const hint = String(headingHint || "").trim().toLowerCase();
  if (hint) target = pool.find((h) => h[0].slice(3).trim().toLowerCase() === hint);
  if (!target) {
    const midAt = Math.floor(body.length / 2);
    target = pool.reduce((best, h) => Math.abs(h.index - midAt) < Math.abs(best.index - midAt) ? h : best);
  }
  let at = target.index + target[0].length;
  const rest = body.slice(at);
  const lead = rest.match(/^\n+(?:\{%[\s\S]*?%\}[ \t]*\n+|[^#\n][^\n]*(?:\n(?!## |### |$)[^\n]*)*\n*)/);
  if (lead) at += lead[0].length;
  return `${body.slice(0, at).replace(/\n*$/, "\n\n")}${figure}\n${body.slice(at).replace(/^\n*/, "")}`;
}
function producerMidPath(product) {
  if (!product) return "";
  for (const p of [...(product.storyImages || []), product.image]) {
    if (!p) continue;
    const file = join(SRC, String(p).replace(/^\//, ""));
    if (existsSync(file)) return file;
  }
  return "";
}

// ---------- images ----------
const usedImages = new Set();
const REGISTRY = join(import.meta.dirname, "hero-registry.json");
const HERO_DHASH_MAX = 8; // 64-bit dHash; this close usually means the same photo
const usedHeroes = []; // { slug, file, sha256, dhash, sourceUrl, sourceId, role }

function srcAsset(p, suffix = "") {
  const rel = String(p || "").replace(/^\//, "");
  if (!rel) return "";
  if (suffix) return join(SRC, `${rel}${suffix}`);
  return join(SRC, rel);
}
function pixabayId(url) {
  const m = String(url || "").match(/-(\d+)\/?(?:[?#].*)?$/);
  return m ? m[1] : "";
}
function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
async function dhashHex(buf, size = 8) {
  const { data } = await sharp(buf).rotate().grayscale().resize(size + 1, size, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) bits += data[y * (size + 1) + x] < data[y * (size + 1) + x + 1] ? "1" : "0";
  }
  return BigInt(`0b${bits}`).toString(16).padStart((size * size) / 4, "0");
}
function hammingHex(a, b) {
  if (!a || !b) return 64;
  return (BigInt(`0x${a}`) ^ BigInt(`0x${b}`)).toString(2).replace(/0/g, "").length;
}
function rememberSource(url, id) {
  if (url) usedImages.add(url);
  if (id) usedImages.add(`pixabay:${id}`);
}
function heroLooksUsed(dhash, sha) {
  return usedHeroes.some((h) => (sha && h.sha256 === sha) || hammingHex(h.dhash, dhash) <= HERO_DHASH_MAX);
}
async function bufferLooksUsed(buf) {
  const sha = sha256Buf(buf);
  if (usedHeroes.some((h) => h.sha256 === sha)) return true;
  const dhash = await dhashHex(buf);
  return heroLooksUsed(dhash, sha);
}
function loadHeroRegistry() {
  // Merge the on-disk registry (source URLs/IDs) with a fresh scan of published heroes.
  let stored = [];
  try {
    if (existsSync(REGISTRY)) stored = JSON.parse(readFileSync(REGISTRY, "utf8")).heroes || [];
  } catch (e) { log(`hero registry read failed: ${e.message}`); }
  const byFile = new Map(stored.map((h) => [h.file, h]));
  usedHeroes.length = 0;
  for (const g of guides()) {
    const hero = g.data?.hero;
    if (!hero) continue;
    const file = srcAsset(hero, "-1600.webp");
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    const rel = file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file;
    const prev = byFile.get(rel) || {};
    const slug = g.data.slug || String(g.data.permalink || "").replace(/^\/|\/$/g, "").split("/").pop() || prev.slug || "";
    usedHeroes.push({
      slug,
      file: rel,
      sha256: sha256Buf(buf),
      dhash: "",
      sourceUrl: prev.sourceUrl || "",
      sourceId: prev.sourceId || pixabayId(prev.sourceUrl),
      role: "hero",
    });
    rememberSource(prev.sourceUrl, prev.sourceId || pixabayId(prev.sourceUrl));
  }
  // Keep source URLs for heroes that were replaced (file gone) so we still skip that stock photo.
  for (const h of stored) {
    rememberSource(h.sourceUrl, h.sourceId || pixabayId(h.sourceUrl));
    if (h.role === "hero" && h.file && !usedHeroes.some((x) => x.file === h.file) && h.sourceUrl) {
      /* URL already remembered */
    }
  }
  // Mid-article Pixabay links must not be reused as a later hero either? Mid may reuse? Task: mid must not duplicate a hero. Seed mid source URLs into usedImages too if they appear in bodies.
  for (const g of guides()) {
    for (const m of String(g.raw || "").matchAll(/https:\/\/pixabay\.com\/photos\/[^"'\s)]+/g)) {
      rememberSource(m[0], pixabayId(m[0]));
    }
  }
}
async function fillHeroDhashes() {
  for (const h of usedHeroes) {
    if (h.dhash) continue;
    const abs = h.file.startsWith("/") ? h.file : join(ROOT, h.file);
    if (!existsSync(abs)) continue;
    h.dhash = await dhashHex(readFileSync(abs));
  }
}
function writeHeroRegistry() {
  const payload = {
    _readme: "Hero images already used on the site. The autowriter skips these by source URL/ID and by file or perceptual hash when picking a new hero. Mid-article photos also skip any hero.",
    heroes: usedHeroes.map((h) => ({
      slug: h.slug,
      file: h.file,
      sha256: h.sha256,
      dhash: h.dhash,
      sourceUrl: h.sourceUrl || "",
      sourceId: h.sourceId || "",
      role: h.role || "hero",
    })),
  };
  writeFileSync(REGISTRY, `${JSON.stringify(payload, null, 2)}\n`);
}
async function rememberHero({ slug, file, buf, sourceUrl, sourceId }) {
  const sha = sha256Buf(buf);
  const dhash = await dhashHex(buf);
  const rel = file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file;
  const rec = { slug: slug || "", file: rel, sha256: sha, dhash, sourceUrl: sourceUrl || "", sourceId: sourceId || pixabayId(sourceUrl), role: "hero" };
  const i = usedHeroes.findIndex((h) => h.file === rel || h.slug === rec.slug);
  if (i >= 0) usedHeroes[i] = rec; else usedHeroes.push(rec);
  rememberSource(rec.sourceUrl, rec.sourceId);
  writeHeroRegistry();
  return rec;
}

let openverseBlocked = false;
const JUNK = /poster|painting|drawing|illustration|engraving|lithograph|map\b|specimen|logo|diagram|coat of arms|flag|film|movie|catalog|catalogue|page \d|book|scan|statue|temple|church|cathedral|saint|god|goddess|shrine|buddha|krishna|shiva|ganesh|idol|deity|religio|bible|cross\b|portrait of|stamp|coin|advert|\bad\b|magazine|newspaper/i;

async function pixabaySearch(query, { orientation = "horizontal", perPage = 10 } = {}) {
  if (!PIXABAY || !query) return [];
  const params = new URLSearchParams({
    key: PIXABAY,
    q: query,
    image_type: "photo",
    orientation,
    safesearch: "true",
    per_page: String(perPage),
  });
  const r = await fetch(`https://pixabay.com/api/?${params}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) { log(`pixabay ${r.status}`); return []; }
  const data = await r.json();
  return Array.isArray(data.hits) ? data.hits : [];
}
function scorePixabayHit(hit, query) {
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const tags = String(hit.tags || "").toLowerCase();
  let score = 0;
  for (const t of terms) if (tags.includes(t)) score += 3;
  if ((hit.imageWidth || 0) >= 1200) score += 1;
  score += Math.log10((hit.downloads || 0) + 1) / 10;
  score += Math.log10((hit.likes || 0) + 1) / 20;
  if (JUNK.test(tags)) score -= 5;
  return score;
}
async function downloadPixabayHit(hit) {
  const url = hit.largeImageURL || hit.webformatURL;
  if (!url) return null;
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  const meta = await sharp(buf).metadata();
  if (!meta.width || Math.min(meta.width, meta.height) < 540) return null;
  return { buf, meta, url, pageURL: hit.pageURL, tags: hit.tags, w: hit.imageWidth, h: hit.imageHeight, credit: "Pixabay" };
}
async function pixabayMidImage(query) {
  try {
    const hits = await pixabaySearch(query, { orientation: "horizontal", perPage: 20 });
    const ranked = hits
      .filter((h) => {
        const url = h.largeImageURL || h.webformatURL;
        const id = String(h.id || pixabayId(h.pageURL));
        return url && !usedImages.has(url) && !usedImages.has(h.pageURL) && !usedImages.has(`pixabay:${id}`);
      })
      .sort((a, b) => scorePixabayHit(b, query) - scorePixabayHit(a, query));
    for (const hit of ranked) {
      const got = await downloadPixabayHit(hit);
      if (!got) continue;
      if (await bufferLooksUsed(got.buf)) { log(`pixabay mid skipped, matches an existing hero: ${hit.pageURL || got.url}`); continue; }
      usedImages.add(got.url);
      if (hit.pageURL) usedImages.add(hit.pageURL);
      rememberSource(hit.pageURL, String(hit.id || pixabayId(hit.pageURL)));
      return { ...got, source: "Pixabay", pixabay: true };
    }
    if (!hits.length) log("pixabay: no hits for query");
  } catch (e) { log(`pixabay ${e.message}`); }
  return null;
}
async function jpegUnder(buf, width = 1200, maxBytes = 200 * 1024) {
  let quality = 82;
  let out = await sharp(buf).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
  let w = width;
  while (out.length > maxBytes && quality > 48) {
    quality -= 8;
    out = await sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  while (out.length > maxBytes && w > 800) {
    w -= 100;
    out = await sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 60, mozjpeg: true }).toBuffer();
  }
  return out;
}

async function candidates(query, aspect, n = 4, { skipPixabay = false } = {}) {
  const out = [];
  const qs = [...new Set([query, query.split(" ").slice(0, 2).join(" ")])];
  for (const q of qs) {
    const lists = [];
    if (PIXABAY && !skipPixabay) {
      try {
        const orient = aspect === "tall" ? "vertical" : "horizontal";
        const hits = await pixabaySearch(q, { orientation: orient, perPage: 15 });
        lists.push(hits.map((p) => ({
          url: p.largeImageURL || p.webformatURL,
          w: p.imageWidth,
          h: p.imageHeight,
          title: p.tags || "",
          credit: "Pixabay",
          pageURL: p.pageURL,
          sourceId: String(p.id || ""),
        })).filter((x) => x.url && !usedImages.has(x.url) && !usedImages.has(x.pageURL) && !usedImages.has(`pixabay:${x.sourceId}`)));
      } catch (e) { log(`pixabay ${e.message}`); }
    }
    if (PEXELS) {
      try {
        const orient = aspect === "tall" ? "portrait" : "landscape";
        const u = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=15&orientation=${orient}`;
        const r = await fetch(u, { headers: { Authorization: PEXELS, "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
        if (r.ok) lists.push((await r.json()).photos.map((p) => ({
          url: p.src?.large2x || p.src?.large || p.src?.original,
          w: p.width,
          h: p.height,
          title: `${p.alt || ""} ${p.photographer || ""}`,
          credit: `Photo by ${p.photographer} on Pexels`,
        })).filter((x) => x.url));
        else log(`pexels ${r.status}`);
      } catch (e) { log(`pexels ${e.message}`); }
    }
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
      if (!x.url || usedImages.has(x.url) || usedImages.has(x.pageURL) || (x.sourceId && usedImages.has(`pixabay:${x.sourceId}`)) || out.some((o) => o.url === x.url) || JUNK.test(x.title) || Math.min(x.w || 0, x.h || 0) < 600) continue;
      try {
        const r = await fetch(x.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const meta = await sharp(buf).metadata();
        if (!meta.width || Math.min(meta.width, meta.height) < 540) continue;
        if (await bufferLooksUsed(buf)) continue;
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
    hero: `/assets/images/guide-${a.slug}`, heroHeight: 900, heroAlt: a.heroAlt, heroCaption: heroCredit.startsWith("Daily Insight Desk") ? "Illustration by Daily Insight Desk." : `Stock photo: ${heroCredit}`,
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
  const midProducerFile = producerMidPath(product);
  const midQuery = a.midImageQuery || a.heroQuery;
  let midPixabay = null;
  if (!midProducerFile) midPixabay = await pixabayMidImage(midQuery);
  const slots = [{ key: "hero", want: a.heroAlt || a.heroQuery, cands: await candidates(a.heroQuery, "wide") }];
  for (const c of slots[0].cands) usedImages.add(c.url);
  for (const [i, card] of a.story.entries()) {
    if (card.kind === "product" && productImgs.length) continue;
    const cands = await candidates(card.imageQuery || a.heroQuery, "tall", 3);
    for (const c of cands) usedImages.add(c.url);
    slots.push({ key: `card${i + 1}`, want: card.alt || card.imageQuery, cands });
  }
  if (!midProducerFile && !midPixabay) {
    const midCands = await candidates(midQuery, "wide", 4, { skipPixabay: true });
    for (const c of midCands) usedImages.add(c.url);
    slots.push({ key: "mid", want: a.midImageAlt || midQuery, cands: midCands });
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
    .map((b) => srcAsset(b, "-1600.webp")).filter((f, i, arr) => arr.indexOf(f) === i && existsSync(f));
  const unusedFallbacks = [];
  for (const f of fallbacks) {
    if (!(await bufferLooksUsed(readFileSync(f)))) unusedFallbacks.push(f);
  }
  let hero = chosen.hero && !(await bufferLooksUsed(chosen.hero.buf)) ? chosen.hero : null;
  if (!hero && unusedFallbacks.length) {
    hero = { buf: readFileSync(unusedFallbacks.shift()), credit: "Daily Insight Desk illustration", house: true };
  }
  if (!hero) throw new Error("no unused hero image available (stock and site illustrations already used)");
  for (const w of [1600, 800]) {
    await sharp(hero.buf).rotate().resize(w, Math.round((w * 9) / 16), { fit: "cover", position: "attention" }).webp({ quality: 72 }).toFile(join(imgDir, `guide-${a.slug}-${w}.webp`));
  }
  await rememberHero({
    slug: a.slug,
    file: join(imgDir, `guide-${a.slug}-1600.webp`),
    buf: readFileSync(join(imgDir, `guide-${a.slug}-1600.webp`)),
    sourceUrl: hero.pageURL || "",
    sourceId: hero.sourceId || pixabayId(hero.pageURL),
  });
  const imageReport = [`hero: ${hero.house ? "site illustration (no fitting stock photo)" : "stock photo"}`];
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
  const wc = words(a.body);
  let mid = null;
  if (midProducerFile) {
    mid = { buf: readFileSync(midProducerFile), credit: product.caption || "Seller photo.", product, source: "producer photo" };
  } else if (midPixabay) {
    mid = midPixabay;
  } else if (chosen.mid) {
    mid = { ...chosen.mid, source: "stock photo" };
  } else if (fallbacks.length) {
    mid = unusedFallbacks.length
      ? { buf: readFileSync(unusedFallbacks.shift()), credit: "Daily Insight Desk illustration", house: true, source: "site illustration (no fitting stock photo)" }
      : null;
  }
  if (mid && await bufferLooksUsed(mid.buf)) {
    log(`mid image skipped, matches an existing hero`);
    mid = null;
  }
  if (mid) {
    const alt = a.midImageAlt || (mid.product && product.alt) || a.heroAlt || "Photograph illustrating this guide";
    if (mid.pixabay) {
      const dir = join(imgDir, "articles");
      mkdirSync(dir, { recursive: true });
      const jpg = await jpegUnder(mid.buf);
      writeFileSync(join(dir, `${a.slug}.jpg`), jpg);
      const meta = await sharp(jpg).metadata();
      const page = mid.pageURL || "https://pixabay.com/";
      a.body = insertMidImage(a.body, midFigureHtml({
        src: `/assets/images/articles/${a.slug}.jpg`,
        alt,
        width: meta.width,
        height: meta.height,
        captionHtml: `Photo: <a href="${esc(page)}" rel="nofollow noopener" target="_blank">Pixabay</a>`,
      }), a.midImageSection);
      imageReport.push(`mid-article: Pixabay (${page})`);
    } else {
      const midBase = `guide-${a.slug}-mid`;
      const midH = Math.round((1600 * 9) / 16);
      const fit = mid.product || mid.house ? "contain" : "cover";
      for (const w of [1600, 800]) {
        await sharp(mid.buf).rotate().resize(w, Math.round((w * 9) / 16), {
          fit,
          position: "attention",
          background: { r: 247, g: 243, b: 234, alpha: 1 },
        }).webp({ quality: 72 }).toFile(join(imgDir, `${midBase}-${w}.webp`));
      }
      const caption = mid.product
        ? (product.caption || "Seller photo.")
        : (mid.house || String(mid.credit || "").startsWith("Daily Insight Desk"))
          ? "Illustration by Daily Insight Desk."
          : `Stock photo: ${mid.credit}`;
      a.body = insertMidImage(a.body, midFigureHtml({
        src800: `/assets/images/${midBase}-800.webp`,
        src1600: `/assets/images/${midBase}-1600.webp`,
        alt,
        width: 1600,
        height: midH,
        caption,
        product: mid.product || null,
      }), a.midImageSection);
      imageReport.push(`mid-article: ${mid.source}`);
    }
  }
  a._imageReport = imageReport;
  if (hero.house) a.heroAlt = silo?.alt || "Illustration of home and garden tools";
  await sharp(join(imgDir, "stories", a.slug, "p1.webp")).toFile(join(imgDir, "stories", `${a.slug}.webp`));
  // body + sources section
  const sourcesNote = item.product ? "\n\nProduct details come from the seller's page and can change.\n" : "\n";
  const sourcesMd = `## Sources\n\n${a.sources.map((s) => `- [${s.name}](${s.url}). ${s.note}`).join("\n")}${sourcesNote}`;
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
    const paras = g.body.split("\n").map((t, i) => ({ i, t })).filter((p) => p.t.length > 120 && !/^(#|-|\*|\{%|\||>|\d+\.|<)/.test(p.t) && (p.t.match(/\]\(/g) || []).length < 2);
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
if (TEST_PIXABAY) {
  const query = process.argv.slice(3).join(" ").trim() || "garden hose";
  if (!PIXABAY) { console.error("PIXABAY_API_KEY is missing"); process.exit(1); }
  log(`pixabay dry run, query: ${query}`);
  const hit = await pixabayMidImage(query);
  if (!hit) { console.error("No Pixabay photo found"); process.exit(1); }
  const tmp = mkdtempSync(join(tmpdir(), "pixabay-test-"));
  const jpg = await jpegUnder(hit.buf);
  const dest = join(tmp, "sample.jpg");
  writeFileSync(dest, jpg);
  const meta = await sharp(jpg).metadata();
  console.log(JSON.stringify({
    query,
    pageURL: hit.pageURL,
    tags: hit.tags,
    sourceWidth: hit.w,
    sourceHeight: hit.h,
    output: dest,
    outputWidth: meta.width,
    outputHeight: meta.height,
    bytes: jpg.length,
  }, null, 2));
  process.exit(0);
}

loadHeroRegistry();
await fillHeroDhashes();
writeHeroRegistry();
const queue = JSON.parse(readFileSync(QUEUE, "utf8"));
const results = [];
let made = 0;
for (const item of queue.items) {
  if (made >= COUNT) break;
  if (item.status !== "todo") continue;
  if ((process.env.SKIP_IDS || "").split(",").includes(item.id)) { log(`skip ${item.id}: already drafted in an open PR`); continue; }
  if (item.demand?.level === "none") { log(`skip ${item.id}: no search demand and no usable on-topic variant`); continue; }
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
      sh(`git add -A src scripts/autowriter/queue.json scripts/autowriter/hero-registry.json && git commit -q -m ${JSON.stringify(`Autowriter: ${r.a.title}`)}`);
      results.push({ ...r, backs, model: r.a._model, sources: r.a.sources.length, images: r.a._imageReport });
      made++; ok = true;
      log(`done ${r.url} (${r.wc} words, ${r.internal} internal links, ${backs.length} backlinks)`);
    } catch (e) {
      log(`attempt ${attempt + 1} failed for ${item.id}: ${e.message}${e.buildLog ? `\n${e.buildLog}` : ""}`);
      attemptNote = e.buildLog || e.message;
      sh("git checkout -q -- src scripts/autowriter/queue.json scripts/autowriter/hero-registry.json && git clean -fdq src");
      usedImages.clear();
      loadHeroRegistry();
      await fillHeroDhashes();
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
