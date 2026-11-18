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

function toIsoDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
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
      const ownTracking = host === "clickrtrckr.com" || host === "clickomundo.com";
      const ownSite = host === "dailyinsightdesk.com";
      const authority = host.endsWith(".gov") || host.endsWith(".edu") || host.endsWith(".gov.uk") || host.endsWith(".ac.uk");
      token.attrSet("target", "_blank");
      if (ownTracking) token.attrSet("rel", "sponsored nofollow noopener");
      else if (ownSite || authority) token.attrSet("rel", "noopener");
      else token.attrSet("rel", "nofollow noopener");
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  eleventyConfig.setLibrary("md", markdown);

  eleventyConfig.addFilter("inSilo", (guides, slug) =>
    (guides || []).filter((post) => post.data.silo === slug)
  );
  eleventyConfig.addFilter("isoDate", toIsoDate);
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
    return `<aside class="product" aria-label="${esc(product.name)} offer">
      <p class="product-kicker">Seller offer · Affiliate link</p>
      <div class="product-layout">
        <img class="product-photo" src="${esc(product.image)}" width="${product.width}" height="${product.height}" alt="${esc(product.alt)}" loading="lazy" decoding="async">
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
