import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

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
    plugins: [tailwindcss()],
  },
});
