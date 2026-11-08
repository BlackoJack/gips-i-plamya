import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

/**
 * В dev повторяет шлюз Яндекса: /admin, неизвестное изделие и неизвестная полка
 * получают готовую оболочку. Адрес в браузере не меняется, скрипт читает его сам.
 */
function devGateway() {
  const root = process.cwd();
  const productsDir = join(root, "src/content/products");
  const productIds = new Set(
    existsSync(productsDir)
      ? readdirSync(productsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
          .map((entry) => entry.name)
      : [],
  );
  const categorySource = existsSync(join(root, "src/data/categories.ts"))
    ? readFileSync(join(root, "src/data/categories.ts"), "utf8")
    : "";
  const categorySlugs = new Set([...categorySource.matchAll(/slug:\s*"([^"]+)"/g)].map((match) => match[1]));

  return {
    name: "dev-gateway",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url?.split("?")[0] || "";
        const query = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
        if (path === "/admin" || path === "/admin/") {
          req.url = `/admin/index.html${query}`;
          return next();
        }
        const product = path.match(/^\/izdelie\/([a-z0-9][a-z0-9_-]{0,40})\/?$/);
        if (product && !productIds.has(product[1])) {
          req.url = `/izdelie/${query}`;
          return next();
        }
        const category = path.match(/^\/katalog\/([a-z0-9][a-z0-9_-]{0,40})\/?$/);
        if (category && !categorySlugs.has(category[1])) {
          req.url = `/katalog/${query}`;
          return next();
        }
        next();
      });
    },
  };
}

/**
 * site и base приходят из окружения, чтобы один и тот же код работал
 * и локально, и на своём домене (base = "/"), и в подпапке GitHub Pages.
 *
 *   SITE_URL=https://blackojack.github.io BASE_PATH=/gips-i-plamya/ npm run build
 *
 * В Actions эти значения подставляет configure-pages.
 * Без переменных собирается обычная корневая версия для локального просмотра.
 */
const site = process.env.SITE_URL || "https://blackojack.github.io";
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  site,
  base,
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss(), devGateway()],
    server: {
      proxy: {
        "/api": "http://127.0.0.1:8787",
        "/media": "http://127.0.0.1:8787",
      },
    },
  },
});
