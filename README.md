# Daily Insight Desk

Static home and garden guides for [dailyinsightdesk.com](https://dailyinsightdesk.com). The site is built with [Eleventy](https://www.11ty.dev/) and deployed on Vercel.

```bash
npm install
npm run build
npm run dev
```

`npm run build` writes `_site/` and checks that internal links, canonical URLs, the sitemap, `robots.txt`, and the RSS feed at `/feed.xml` resolve. `/feed`, `/feed/`, and `/rss.xml` redirect to that feed. It also validates every AMP Web Story. Guides live in `src/cleaning/` and `src/kitchen/`. Shelf copy and upcoming titles live in `src/_data/silos.js`. Affiliate URLs live in `src/_data/products.js` and should stay exactly as they are.

The `{% product "id" %}` shortcode renders the offer box. Its photo is a link to that product’s affiliate URL, with `rel="sponsored nofollow noopener"` and `target="_blank"`, the same as the button. A markdown image whose address is a product photo in that file is linked the same way. The alt text is the product name plus the photo description. Hero images, story posters, and other photos are not linked.

## Web Stories

A guide gets a story when its front matter includes a `story` block. The build turns that into `/stories/<slug>/` and lists it on `/stories/`.

```yaml
story:
  slug: garden-hose-pressure-nozzle
  pages:
    - id: cover
      title: "A short cover line"
      text: "One subtitle sentence."
      image: /assets/images/guide-hose-1600.webp
      imageWidth: 1600
      imageHeight: 900
      alt: "Description of the photo"
      tone: ink
    - id: read
      title: "Read the full guide"
      text: "What the article adds."
      tone: moss
```

Use 5 to 10 pages. `id` values must be unique. `tone` is `ink`, `moss`, or `clay`. Each page should set `image`, `imageWidth`, `imageHeight`, and `alt`. Portrait card photos live at `src/assets/images/stories/<slug>/pN.webp` (720×960). If a page omits `image`, the template uses the guide hero, then the product photo named by `product` in the story block, so a card is not left blank. The build fails if a rendered story page still has no image. The first page is the cover and is the only `h1`. The last page’s button links to the guide. Do not put affiliate URLs in `story`.

Add a portrait poster at `src/assets/images/stories/<slug>.webp`, at least 640×853 (the ones in the repo are 720×960 crops of the guide image). The article page then shows “View as a story” on its own.
