import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import indexnow from "../src/_data/indexnow.js";
import site from "../src/_data/site.js";

const KEY = indexnow.key;
const HOST = new URL(site.url).hostname;
const KEY_URL = `${site.url}/${KEY}.txt`;
const LLMS_URL = `${site.url}/llms.txt`;
const SITEMAP_URL = `${site.url}/sitemap.xml`;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const ROOT = join(import.meta.dirname, "..");

function parseArgs(argv) {
  const args = { wait: false, timeoutSec: 300, urls: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--after-deploy") args.wait = true;
    else if (arg === "--timeout") args.timeoutSec = Number(argv[++i]);
    else if (arg === "--url") args.urls.push(argv[++i]);
    else if (!arg.startsWith("-")) args.urls.push(arg);
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function changedFiles() {
  try {
    execSync("git rev-parse HEAD~1", { cwd: ROOT, stdio: "ignore" });
  } catch {
    return [];
  }
  const out = execSync("git diff --name-only --diff-filter=ACMR HEAD~1 HEAD", {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function fileToUrl(file) {
  if (file === "src/llms.njk") return LLMS_URL;
  if (file === "src/indexnow-key.njk" || file === "src/_data/indexnow.js") return KEY_URL;
  if (file === "src/sitemap.njk") return SITEMAP_URL;
  if (file === "src/robots.njk") return `${site.url}/robots.txt`;
  if (!file.startsWith("src/") || file.includes("/_") || !/\.(md|njk)$/.test(file)) return null;
  if (existsSync(join(ROOT, file))) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const match = text.match(/^permalink:\s*["']?([^\n"'{]+)/m);
    if (match) {
      const path = match[1].trim();
      if (path.startsWith("/")) return `${site.url}${path}`;
    }
  }
  const rel = file.replace(/^src\//, "").replace(/\.(md|njk)$/, "");
  if (rel === "index") return `${site.url}/`;
  return `${site.url}/${rel}/`;
}

async function fetchSitemapUrls() {
  const response = await fetch(SITEMAP_URL, { headers: { "Cache-Control": "no-cache" } });
  if (!response.ok) throw new Error(`Could not fetch sitemap (${response.status})`);
  const xml = await response.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
}

async function waitForUrl(url, { timeoutMs, contains } = {}) {
  const started = Date.now();
  let last = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      });
      last = response.status;
      if (response.status === 200) {
        const text = await response.text();
        if (!contains || text.includes(contains)) {
          console.log(`Live check ${url} → 200`);
          return 200;
        }
        console.log(`Live check ${url} → 200, waiting for content to update`);
      } else {
        console.log(`Live check ${url} → ${response.status}`);
      }
    } catch (error) {
      console.log(`Live check ${url} → ${error.message}`);
    }
    await sleep(10000);
  }
  throw new Error(`Timed out waiting for ${url} (last status ${last || "none"})`);
}

async function submit(urlList) {
  const unique = [...new Set(urlList)].filter(Boolean);
  if (!unique.length) throw new Error("No URLs to submit to IndexNow");
  const body = {
    host: HOST,
    key: KEY,
    keyLocation: KEY_URL,
    urlList: unique,
  };
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  console.log(`IndexNow submitted ${unique.length} URL(s) → HTTP ${response.status}`);
  if (text) console.log(text);
  if (![200, 202].includes(response.status)) {
    process.exitCode = 1;
  }
  return response.status;
}

const args = parseArgs(process.argv);
const changed = changedFiles();
const changedUrls = changed.map(fileToUrl).filter(Boolean);
const waitUrls = [
  { url: KEY_URL, contains: KEY },
  { url: LLMS_URL, contains: "# Daily Insight Desk" },
];
for (const url of changedUrls) {
  if (url.endsWith(".txt") || url.endsWith(".xml")) continue;
  if (!waitUrls.some((item) => item.url === url)) waitUrls.push({ url });
}

if (args.wait) {
  const timeoutMs = args.timeoutSec * 1000;
  for (const item of waitUrls) {
    await waitForUrl(item.url, { timeoutMs, contains: item.contains });
  }
}

const urls = args.urls.length ? args.urls : await fetchSitemapUrls();
await submit(urls);
