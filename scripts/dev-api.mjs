/**
 * Локальный /api/content и /api/admin для npm run dev.
 * Слушает только 127.0.0.1. Пароль — ADMIN_PASSWORD или local-admin.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localRoot = path.join(root, "yandex/.local");
const contentFile = path.join(localRoot, "content/site.json");

fs.mkdirSync(path.dirname(contentFile), { recursive: true });
if (!fs.existsSync(contentFile)) {
  fs.copyFileSync(path.join(root, "yandex/lead/content.default.json"), contentFile);
}

const ownPassword = !process.env.ADMIN_PASSWORD;
process.env.LOCAL_ROOT = localRoot;
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "local-admin";
process.env.DATA_BUCKET = "local";
process.env.SITE_BUCKET = "local";

const require = createRequire(import.meta.url);
const { handler, imageKeyOk } = require("../yandex/lead/index.js");

const repoProducts = path.join(root, "src/content/products");

function contentType(file) {
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function mediaFile(key) {
  const match = key.match(/^media\/([a-z0-9][a-z0-9_-]{0,40})\/([a-z0-9][a-z0-9_-]{0,40}\.jpg)$/);
  if (!match || !imageKeyOk(key, match[1])) return "";
  const local = path.join(localRoot, key);
  if (fs.existsSync(local)) return local;
  const source = path.join(repoProducts, match[1], match[2]);
  if (fs.existsSync(source)) return source;
  return "";
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      const key = decodeURIComponent(url.pathname.slice(1));
      const file = mediaFile(key);
      if (!file) {
        send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Нет фото");
        return;
      }
      send(res, 200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }, fs.readFileSync(file));
      return;
    }

    if (url.pathname === "/api/media-upload" && req.method === "PUT") {
      const key = url.searchParams.get("key") || "";
      const password = req.headers["x-admin-password"];
      if (password !== process.env.ADMIN_PASSWORD || !imageKeyOk(key)) {
        send(res, 401, { "Content-Type": "application/json; charset=utf-8" }, '{"ok":false}');
        return;
      }
      const body = await readBody(req, 5_000_000);
      const type = String(req.headers["content-type"] || "");
      if (type !== "image/jpeg") {
        send(res, 422, { "Content-Type": "application/json; charset=utf-8" }, '{"ok":false}');
        return;
      }
      const target = path.join(localRoot, key);
      const resolved = path.resolve(target);
      if (!resolved.startsWith(`${path.resolve(localRoot)}${path.sep}`)) {
        send(res, 400, { "Content-Type": "application/json; charset=utf-8" }, '{"ok":false}');
        return;
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, body);
      send(res, 200, { "Content-Type": "application/json; charset=utf-8" }, '{"ok":true}');
      return;
    }

    const route = url.pathname.startsWith("/api/content")
      ? "content"
      : url.pathname.startsWith("/api/admin")
        ? "admin"
        : url.pathname.startsWith("/api/order")
          ? "order"
          : "";
    const body = await readBody(req, 1_000_000);
    const result = await handler({
      httpMethod: req.method,
      headers: req.headers,
      body: body.toString("utf8"),
      isBase64Encoded: false,
      path: url.pathname,
      requestContext: { apiGateway: { operationContext: { route } } },
    });
    send(res, result.statusCode, result.headers, result.body);
  } catch {
    if (!res.headersSent) send(res, 500, { "Content-Type": "application/json; charset=utf-8" }, '{"ok":false}');
  }
});

server.listen(8787, "127.0.0.1", () => {
  console.log("Локальный API: http://127.0.0.1:8787");
  console.log("Админка откроется на http://127.0.0.1:4321/admin вместе с npm run dev");
  console.log(ownPassword ? "Пароль: local-admin" : "Пароль берётся из ADMIN_PASSWORD.");
});
