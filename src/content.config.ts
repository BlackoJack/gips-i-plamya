import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import { categories } from "./data/categories";

const categoryIds = categories.map((item) => item.id) as [
  (typeof categories)[number]["id"],
  ...(typeof categories)[number]["id"][],
];

const products = defineCollection({
  loader: glob({
    pattern: "**/index.md",
    base: "./src/content/products",
    generateId: ({ entry }) => entry.replace(/\\/g, "/").replace(/\/index\.md$/, ""),
  }),
  schema: z.object({
    title: z.string().min(1),
    price: z.number().nonnegative().nullable().default(null),
    stock: z.number().int().nonnegative().max(9999).default(0),
    category: z.enum(categoryIds),
    summary: z.string().min(1),
    featured: z.boolean().default(false),
    order: z.number().default(100),
    published: z.boolean().default(false),
    images: z.array(z.string().min(1)).default([]),
  }),
});

export const collections = { products };
