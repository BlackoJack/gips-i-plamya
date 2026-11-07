import fs from "node:fs";
import path from "node:path";
import { getCollection, type CollectionEntry } from "astro:content";
import type { ImageMetadata } from "astro";
import { categories } from "../data/categories";

export type Product = CollectionEntry<"products">;

const imageFiles = import.meta.glob(
  "/src/content/products/**/*.{jpg,jpeg,png,webp,avif}",
  { eager: true, import: "default" },
) as Record<string, ImageMetadata>;

const productsRoot = path.resolve("./src/content/products");

function compareProducts(a: Product, b: Product): number {
  const byOrder = a.data.order - b.data.order;
  if (byOrder !== 0) return byOrder;
  return a.data.title.localeCompare(b.data.title, "ru");
}

function assertPublished(product: Product): void {
  const { title, category, images } = product.data;
  if (!title.trim()) {
    throw new Error(`У изделия «${product.id}» нет названия.`);
  }
  if (!categories.some((item) => item.id === category)) {
    throw new Error(`У «${title}» неизвестная категория «${category}».`);
  }
  if (!product.body?.trim()) {
    throw new Error(`У «${title}» пустое описание.`);
  }
  if (images.length === 0) {
    throw new Error(`У «${title}» нет фотографий. Положите файлы в папку и перечислите их в images.`);
  }
  for (const name of images) {
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new Error(`Имя файла «${name}» у «${title}» должно быть без папок.`);
    }
    const file = path.join(productsRoot, product.id, name);
    if (!fs.existsSync(file)) {
      throw new Error(`Не найден файл ${name} у «${title}».`);
    }
  }
}

export async function getPublished(): Promise<Product[]> {
  const all = await getCollection("products");
  for (const product of all) {
    if (product.data.published) assertPublished(product);
  }
  return all.filter((product) => product.data.published).sort(compareProducts);
}

export async function getFeatured(): Promise<Product[]> {
  return (await getPublished()).filter((product) => product.data.featured);
}

export function imagesOf(product: Product): ImageMetadata[] {
  return product.data.images.map((name) => {
    const key = `/src/content/products/${product.id}/${name}`;
    const image = imageFiles[key];
    if (!image) {
      throw new Error(`Не удалось подключить фотографию ${name} у «${product.data.title}».`);
    }
    return image;
  });
}
