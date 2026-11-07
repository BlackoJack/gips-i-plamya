/**
 * Контакты и название. Цены товаров здесь не живут:
 * у каждого изделия своя папка в src/content/products.
 */

export const config = {
  name: "Гипс и пламя",
  siteUrl: "https://blackojack.github.io",
  contacts: {
    /** TODO: полная ссылка, например https://t.me/name. Пусто — кнопки «Написать» скрыты. */
    telegram: "",
  },
  meta: {
    title: "Гипс и пламя — гипсовый декор и свечи для дома",
    description:
      "Гипсовый декор, свечи, вазы и тарелочки ручной работы. Изделия мастерской «Гипс и пламя».",
    ogImage: "/og.jpg",
  },
} as const;

/** 1900 → «1 900 ₽» */
export function money(value: number): string {
  const formatted = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(value);
  return `${formatted.replace(/[\u00A0\u202F]/g, " ")}\u00A0₽`;
}

/** Путь с учётом базовой папки GitHub Pages. */
export function href(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const hashAt = path.indexOf("#");
  const hash = hashAt >= 0 ? path.slice(hashAt) : "";
  const pathname = hashAt >= 0 ? path.slice(0, hashAt) : path;
  if (!pathname) return `${base || "/"}${hash}`;
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${normalized}${hash}`;
}

export function asset(path: string): string {
  return href(path.startsWith("/") ? path : `/${path}`);
}

/** Ссылка на Telegram. Без адреса кнопки на сайте нет. */
export function telegramHref(text?: string): string | null {
  const raw = config.contacts.telegram.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "contacts.telegram в src/config.ts должен быть полной ссылкой, например https://t.me/name",
    );
  }
  if (text) url.searchParams.set("text", text);
  return url.toString();
}

export function orderText(title: string, priceLabel: string | null, pageUrl: string): string {
  const price = priceLabel ? `, цена ${priceLabel}` : "";
  return `Здравствуйте! Хочу «${title}»${price}. Ссылка: ${pageUrl}`;
}
