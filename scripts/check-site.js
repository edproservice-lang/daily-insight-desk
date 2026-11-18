import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

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

const robots = readFileSync(join(root, "robots.txt"), "utf8");
if (!robots.includes("Sitemap: https://dailyinsightdesk.com/sitemap.xml")) {
  fail("robots.txt does not point at the sitemap");
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

if (errors.length) {
  console.error(`Site check failed with ${errors.length} problem(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Site check passed (${pages.size} HTML pages, ${locs.length} sitemap URLs).`);
