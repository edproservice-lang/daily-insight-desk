# Autowriter (free)

`.github/workflows/daily-articles.yml` runs Mon–Sat at 07:17 (São Paulo) and on demand (Actions → Daily articles → Run workflow, optional count).

- Before writing, `scripts/keyword-check.mjs` checks each `todo` keyword for search demand with the Bing Webmaster keyword research API (secret `BING_WEBMASTER_API_KEY`, or `~/.secrets/bing_webmaster_api_key` locally) and Google Autocomplete. Items are marked `demand.level` `ok`, `weak`, or `none`. A `none` item is rewritten to the best on-topic variant that people actually search, or skipped if no variant fits. Todos are then reordered so stronger-demand keywords go first, with product-linked items kept reasonably mixed. This step uses no LLM tokens.
- Writes the next `todo` items from `queue.json` with the free Gemini API (secret `GEMINI_API_KEY`; optional variable `GEMINI_MODELS` = comma-separated fallback list). Zero-demand items that could not be rewritten are skipped.
- How many per day: repository variable `ARTICLES_PER_DAY` (default 2).
- Checks: word count, H2/H3, pros/cons, who-it's-for, 3–6 in-sentence internal links, no forbidden hosts, no invented test/rating/testimonial/medical claims, no “we have not tested” disclaimers, in-text affiliate CTAs on product articles, every source URL must return HTTP 200. A short commission note is inserted by the article layout before the first offer link; the site footer disclosure stays as it is.
- Images: hero + one mid-article photo + 7 Web Story cards (720×960 WebP). The mid-article photo is placed in the section it illustrates. If the article has a product, it uses a seller/producer image from `products.js` and links it to the affiliate URL; otherwise it uses a free stock photo from Pixabay (when secret `PIXABAY_API_KEY` is set; downloaded into the repo, never hotlinked), then Openverse or Wikimedia Commons (CC0 / public domain) as backup. The product card uses the seller photo from `products.js`.
- Adds up to 3 links from older articles to the new one (exact existing phrase only).
- Runs the Eleventy build + `scripts/check-site.js`; one retry with the error; otherwise skips.
- Opens a PR labeled `autowriter`. **Never auto-merges** — review, edit, merge.

New product: add it to `src/_data/products.js` with João's own affiliate link and a producer image (optional `storyImages: [...]`), then add or flip its queue item to `todo`.
