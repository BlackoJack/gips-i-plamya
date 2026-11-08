/**
 * Добавляет в уже живущий контент изделия и полки из репозитория.
 * Существующие поля не меняет. Если бакет не читается, печатает keep.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { mergeContent } = require("../yandex/lead/index.js");

const remotePath = process.argv[2];
const outPath = process.argv[3];
if (!remotePath || !outPath) {
  console.error("Нужны два пути: remote.json и merged.json");
  process.exit(1);
}

let remote;
try {
  remote = JSON.parse(fs.readFileSync(remotePath, "utf8"));
} catch {
  console.error("Контент в бакете не разобран, не трогаю его.");
  console.log("keep");
  process.exit(0);
}

const seed = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "yandex/lead/content.default.json"), "utf8"),
);
const merged = mergeContent(remote, seed);
if (!merged.ok) {
  console.error("Контент в бакете не разобран, не трогаю его.");
  console.log("keep");
  process.exit(0);
}
if (!merged.changed) {
  console.log("same");
  process.exit(0);
}
fs.writeFileSync(outPath, `${JSON.stringify(merged.value, null, 2)}\n`);
console.log("changed");
