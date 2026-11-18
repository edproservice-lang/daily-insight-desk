# Daily Insight Desk

Static home and garden guides for [dailyinsightdesk.com](https://dailyinsightdesk.com). The site is built with [Eleventy](https://www.11ty.dev/) and deployed on Vercel.

```bash
npm install
npm run build
npm run dev
```

`npm run build` writes `_site/` and checks that internal links, canonical URLs, the sitemap, and `robots.txt` resolve. Guides live in `src/cleaning/` and `src/kitchen/`. Shelf copy and upcoming titles live in `src/_data/silos.js`. Affiliate URLs live in `src/_data/products.js` and should stay exactly as they are.
