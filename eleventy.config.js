import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import markdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import products from "./src/_data/products.js";

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function productAlt(product) {
  const name = String(product.name || "").trim();
  const detail = String(product.alt || "").trim();
  if (!detail) return name;
  if (detail.toLowerCase().includes(name.toLowerCase())) return detail;
  return `${name}. ${detail}`;
}

function affiliateImageLink(product, imgHtml) {
  return `<a class="product-photo-link affiliate-link" data-product="${esc(product.name)}" href="${esc(product.href)}" rel="sponsored nofollow noopener" target="_blank">${imgHtml}</a>`;
}

const productByImage = new Map(Object.values(products).map((product) => [product.image, product]));

function toIsoDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function toRfc822Date(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toUTCString();
}

function assetPath(urlPath) {
  const rel = String(urlPath || "").replace(/^\//, "");
  if (!rel) return "";
  const path = join(import.meta.dirname, "src", rel);
  return existsSync(path) ? path : "";
}


const AFFILIATE_NOTE_TEXT = "We may earn a commission if you buy through our links, at no extra cost to you.";
const AFFILIATE_NOTE_HTML = `<p class="affiliate-note">${AFFILIATE_NOTE_TEXT}</p>\n`;
const AFFILIATE_LINK_RE = /<a\b[^>]*?(?:class="[^"]*\baffiliate-link\b[^"]*"|href="https?:\/\/(?:www\.)?(?:clickrtrckr|clickomundo|treejammer|tricklyn)\.com[^"]*")[^>]*>/i;

function findAffiliateNoteInsertionPoint(before) {
  const blocks = [
    { open: /<aside\b[^>]*\bclass="[^"]*\bproduct\b[^"]*"[^>]*>/gi, close: "</aside>" },
    { open: /<ul\b[^>]*>/gi, close: "</ul>" },
    { open: /<ol\b[^>]*>/gi, close: "</ol>" },
    { open: /<blockquote\b[^>]*>/gi, close: "</blockquote>" },
    { open: /<p\b[^>]*>/gi, close: "</p>" },
  ];
  for (const { open, close } of blocks) {
    let match;
    let lastUnclosed = -1;
    open.lastIndex = 0;
    while ((match = open.exec(before))) {
      if (!before.slice(match.index).toLowerCase().includes(close)) {
        lastUnclosed = match.index;
      }
    }
    if (lastUnclosed !== -1) return lastUnclosed;
  }
  return before.length;
}

function withAffiliateNote(content) {
  const html = String(content ?? "");
  if (!html || html.includes('class="affiliate-note"') || html.includes("class='affiliate-note'")) return html;
  const match = html.match(AFFILIATE_LINK_RE);
  if (!match || match.index == null) return html;
  const insertAt = findAffiliateNoteInsertionPoint(html.slice(0, match.index));
  return html.slice(0, insertAt) + AFFILIATE_NOTE_HTML + html.slice(insertAt);
}

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ public: "." });

  const markdown = markdownIt({
    html: true,
    linkify: false,
    typographer: true,
  });
  markdown.use(markdownItAnchor, {
    slugify,
    level: 2,
    permalink: false,
  });

  const defaultLinkOpen = markdown.renderer.rules.link_open
    || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet("href") || "";
    if (/^https?:\/\//i.test(href)) {
      let host = "";
      try {
        host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        host = "";
      }
      const ownTracking = ["clickrtrckr.com", "clickomundo.com", "treejammer.com", "tricklyn.com"].includes(host);
      const ownSite = host === "dailyinsightdesk.com";
      const authority = host.endsWith(".gov") || host.endsWith(".edu") || host.endsWith(".gov.uk") || host.endsWith(".ac.uk");
      token.attrSet("target", "_blank");
      if (ownTracking) {
        token.attrSet("rel", "sponsored nofollow noopener");
        const existing = token.attrGet("class") || "";
        if (!/(^|\s)affiliate-link(\s|$)/.test(existing)) {
          token.attrSet("class", `${existing} affiliate-link`.trim());
        }
      } else if (ownSite || authority) token.attrSet("rel", "noopener");
      else token.attrSet("rel", "nofollow noopener");
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  const defaultImage = markdown.renderer.rules.image
    || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet("src") || "";
    const product = productByImage.get(src);
    if (!product) return defaultImage(tokens, idx, options, env, self);
    const img = `<img class="product-photo" src="${esc(src)}" alt="${esc(productAlt(product))}" loading="lazy" decoding="async">`;
    return affiliateImageLink(product, img);
  };
  eleventyConfig.setLibrary("md", markdown);

  eleventyConfig.addCollection("storyGuides", (api) =>
    api.getFilteredByTag("guide")
      .filter((item) => item.data.story && item.data.story.slug && item.data.story.pages)
      .sort((a, b) => String(a.data.title || "").localeCompare(String(b.data.title || "")))
  );
  eleventyConfig.addFilter("inSilo", (guides, slug) =>
    (guides || []).filter((post) => post.data.silo === slug)
  );
  eleventyConfig.addFilter("recommend", (guides, currentUrl, silo) => {
    const list = (guides || []).filter((post) => post.url !== currentUrl && post.data.hero);
    const byRecent = (a, b) => {
      const ta = new Date(a.data.updated || a.data.date || 0).getTime();
      const tb = new Date(b.data.updated || b.data.date || 0).getTime();
      if (tb !== ta) return tb - ta;
      return String(a.data.title || "").localeCompare(String(b.data.title || ""));
    };
    const same = list.filter((post) => post.data.silo === silo).sort(byRecent);
    const other = list.filter((post) => post.data.silo !== silo).sort(byRecent);
    return [...same, ...other].slice(0, 3);
  });
  eleventyConfig.addFilter("withAffiliateNote", withAffiliateNote);
  eleventyConfig.addFilter("isoDate", toIsoDate);
  eleventyConfig.addFilter("rfc822Date", toRfc822Date);
  eleventyConfig.addFilter("assetMime", (urlPath) => {
    const ext = String(urlPath || "").split(".").pop().toLowerCase();
    return { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif" }[ext] || "image/jpeg";
  });
  eleventyConfig.addFilter("assetLength", (urlPath) => {
    const path = assetPath(urlPath);
    return path ? statSync(path).size : 0;
  });
  eleventyConfig.addCollection("feedPosts", (api) =>
    api.getFilteredByTag("guide")
      .filter((item) => item.url && item.data.title)
      .toSorted((a, b) => {
        const ta = new Date(a.date || a.data.date || 0).getTime();
        const tb = new Date(b.date || b.data.date || 0).getTime();
        if (tb !== ta) return tb - ta;
        return String(a.data.title || "").localeCompare(String(b.data.title || ""));
      })
      .slice(0, 20)
  );
  eleventyConfig.addFilter("prettyDate", (value) => {
    const iso = toIsoDate(value);
    if (!iso) return "";
    const [year, month, day] = iso.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
  });

  eleventyConfig.addShortcode("product", (id) => {
    const product = products[id];
    if (!product) {
      throw new Error(`Unknown product "${id}"`);
    }
    const points = product.points
      .map((point) => `<li>${esc(point)}</li>`)
      .join("");
    const photo = `<img class="product-photo" src="${esc(product.image)}" width="${product.width}" height="${product.height}" alt="${esc(productAlt(product))}" loading="lazy" decoding="async">`;
    return `<aside class="product" aria-label="${esc(product.name)} offer">
      <p class="product-kicker">Seller offer · Affiliate link</p>
      <div class="product-layout">
        ${affiliateImageLink(product, photo)}
        <div>
          <h3>${esc(product.name)}</h3>
          <p>${esc(product.summary)}</p>
          <ul>${points}</ul>
          <a class="btn affiliate-link" data-product="${esc(product.name)}" href="${esc(product.href)}" rel="sponsored nofollow noopener" target="_blank">${esc(product.cta)}</a>
          <p class="product-caption">${esc(product.caption)}</p>
        </div>
      </div>
    </aside>`;
  });

  return {
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
  };
}
