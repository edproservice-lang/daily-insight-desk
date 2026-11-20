# Autowriter (free)

`.github/workflows/daily-articles.yml` runs Mon–Sat at 07:17 (São Paulo) and on demand (Actions → Daily articles → Run workflow, optional count).

- Writes the next `todo` items from `queue.json` with the free Gemini API (secret `GEMINI_API_KEY`; optional variable `GEMINI_MODELS` = comma-separated fallback list).
- How many per day: repository variable `ARTICLES_PER_DAY` (default 2).
- Checks: word count, H2/H3, pros/cons, who-it's-for, 3–6 in-sentence internal links, no forbidden hosts, no invented test/rating/testimonial/medical claims, no “we have not tested” disclaimers, in-text affiliate CTAs on product articles, every source URL must return HTTP 200. A short commission note is inserted by the article layout before the first offer link; the site footer disclosure stays as it is.
- Images: hero + 7 Web Story cards (720×960 WebP) from Openverse / Wikimedia Commons (CC0 / public domain only); the product card uses the seller photo from `products.js`.
- Adds up to 3 links from older articles to the new one (exact existing phrase only).
- Runs the Eleventy build + `scripts/check-site.js`; one retry with the error; otherwise skips.
- Opens a PR labeled `autowriter`. **Never auto-merges** — review, edit, merge.

New product: add it to `src/_data/products.js` with João's own affiliate link and a producer image (optional `storyImages: [...]`), then add or flip its queue item to `todo`.
