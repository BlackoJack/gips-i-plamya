/**
 * Собирает yandex/lead/content.default.json из текстов репозитория и папок изделий.
 * Папки, имя которых начинается с _, в каталог не входят.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.ts";
import { content } from "../src/data/content.ts";
import { categories } from "../src/data/categories.ts";

const require = createRequire(import.meta.url);
const { checkContent } = require("../yandex/lead/index.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productsRoot = path.join(root, "src/content/products");

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => {
      const item = part.trim();
      if (item.startsWith('"')) return JSON.parse(item);
      return item;
    });
  }
  if (!/^[\w.-]+$/.test(value)) throw new Error(`Не понял значение «${value}»`);
  return value;
}

function readProduct(id: string) {
  const folder = path.join(productsRoot, id);
  const raw = fs.readFileSync(path.join(folder, "index.md"), "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`У «${id}» нет шапки markdown`);
  const data: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitAt = trimmed.indexOf(":");
    if (splitAt === -1) throw new Error(`Строка «${trimmed}» в «${id}» без двоеточия`);
    data[trimmed.slice(0, splitAt).trim()] = parseValue(trimmed.slice(splitAt + 1));
  }
  const images = Array.isArray(data.images) ? data.images.map(String) : [];
  for (const file of images) {
    if (file.includes("/") || file.includes("\\") || !/^[a-z0-9][a-z0-9_-]{0,40}\.jpg$/.test(file)) {
      throw new Error(`Имя фото «${file}» у «${id}» не подходит. Нужен файл вроде 1.jpg`);
    }
    if (!fs.existsSync(path.join(folder, file))) throw new Error(`Не найден файл ${file} у «${id}»`);
  }
  return {
    product: {
      id,
      title: data.title,
      price: data.price ?? null,
      category: data.category,
      summary: data.summary ?? "",
      body: match[2].trim(),
      featured: data.featured === true,
      order: data.order ?? 100,
      published: data.published === true,
      images: images.map((file) => `media/${id}/${file}`),
    },
    files: images,
  };
}

function buildSeed() {
  const products = [];
  const files: { id: string; file: string }[] = [];
  for (const name of fs.readdirSync(productsRoot).sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const folder = path.join(productsRoot, name);
    if (!fs.statSync(folder).isDirectory()) continue;
    const read = readProduct(name);
    products.push(read.product);
    for (const file of read.files) files.push({ id: name, file });
  }
  return {
    draft: {
      contacts: { telegram: config.contacts.telegram },
      meta: { title: config.meta.title, description: config.meta.description },
      texts: {
        hero: {
          kicker: content.hero.kicker,
          line: content.hero.line,
          catalog: content.hero.catalog,
          write: content.hero.write,
        },
        shelf: content.shelf,
        order: { title: content.order.title, steps: [...content.order.steps] },
        about: { title: content.about.title, text: content.about.text },
        empty: { first: content.empty.first, second: content.empty.second },
        product: {
          want: content.product.want,
          priceLater: content.product.priceLater,
          more: content.product.more,
        },
      },
      categories: categories.map((item) => ({
        id: item.id,
        slug: item.slug,
        title: item.title,
        line: item.line,
      })),
      products,
    },
    files,
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

const built = buildSeed();
const checked = checkContent(built.draft);
if (!checked.ok) {
  console.error(checked.error);
  process.exit(1);
}

const outFlag = argument("--out");
const out = outFlag
  ? path.resolve(outFlag)
  : path.join(root, "yandex/lead/content.default.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(checked.value, null, 2)}\n`);

if (process.argv.includes("--list-images")) {
  for (const item of built.files) process.stdout.write(`${item.id}\t${item.file}\n`);
}
