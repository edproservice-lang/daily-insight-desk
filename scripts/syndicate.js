#!/usr/bin/env node
/**
 * Syndicate new items from https://dailyinsightdesk.com/feed.xml to Tumblr
 * (photo posts), Bluesky (text post + external embed card), Instapaper
 * (Simple API bookmark), and a public Google Doc (append title, summary, link).
 *
 * Each destination is skipped with a warning — not a failure — when its
 * secrets are missing. A failure on one platform does not block the others.
 * Diigo is a disabled hook (its API keys are premium-only).
 *
 * Secrets:
 *   TUMBLR_CONSUMER_KEY, TUMBLR_CONSUMER_SECRET, TUMBLR_TOKEN, TUMBLR_TOKEN_SECRET
 *   BSKY_HANDLE, BSKY_APP_PASSWORD (Bluesky app password, not the account password)
 *   INSTAPAPER_USERNAME, INSTAPAPER_PASSWORD (Instapaper account login)
 *   GOOGLE_SA_JSON (raw service-account JSON) or GOOGLE_SA_JSON_FILE (path)
 *
 * Usage:
 *   node scripts/syndicate.js
 *   node scripts/syndicate.js --dry-run
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const FEED_URL = process.env.FEED_URL || "https://dailyinsightdesk.com/feed.xml";
const TUMBLR_BLOG = process.env.TUMBLR_BLOG || "dailyinsightdesk.tumblr.com";
const GOOGLE_DOC_ID =
  process.env.GOOGLE_DOC_ID || "1vtwoqbey3vkbpaHhMqteDq7p7if_yjSCbi_TRik2wq8";
const STATE_PATH = path.resolve(
  REPO_ROOT,
  process.env.STATE_PATH || "syndication/state.json"
);
const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const DRY_RUN =
  process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

class SkipDestination extends Error {
  constructor(destination, reason) {
    super(reason);
    this.destination = destination;
    this.reason = reason;
  }
}

function log(dest, message) {
  console.log(`${dest}: ${message}`);
}

function warn(dest, message) {
  console.warn(`${dest}: ${message}`);
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
}

function stripHtml(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function innerTag(block, tag) {
  const cdata = block.match(
    new RegExp(`<${tag}\\b[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i")
  );
  if (cdata) return cdata[1];
  const plain = block.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i")
  );
  return plain ? plain[1] : "";
}

function attrValue(block, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]+)"[^>]*/?>`, "i");
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : "";
}

function parseFeed(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xml))) {
    const block = match[1];
    const title = stripHtml(innerTag(block, "title"));
    const link = stripHtml(innerTag(block, "link"));
    const guid = stripHtml(innerTag(block, "guid")) || link;
    const description = innerTag(block, "description");
    const image =
      attrValue(block, "media:content", "url") ||
      attrValue(block, "enclosure", "url") ||
      (description.match(/<img\b[^>]*\bsrc="([^"]+)"/i) || [])[1] ||
      "";
    const paragraph = description.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const summary = stripHtml(paragraph ? paragraph[1] : description);
    if (guid && title && link) {
      items.push({ title, link, guid, summary, image: decodeEntities(image) });
    }
  }
  return items;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { tumblr: [], docs: [], bluesky: [], instapaper: [], diigo: [] };
  }
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  for (const key of ["tumblr", "docs", "bluesky", "instapaper", "diigo"]) {
    if (!Array.isArray(raw[key])) raw[key] = [];
  }
  return raw;
}

function saveState(state) {
  state.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function tumblrCreds() {
  const consumerKey = (process.env.TUMBLR_CONSUMER_KEY || "").trim();
  const consumerSecret = (process.env.TUMBLR_CONSUMER_SECRET || "").trim();
  const token = (process.env.TUMBLR_TOKEN || "").trim();
  const tokenSecret = (process.env.TUMBLR_TOKEN_SECRET || "").trim();
  if (!consumerKey || !consumerSecret || !token || !tokenSecret) {
    throw new SkipDestination(
      "tumblr",
      "skipped (TUMBLR_CONSUMER_KEY, TUMBLR_CONSUMER_SECRET, TUMBLR_TOKEN, TUMBLR_TOKEN_SECRET not all set)"
    );
  }
  return { consumerKey, consumerSecret, token, tokenSecret };
}

function loadServiceAccount() {
  const file = (process.env.GOOGLE_SA_JSON_FILE || "").trim();
  const raw = process.env.GOOGLE_SA_JSON;
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw && raw.trim()) {
    const text = raw.trim();
    try {
      return JSON.parse(text);
    } catch {
      return JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    }
  }
  throw new SkipDestination(
    "docs",
    "skipped (GOOGLE_SA_JSON or GOOGLE_SA_JSON_FILE not set)"
  );
}

function tagsFor(item) {
  const pathPart = new URL(item.link).pathname.split("/").filter(Boolean)[0];
  const common = ["home tips", "DIY home", "home and garden", "daily insight desk"];
  const bySilo = {
    kitchen: ["kitchen tips", "cooking"],
    cleaning: ["cleaning tips"],
    outdoor: ["garden tips", "outdoor living"],
    tools: ["garden tips"],
  };
  return [...(bySilo[pathPart] || []), ...common];
}

function tumblrCaption(item) {
  const summary = item.summary || "";
  const body = summary
    ? `${item.title} - ${summary} Read the full guide: `
    : `${item.title}. Read the full guide: `;
  const escapedUrl = item.link
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return `<p>${escapeHtml(body)}<a href="${escapedUrl}">${escapeHtml(item.link)}</a></p>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function docsBlock(item) {
  const summary = item.summary || "";
  return `\n${item.title}\n\n${summary}\n\n${item.link}\n`;
}

function oauth1Header(method, url, params, creds) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(String(all[k]))}`)
    .join("&");
  const base = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join(
    "&"
  );
  const signingKey = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret)}`;
  oauth.oauth_signature = crypto
    .createHmac("sha1", signingKey)
    .update(base)
    .digest("base64");
  const header = Object.keys(oauth)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(String(oauth[k]))}"`)
    .join(", ");
  return `OAuth ${header}`;
}

async function tumblrPhotoPost(item, creds) {
  const url = `https://api.tumblr.com/v2/blog/${encodeURIComponent(TUMBLR_BLOG)}/post`;
  const params = {
    type: item.image ? "photo" : "text",
    caption: tumblrCaption(item),
    tags: tagsFor(item).join(","),
    link: item.link,
  };
  if (item.image) {
    params.source = item.image;
    params.link = item.link;
  } else {
    params.body = tumblrCaption(item);
    params.title = item.title;
    warn("tumblr", `no hero image for ${item.guid}; posting as text`);
  }
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: oauth1Header("POST", url, params, creds),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  if (!res.ok || (data.meta && data.meta.status && data.meta.status >= 400)) {
    const status = (data.meta && data.meta.status) || res.status;
    const msg = (data.meta && data.meta.msg) || text.slice(0, 200);
    throw new Error(`HTTP ${status}: ${msg}`);
  }
  return data;
}

async function googleAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
    "base64url"
  );
  const claim = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: DOCS_SCOPE,
      aud: sa.token_uri || "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  ).toString("base64url");
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const jwt = `${unsigned}.${signer.sign(sa.private_key, "base64url")}`;
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    const err = data.error || res.status;
    const desc = data.error_description || "token request failed";
    throw new Error(`Google auth ${err}: ${desc}`);
  }
  return data.access_token;
}

async function docsRequest(token, method, urlPath, body) {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (data.error && data.error.message) || JSON.stringify(data).slice(0, 300);
    const err = new Error(`Docs API ${res.status}: ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function endIndexOf(doc) {
  const content = (doc.body && doc.body.content) || [];
  if (!content.length) return 1;
  return content[content.length - 1].endIndex || 1;
}

async function docsEndIndex(token) {
  const doc = await docsRequest(token, "GET", encodeURIComponent(GOOGLE_DOC_ID));
  return endIndexOf(doc);
}

async function docsAppend(item, token) {
  const endIndex = await docsEndIndex(token);
  const text = docsBlock(item);
  await docsRequest(token, "POST", `${encodeURIComponent(GOOGLE_DOC_ID)}:batchUpdate`, {
    requests: [
      {
        insertText: {
          location: { index: endIndex - 1 },
          text,
        },
      },
    ],
  });
}

const BSKY_PDS = (process.env.BSKY_PDS || "https://bsky.social").replace(/\/$/, "");
const BSKY_MAX_GRAPHEMES = 300;

function graphemeSegments(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].map(
      (s) => s.segment
    );
  }
  return [...String(text)];
}

function graphemeCount(text) {
  return graphemeSegments(text).length;
}

function trimToGraphemes(text, max) {
  const segs = graphemeSegments(text);
  if (segs.length <= max) return text;
  return segs.slice(0, Math.max(0, max)).join("");
}

function bskyApiError(data, res) {
  if (data && typeof data === "object") {
    return data.message || data.error || `HTTP ${res.status}`;
  }
  return `HTTP ${res.status}`;
}

function bskyCreds() {
  const handle = (process.env.BSKY_HANDLE || "").trim();
  const password = (process.env.BSKY_APP_PASSWORD || "").trim();
  if (!handle || !password) {
    throw new SkipDestination(
      "bluesky",
      "skipped (BSKY_HANDLE or BSKY_APP_PASSWORD not set)"
    );
  }
  return { handle, password };
}

async function bskyCreateSession(creds) {
  const res = await fetch(`${BSKY_PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: creds.handle,
      password: creds.password,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessJwt || !data.did) {
    throw new Error(`session failed: ${bskyApiError(data, res)}`);
  }
  return {
    accessJwt: data.accessJwt,
    did: data.did,
    handle: data.handle || creds.handle,
  };
}

function bskyPostText(item) {
  const link = item.link;
  const linkGraphemes = graphemeCount(link);
  let title = (item.title || "").trim();
  let summary = (item.summary || "").trim();
  // title + newline + link must fit; trim the title if needed
  const titleMax = Math.max(0, BSKY_MAX_GRAPHEMES - 1 - linkGraphemes);
  title = trimToGraphemes(title, titleMax).trimEnd();
  const afterTitle = graphemeCount(title) + 1 + linkGraphemes;
  const summaryMax = Math.max(0, BSKY_MAX_GRAPHEMES - afterTitle - 1);
  summary = trimToGraphemes(summary, summaryMax).trimEnd();
  const beforeLink = summary ? `${title}\n${summary}\n` : `${title}\n`;
  const text = `${beforeLink}${link}`;
  const byteStart = Buffer.byteLength(beforeLink, "utf8");
  const byteEnd = Buffer.byteLength(text, "utf8");
  return { text, byteStart, byteEnd };
}

async function bskyCreatePost(item, session) {
  const { text, byteStart, byteEnd } = bskyPostText(item);
  const description = trimToGraphemes((item.summary || "").trim(), 300).trim();
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    langs: ["en"],
    facets: [
      {
        index: { byteStart, byteEnd },
        features: [
          {
            $type: "app.bsky.richtext.facet#link",
            uri: item.link,
          },
        ],
      },
    ],
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: item.link,
        title: item.title || item.link,
        description: description || item.title || "",
      },
    },
  };
  const res = await fetch(`${BSKY_PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`createRecord failed: ${bskyApiError(data, res)}`);
  }
  return data;
}


function instapaperCreds() {
  const username = (process.env.INSTAPAPER_USERNAME || "").trim();
  const password = (process.env.INSTAPAPER_PASSWORD || "").trim();
  if (!username || !password) {
    throw new SkipDestination(
      "instapaper",
      "skipped (INSTAPAPER_USERNAME or INSTAPAPER_PASSWORD not set)"
    );
  }
  return { username, password };
}

async function instapaperAdd(item, creds) {
  const endpoint = "https://www.instapaper.com/api/add";
  const basic = Buffer.from(`${creds.username}:${creds.password}`).toString(
    "base64"
  );
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      url: item.link,
      title: item.title,
    }),
  });
  // Instapaper Simple API: 201 = saved. Log the status only — never secrets.
  const body = await res.text();
  if (res.status !== 201) {
    const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(
      snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`
    );
  }
  return { status: res.status };
}

async function maybe(dest, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SkipDestination) {
      warn(dest, err.reason);
      return "skipped";
    }
    throw err;
  }
}

async function main() {
  if (DRY_RUN) log("run", "dry-run; no posts and no state writes");

  const xml = await fetch(FEED_URL).then((res) => {
    if (!res.ok) throw new Error(`feed: HTTP ${res.status} fetching ${FEED_URL}`);
    return res.text();
  });
  const items = parseFeed(xml);
  log("feed", `${items.length} item(s) from ${FEED_URL}`);

  const state = loadState();
  const posted = {
    tumblr: new Set(state.tumblr),
    docs: new Set(state.docs),
    bluesky: new Set(state.bluesky),
    instapaper: new Set(state.instapaper),
  };

  let failures = 0;
  const tumblr = await maybe("tumblr", () => tumblrCreds());
  const sa = await maybe("docs", () => loadServiceAccount());
  const bskyCred = await maybe("bluesky", () => bskyCreds());
  const instapaper = await maybe("instapaper", () => instapaperCreds());
  warn(
    "diigo",
    "hook disabled (Diigo API keys are premium-only); not posting"
  );

  let docsToken = null;
  if (sa && sa !== "skipped") {
    docsToken = await googleAccessToken(sa);
    log("docs", `authenticated as ${sa.client_email}`);
    if (DRY_RUN) {
      try {
        const endIndex = await docsEndIndex(docsToken);
        log("docs", `dry-run ok; document end index is ${endIndex}`);
      } catch (err) {
        if (err.status === 403) {
          err.message = `${err.message} (403 usually means the service account is not yet shared on the Doc as an editor)`;
        }
        throw err;
      }
    }
  }

  let bskySession = null;
  if (bskyCred && bskyCred !== "skipped") {
    try {
      bskySession = await bskyCreateSession(bskyCred);
      log("bluesky", `authenticated as ${bskySession.handle}`);
    } catch (err) {
      failures += 1;
      warn("bluesky", `session failed: ${err.message}`);
    }
  }

  // Oldest first so the Doc is appended in publish order.
  const chronological = [...items].reverse();
  let stateDirty = false;
  const already = { tumblr: 0, docs: 0, bluesky: 0, instapaper: 0 };

  for (const item of chronological) {
    if (tumblr && tumblr !== "skipped") {
      if (posted.tumblr.has(item.guid)) {
        already.tumblr += 1;
      } else if (DRY_RUN) {
        log("tumblr", `dry-run would post ${item.guid}`);
      } else {
        try {
          await tumblrPhotoPost(item, tumblr);
          posted.tumblr.add(item.guid);
          state.tumblr = [...posted.tumblr];
          stateDirty = true;
          log("tumblr", `posted ${item.guid}`);
        } catch (err) {
          failures += 1;
          warn("tumblr", `failed ${item.guid}: ${err.message}`);
        }
      }
    }

    if (docsToken) {
      if (posted.docs.has(item.guid)) {
        already.docs += 1;
      } else if (DRY_RUN) {
        log("docs", `dry-run would append ${item.guid}`);
      } else {
        try {
          await docsAppend(item, docsToken);
          posted.docs.add(item.guid);
          state.docs = [...posted.docs];
          stateDirty = true;
          log("docs", `appended ${item.guid}`);
        } catch (err) {
          failures += 1;
          warn("docs", `failed ${item.guid}: ${err.message}`);
        }
      }
    }

    if (bskySession) {
      if (posted.bluesky.has(item.guid)) {
        already.bluesky += 1;
      } else if (DRY_RUN) {
        log("bluesky", `dry-run would post ${item.guid}`);
      } else {
        try {
          await bskyCreatePost(item, bskySession);
          posted.bluesky.add(item.guid);
          state.bluesky = [...posted.bluesky];
          stateDirty = true;
          log("bluesky", `posted ${item.guid}`);
        } catch (err) {
          failures += 1;
          warn("bluesky", `failed ${item.guid}: ${err.message}`);
        }
      }
    }

    if (instapaper && instapaper !== "skipped") {
      if (posted.instapaper.has(item.guid)) {
        already.instapaper += 1;
      } else if (DRY_RUN) {
        log("instapaper", `dry-run would save ${item.guid}`);
      } else {
        try {
          const result = await instapaperAdd(item, instapaper);
          posted.instapaper.add(item.guid);
          state.instapaper = [...posted.instapaper];
          stateDirty = true;
          log("instapaper", `saved ${item.guid} (HTTP ${result.status})`);
        } catch (err) {
          failures += 1;
          warn("instapaper", `failed ${item.guid}: ${err.message}`);
        }
      }
    }
  }

  if (tumblr && tumblr !== "skipped") {
    log("tumblr", `${already.tumblr} feed item(s) already in state`);
  }
  if (docsToken) {
    log("docs", `${already.docs} feed item(s) already in state`);
  }
  if (bskySession) {
    log("bluesky", `${already.bluesky} feed item(s) already in state`);
  }
  if (instapaper && instapaper !== "skipped") {
    log("instapaper", `${already.instapaper} feed item(s) already in state`);
  }

  if (stateDirty && !DRY_RUN) {
    saveState(state);
    log("state", `wrote ${path.relative(REPO_ROOT, STATE_PATH)}`);
  } else {
    log("state", DRY_RUN ? "unchanged (dry-run)" : "unchanged");
  }

  if (failures) {
    process.exitCode = 1;
    warn("run", `${failures} post(s) failed`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
