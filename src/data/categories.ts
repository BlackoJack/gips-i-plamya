export const categories = [
  {
    id: "vases",
    slug: "vazy",
    title: "Вазы",
    line: "для ваших любимых цветов",
  },
  {
    id: "candles",
    slug: "svechi",
    title: "Свечи",
    line: "для тепла и атмосферы",
  },
  {
    id: "plates",
    slug: "tarelki",
    title: "Тарелочки",
    line: "для мелочей и красоты",
  },
  {
    id: "decor",
    slug: "dekor",
    title: "Декор",
    line: "для уюта в каждом уголке",
  },
] as const;

export type CategoryId = (typeof categories)[number]["id"];
export type Category = (typeof categories)[number];

export function categoryById(id: string): Category | undefined {
  return categories.find((item) => item.id === id);
}

export function categoryBySlug(slug: string): Category | undefined {
  return categories.find((item) => item.slug === slug);
}
