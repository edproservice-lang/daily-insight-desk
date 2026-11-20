import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import amphtmlValidator from "amphtml-validator";
import site from "../src/_data/site.js";
import indexnow from "../src/_data/indexnow.js";

const root = join(import.meta.dirname, "..", "_site");
const errors = [];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function fail(message) {
  errors.push(message);
}

const files = walk(root);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const pages = new Map();

for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const rel = file.slice(root.length);
  const urlPath = rel.endsWith("/index.html")
    ? rel.slice(0, -"index.html".length) || "/"
    : rel;
  pages.set(urlPath, html);

  if (!html.includes("G-QM23XL6N04")) fail(`${urlPath} is missing the Analytics tag`);
  if (!/<title>[^<]+<\/title>/.test(html)) fail(`${urlPath} is missing a title`);
  if (!/name="description" content="[^"]+"/.test(html)) fail(`${urlPath} is missing a meta description`);
  const canonical = html.match(/rel="canonical" href="([^"]+)"/);
  if (!canonical) fail(`${urlPath} is missing a canonical`);
  else if (!canonical[1].startsWith("https://dailyinsightdesk.com")) {
    fail(`${urlPath} canonical is not on https://dailyinsightdesk.com`);
  } else if (!html.includes('name="robots" content="noindex"')) {
    const expected = `https://dailyinsightdesk.com${urlPath}`;
    if (canonical[1] !== expected) fail(`${urlPath} canonical is ${canonical[1]}, expected ${expected}`);
  }
  if (!html.includes('property="og:title"')) fail(`${urlPath} is missing Open Graph title`);
  if (!html.includes('property="og:description"')) fail(`${urlPath} is missing Open Graph description`);
  if (!html.includes('property="og:url"')) fail(`${urlPath} is missing Open Graph URL`);
  if ((html.match(/<h1[\s>]/g) || []).length !== 1) fail(`${urlPath} should have exactly one h1`);
  if (/faceless|jvz4\.com|jvzoo/i.test(html)) fail(`${urlPath} still mentions Faceless Forge or JVZoo`);
  if (/<form[\s>]/i.test(html)) fail(`${urlPath} has a form; the newsletter must not pretend to collect email`);

  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      JSON.parse(block[1]);
    } catch (error) {
      fail(`${urlPath} has invalid JSON-LD: ${error.message}`);
    }
  }

  const soon = html.match(/<ul class="soon-list">([\s\S]*?)<\/ul>/);
  if (soon && /<a[\s>]/i.test(soon[1])) fail(`${urlPath} links a coming-soon title`);
}

const jetterix = "https://www.clickrtrckr.com/J2D6CNH/7L95GK9/?uid=12402";
const katori = "https://www.clickrtrckr.com/J2D6CNH/546X6MD/?uid=7536&amp;home";
const cleaning = pages.get("/cleaning/garden-hose-pressure-nozzle/");
const kitchen = pages.get("/kitchen/do-titanium-cutting-boards-dull-knives/");
if (!cleaning) fail("Missing the cleaning article");
if (!kitchen) fail("Missing the kitchen article");
if (cleaning && !cleaning.includes(`href="${jetterix}"`)) fail("Jetterix affiliate link changed");
if (kitchen && !kitchen.includes(`href="${katori}"`)) fail("Katori affiliate link changed");
if (cleaning && !cleaning.includes('rel="sponsored nofollow noopener"')) fail("Cleaning article affiliate rel is wrong");
if (kitchen && !kitchen.includes('rel="sponsored nofollow noopener"')) fail("Kitchen article affiliate rel is wrong");
if (kitchen && !kitchen.includes("Serious Eats")) fail("Kitchen article does not cite Serious Eats");
if (kitchen && !/wood or plastic/i.test(kitchen)) fail("Kitchen article does not recommend wood or plastic");

const sharpener = pages.get("/kitchen/are-rolling-knife-sharpeners-good/");
const steamer = pages.get("/cleaning/garment-steamer-vs-iron/");
const katusharp = "https://www.clickomundo.com/J2D6CNH/B7R6P93/";
const rowelle = "https://www.clickomundo.com/J2D6CNH/B8GM3KK/";
if (!sharpener) fail("Missing the rolling sharpener article");
if (!steamer) fail("Missing the garment steamer article");
if (sharpener && !sharpener.includes(`href="${katusharp}"`)) fail("KatuSharp affiliate link changed");
if (steamer && !steamer.includes(`href="${rowelle}"`)) fail("Rowelle affiliate link changed");
if (sharpener && !sharpener.includes("/kitchen/do-titanium-cutting-boards-dull-knives/")) {
  fail("Sharpener guide does not link to the cutting-board guide");
}
if (steamer && !steamer.includes("/cleaning/garden-hose-pressure-nozzle/")) {
  fail("Steamer guide does not link to the nozzle guide");
}
const windobotz = "https://www.treejammer.com/J2D6CNH/B98T7C9/";
const aircooler = "https://www.tricklyn.com/J2D6CNH/T82ZTW/";
const nuroclean = "https://www.clickomundo.com/J2D6CNH/52B5LNB/";
const windows = pages.get("/cleaning/are-window-cleaning-robots-worth-it/");
const cooler = pages.get("/outdoor/do-portable-evaporative-coolers-work/");
const tablets = pages.get("/cleaning/do-cleaning-tablets-replace-spray-bottles/");
if (!windows) fail("Missing the window-robot article");
if (!cooler) fail("Missing the evaporative-cooler article");
if (!tablets) fail("Missing the cleaning-tablet article");
if (windows && !windows.includes(`href="${windobotz}"`)) fail("Windobotz affiliate link changed");
if (cooler && !cooler.includes(`href="${aircooler}"`)) fail("HomePro AirCooler affiliate link changed");
if (tablets && !tablets.includes(`href="${nuroclean}"`)) fail("NuroClean affiliate link changed");
for (const [urlPath, html] of pages) {
  if (/\[Author name\]|\[Short bio|\[fanpage|\[Instagram URL\]/i.test(html)) {
    fail(`${urlPath} still shows an author placeholder`);
  }
}

for (const [urlPath, html] of pages) {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  for (const href of hrefs) {
    if (href.startsWith("mailto:") || href.startsWith("https://") || href.startsWith("http://")) continue;
    if (href.startsWith("#")) {
      const id = href.slice(1);
      if (!html.includes(`id="${id}"`)) fail(`${urlPath} links to missing #${id}`);
      continue;
    }
    const [path, hash] = href.split("#");
    const normalized = path.endsWith("/") || path.includes(".") ? path : `${path}/`;
    const relative = normalized.replace(/^\/+/, "");
    const target = relative.endsWith(".html") || relative.split("/").pop()?.includes(".")
      ? join(root, relative)
      : join(root, relative, "index.html");
    const exists = files.includes(target) || pages.has(normalized);
    if (!exists) fail(`${urlPath} links to missing ${href}`);
    if (hash) {
      const targetHtml = pages.get(normalized);
      if (targetHtml && !targetHtml.includes(`id="${hash}"`)) {
        fail(`${urlPath} links to ${href}, but #${hash} is missing`);
      }
    }
  }
}

const bannedHost = [
  /(^|\.)amazon\./,
  /^amzn\.to$/,
  /(^|\.)walmart\./,
  /(^|\.)ebay\./,
  /(^|\.)target\.com$/,
  /(^|\.)bestbuy\./,
  /(^|\.)clickbank\./,
  /(^|\.)shareasale\./,
  /(^|\.)homedepot\./,
  /(^|\.)lowes\./,
  /(^|\.)wayfair\./,
  /(^|\.)etsy\./,
  /(^|\.)aliexpress\./,
  /(^|\.)newegg\./,
  /(^|\.)costco\./,
  /(^|\.)overstock\./,
  /(^|\.)rakuten\./,
  /(^|\.)awin1\.com$/,
  /(^|\.)awin\.com$/,
  /(^|\.)impact\.com$/,
  /(^|\.)cj\.com$/,
  /(^|\.)avantlink\./,
  /(^|\.)skimresources\./,
  /(^|\.)rstyle\.me$/,
  /(^|\.)shopstyle\./,
  /(^|\.)anrdoezrs\.net$/,
  /(^|\.)dpbolvw\.net$/,
  /(^|\.)jdoqocy\.com$/,
  /(^|\.)tkqlhce\.com$/,
  /(^|\.)kqzyfj\.com$/,
  /(^|\.)qksrv\.net$/,
  /(^|\.)emjcd\.com$/,
  /(^|\.)pjtra\.com$/,
  /(^|\.)pntra\.com$/,
  /(^|\.)pntrs\.com$/,
  /(^|\.)linksynergy\./,
  /(^|\.)flexlinks\./,
];

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? match[1] : "";
}

function relHas(rel, token) {
  return rel.toLowerCase().split(/\s+/).includes(token);
}

for (const [urlPath, html] of pages) {
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    const href = attr(tag, "href").replace(/&amp;/g, "&");
    if (!/^https?:\/\//i.test(href)) continue;
    let host = "";
    try {
      host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      fail(`${urlPath} has an unreadable external link: ${href}`);
      continue;
    }
    const rel = attr(tag, "rel");
    const tracking = ["clickrtrckr.com", "clickomundo.com", "treejammer.com", "tricklyn.com"].includes(host);
    const ownSite = host === "dailyinsightdesk.com";
    const authority = host.endsWith(".gov") || host.endsWith(".mil") || host.endsWith(".edu") || host.endsWith(".gov.uk") || host.endsWith(".ac.uk");
    if (!tracking && bannedHost.some((pattern) => pattern.test(host))) {
      fail(`${urlPath} links to a retail or affiliate domain: ${host}`);
    }
    if (tracking) {
      for (const token of ["sponsored", "nofollow", "noopener"]) {
        if (!relHas(rel, token)) fail(`${urlPath} affiliate link to ${host} is missing rel=${token}`);
      }
    } else if (ownSite) {
      if (relHas(rel, "nofollow")) fail(`${urlPath} nofollows our own site`);
    } else if (authority) {
      if (relHas(rel, "nofollow") || relHas(rel, "sponsored")) {
        fail(`${urlPath} nofollows an authority source: ${host}`);
      }
      if (attr(tag, "target") === "_blank" && !relHas(rel, "noopener")) {
        fail(`${urlPath} authority link to ${host} is missing rel=noopener`);
      }
    } else {
      for (const token of ["nofollow", "noopener"]) {
        if (!relHas(rel, token)) fail(`${urlPath} external link to ${host} is missing rel=${token}`);
      }
      if (relHas(rel, "sponsored")) fail(`${urlPath} marks a non-affiliate link as sponsored: ${host}`);
    }
  }

  const photos = [...html.matchAll(/<img\b[^>]*\bclass="[^"]*\bproduct-photo\b[^"]*"[^>]*>/gi)];
  for (const photo of photos) {
    const img = photo[0];
    const before = html.slice(Math.max(0, photo.index - 500), photo.index);
    const open = before.match(/<a\b[^>]*class="[^"]*\bproduct-photo-link\b[^"]*"[^>]*>\s*$/i);
    if (!open) {
      fail(`${urlPath} has a product image that is not an affiliate link`);
      continue;
    }
    const rel = attr(open[0], "rel");
    const href = attr(open[0], "href").replace(/&amp;/g, "&");
    let host = "";
    try {
      host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      host = "";
    }
    if (!["clickrtrckr.com", "clickomundo.com", "treejammer.com", "tricklyn.com"].includes(host)) {
      fail(`${urlPath} product image links to ${host || href}, not an allowed affiliate host`);
    }
    for (const token of ["sponsored", "nofollow"]) {
      if (!relHas(rel, token)) fail(`${urlPath} product image link is missing rel=${token}`);
    }
    if (!relHas(rel, "noopener")) fail(`${urlPath} product image link is missing rel=noopener`);
    if (attr(open[0], "target") !== "_blank") fail(`${urlPath} product image link is missing target=_blank`);
    const alt = attr(img, "alt");
    if (!alt || alt.length < 8) fail(`${urlPath} product image is missing a descriptive alt`);
  }
}

const robots = readFileSync(join(root, "robots.txt"), "utf8");
if (!robots.includes("Sitemap: https://dailyinsightdesk.com/sitemap.xml")) {
  fail("robots.txt does not point at the sitemap");
}
for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Google-Extended", "Bingbot"]) {
  const block = new RegExp(`User-agent:\\s*${bot}\\s*\\nAllow:\\s*/`, "i");
  if (!block.test(robots)) fail(`robots.txt does not explicitly allow ${bot}`);
}

if (site.googleSiteVerification) {
  const home = pages.get("/");
  const tag = `name="google-site-verification" content="${site.googleSiteVerification}"`;
  if (!home?.includes(tag)) fail("home page is missing the Google site verification tag");
}

const indexNowKeyFile = join(root, `${indexnow.key}.txt`);
if (!statSync(indexNowKeyFile, { throwIfNoEntry: false })) {
  fail(`IndexNow key file /${indexnow.key}.txt is missing`);
} else if (readFileSync(indexNowKeyFile, "utf8").trim() !== indexnow.key) {
  fail("IndexNow key file does not contain the key");
}

const llmsPath = join(root, "llms.txt");
if (!statSync(llmsPath, { throwIfNoEntry: false })) {
  fail("llms.txt is missing");
} else {
  const llms = readFileSync(llmsPath, "utf8");
  if (!llms.startsWith("# Daily Insight Desk")) fail("llms.txt must start with the site name");
  for (const [urlPath] of pages) {
    if (!/^\/(cleaning|kitchen|outdoor|tools)\/.+/.test(urlPath)) continue;
    if (!llms.includes(`https://dailyinsightdesk.com${urlPath}`)) {
      fail(`llms.txt is missing ${urlPath}`);
    }
  }
}

for (const [urlPath, html] of pages) {
  if (!/^\/(cleaning|kitchen|outdoor|tools)\/.+/.test(urlPath)) continue;
  let article;
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(block[1]);
      const nodes = data["@graph"] || [data];
      article = nodes.find((node) => node["@type"] === "Article") || article;
    } catch {
      // invalid JSON-LD is already reported above
    }
  }
  if (!article) fail(`${urlPath} is missing Article JSON-LD`);
  else {
    for (const field of ["datePublished", "dateModified", "author", "publisher"]) {
      if (!article[field]) fail(`${urlPath} Article schema is missing ${field}`);
    }
  }
}

const sitemap = readFileSync(join(root, "sitemap.xml"), "utf8");
if (!sitemap.includes("<urlset")) fail("sitemap.xml is not a urlset");
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const locSet = new Set(locs);
if (new Set(locs).size !== locs.length) fail("sitemap contains duplicate URLs");
for (const loc of locs) {
  if (!loc.startsWith("https://dailyinsightdesk.com/")) fail(`Sitemap URL is off-host: ${loc}`);
  const path = loc.replace("https://dailyinsightdesk.com", "") || "/";
  if (!pages.has(path)) fail(`Sitemap lists ${loc}, which is not a built page`);
  if (pages.get(path)?.includes('name="robots" content="noindex"')) fail(`Sitemap lists noindex page ${loc}`);
}
for (const [urlPath, html] of pages) {
  if (urlPath.endsWith(".html")) continue;
  if (html.includes('name="robots" content="noindex"')) continue;
  const loc = `https://dailyinsightdesk.com${urlPath}`;
  if (!locSet.has(loc)) fail(`Page missing from sitemap: ${loc}`);
}
if (sitemap.includes("404")) fail("sitemap includes the 404 page");

function webpSize(buffer) {
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8X") {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (format === "VP8 ") {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

const storyDir = join(root, "assets", "images", "stories");
if (!statSync(storyDir, { throwIfNoEntry: false })?.isDirectory()) {
  fail("Story poster directory is missing");
} else {
  for (const name of readdirSync(storyDir).filter((file) => file.endsWith(".webp"))) {
    const size = webpSize(readFileSync(join(storyDir, name)));
    if (!size || size.width < 640 || size.height < 853) {
      fail(`Story poster ${name} must be at least 640 by 853 pixels`);
    }
  }
}

const AFFILIATE_NOTE = "We may earn a commission if you buy through our links, at no extra cost to you.";
const AFFILIATE_HOST_RE = /https?:\/\/(?:www\.)?(?:clickrtrckr|clickomundo|treejammer|tricklyn)\.com/i;
for (const [urlPath, html] of pages) {
  if (urlPath.startsWith("/stories/")) continue;
  const firstOffer = html.search(AFFILIATE_HOST_RE);
  if (firstOffer === -1) continue;
  if (!html.includes(AFFILIATE_NOTE)) {
    fail(`${urlPath} is missing the in-article affiliate commission note`);
    continue;
  }
  const noteAt = html.indexOf(AFFILIATE_NOTE);
  if (noteAt > firstOffer) fail(`${urlPath} places the affiliate commission note after the first offer link`);
  if (html.includes("We have not hands-on tested the products mentioned")) {
    fail(`${urlPath} still has the old top-of-article affiliate disclosure`);
  }
}

for (const [urlPath, html] of pages) {
  if (!urlPath.startsWith("/stories/") || urlPath === "/stories/") continue;
  if (/clickrtrckr\.com|clickomundo\.com|treejammer\.com|tricklyn\.com/i.test(html)) {
    fail(`${urlPath} contains an affiliate link`);
  }
  if (!html.includes('poster-portrait-src="') || !html.includes('publisher-logo-src="') || !html.includes("<amp-story")) {
    fail(`${urlPath} is missing required Web Story metadata`);
  }
  const storyPages = [...html.matchAll(/<amp-story-page id="([^"]+)"[\s\S]*?<\/amp-story-page>/gi)];
  if (!storyPages.length) fail(`${urlPath} has no story pages`);
  for (const page of storyPages) {
    if (!/<amp-img\b/i.test(page[0])) fail(`${urlPath} story page ${page[1]} has no image`);
  }
}

const ampValidator = await amphtmlValidator.getInstance();
for (const [urlPath, html] of pages) {
  if (!html.includes("<html amp")) continue;
  const result = ampValidator.validateString(html);
  if (result.status !== "PASS") {
    const details = result.errors
      .filter((error) => error.severity === "ERROR")
      .map((error) => `line ${error.line}: ${error.message}`)
      .join("; ");
    fail(`${urlPath} failed AMP validation (${result.status}): ${details}`);
  }
}

if (errors.length) {
  console.error(`Site check failed with ${errors.length} problem(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Site check passed (${pages.size} HTML pages, ${locs.length} sitemap URLs).`);
