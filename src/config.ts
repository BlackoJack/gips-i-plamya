/**
 * Название и запасные контакты сборки.
 * На живом сайте их заменяет админка.
 */

export const config = {
  name: "Гипс и пламя",
  city: "Новосибирск",
  siteUrl: "https://gipsplamya.com",
  contacts: {
    telegram: "",
    whatsapp: "",
    max: "",
    email: "",
    telegramGroup: "",
    whatsappGroup: "",
    maxGroup: "",
  },
  meta: {
    title: "Гипс и пламя — гипсовый декор и свечи в Новосибирске",
    description:
      "Гипсовый декор, свечи, вазы и тарелочки ручной работы. Мастерская «Гипс и пламя» в Новосибирске.",
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

