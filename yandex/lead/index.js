/**
 * Yandex Cloud Functions: публичный каталог и админка.
 *
 * GET /api/content — тексты, контакт, полки и опубликованные изделия.
 * POST /api/admin — пароль в заголовке x-admin-password. В ответ и логи он не попадает.
 * DATA_BUCKET — закрытый JSON content/site.json, включая черновики.
 * SITE_BUCKET — фото media/{id}/{имя}.jpg, их отдаёт шлюз вместе с сайтом.
 * STORAGE_ACCESS_KEY_ID и STORAGE_SECRET_ACCESS_KEY — ключ того же сервисного аккаунта.
 * ADMIN_PASSWORD — пароль /admin.
 * LOCAL_ROOT — локальная папка вместо бакетов, только для npm run admin:dev.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONTENT_KEY = "content/site.json";
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const IMAGE_PATTERN = /^media\/([a-z0-9][a-z0-9_-]{0,40})\/([a-z0-9][a-z0-9_-]{0,40})\.jpg$/;

const json = (statusCode, body) => ({
  statusCode,
  isBase64Encoded: false,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  },
  body: JSON.stringify(body),
});

const empty = (statusCode) => ({
  statusCode,
  isBase64Encoded: false,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  },
  body: "",
});

function fail(error) {
  return { ok: false, error };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadDefault() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, "content.default.json"), "utf8"));
    const checked = checkContent(parsed);
    return checked.ok ? checked.value : null;
  } catch {
    return null;
  }
}

function readPayload(event) {
  if (!event || typeof event !== "object") return { error: "bad_json" };
  let raw = event.body;
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  if (event.isBase64Encoded === true) raw = Buffer.from(String(raw), "base64").toString("utf8");
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "bad_json" };
    return parsed;
  } catch {
    return { error: "bad_json" };
  }
}

function header(event, name) {
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? String(headers[key]) : "";
}

function routeOf(event) {
  const route = event?.requestContext?.apiGateway?.operationContext?.route;
  if (route) return String(route);
  const pathName = String(event?.path || event?.url || event?.requestContext?.path || "");
  if (pathName.includes("/api/content")) return "content";
  if (pathName.includes("/api/admin")) return "admin";
  return "";
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD || "";
  const password = String(given ?? "");
  if (!expected || !password || password.length > 200 || expected.length > 200) return false;
  const left = Buffer.from(sha256(expected));
  const right = Buffer.from(sha256(password));
  return crypto.timingSafeEqual(left, right);
}

function cleanLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length > max) return null;
  return text;
}

function cleanRequired(value, max) {
  const text = cleanLine(value, max);
  if (!text) return null;
  return text;
}

function cleanBody(value, max) {
  const text = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (text.length > max) return null;
  return text;
}

function cleanId(value) {
  const text = String(value ?? "").trim();
  if (!ID_PATTERN.test(text)) return "";
  return text;
}

function imageKeyOk(key, productId) {
  if (typeof key !== "string" || key.length > 120) return false;
  const match = IMAGE_PATTERN.exec(key);
  if (!match) return false;
  if (productId && match[1] !== productId) return false;
  return true;
}

function cleanTelegram(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: true, value: "" };
  if (raw.length > 200 || /[\s<>]/.test(raw)) return fail("telegram");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail("telegram");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "t.me" && host !== "telegram.me")) return fail("telegram");
  if (url.username || url.password || url.search || url.hash) return fail("telegram");
  const user = url.pathname.replace(/^\//, "").split("/")[0];
  if (!/^[A-Za-z0-9_]{4,32}$/.test(user)) return fail("telegram");
  return { ok: true, value: `https://t.me/${user}` };
}

function cleanPrice(value) {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value === "boolean") return fail("validation");
  if (typeof value === "string" && value.trim() === "") return { ok: true, value: null };
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < 0 || number > 10000000) return fail("validation");
  return { ok: true, value: number };
}

function compareProducts(a, b) {
  const byOrder = a.order - b.order;
  if (byOrder !== 0) return byOrder;
  const byTitle = a.title.localeCompare(b.title, "ru");
  if (byTitle !== 0) return byTitle;
  return a.id.localeCompare(b.id, "en");
}

function checkCategories(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 12) return fail("validation");
  const categories = [];
  const ids = new Set();
  const slugs = new Set();
  for (const item of input) {
    if (!item || typeof item !== "object") return fail("validation");
    const id = cleanId(item.id);
    const slug = cleanId(item.slug);
    const title = cleanRequired(item.title, 60);
    const line = cleanRequired(item.line, 120);
    if (!id || !slug || !title || !line) return fail("category");
    if (ids.has(id) || slugs.has(slug)) return fail("category");
    ids.add(id);
    slugs.add(slug);
    categories.push({ id, slug, title, line });
  }
  return { ok: true, value: categories };
}

function checkTexts(input) {
  if (!input || typeof input !== "object") return fail("validation");
  const hero = input.hero || {};
  const about = input.about || {};
  const empty = input.empty || {};
  const product = input.product || {};
  const order = input.order || {};
  const kicker = cleanRequired(hero.kicker, 80);
  const line = cleanRequired(hero.line, 200);
  const catalog = cleanRequired(hero.catalog, 40);
  const write = cleanRequired(hero.write, 40);
  const shelf = cleanRequired(input.shelf, 80);
  const orderTitle = cleanRequired(order.title, 80);
  const aboutTitle = cleanRequired(about.title, 80);
  const aboutText = cleanRequired(about.text, 800);
  const emptyFirst = cleanRequired(empty.first, 160);
  const emptySecond = cleanRequired(empty.second, 160);
  const want = cleanRequired(product.want, 40);
  const priceLater = cleanRequired(product.priceLater, 80);
  const more = cleanRequired(product.more, 80);
  if (
    !kicker ||
    !line ||
    !catalog ||
    !write ||
    !shelf ||
    !orderTitle ||
    !aboutTitle ||
    !aboutText ||
    !emptyFirst ||
    !emptySecond ||
    !want ||
    !priceLater ||
    !more
  ) {
    return fail("validation");
  }
  if (!Array.isArray(order.steps) || order.steps.length < 1 || order.steps.length > 6) return fail("validation");
  const steps = [];
  for (const step of order.steps) {
    const text = cleanRequired(step, 160);
    if (!text) return fail("validation");
    steps.push(text);
  }
  return {
    ok: true,
    value: {
      hero: { kicker, line, catalog, write },
      shelf,
      order: { title: orderTitle, steps },
      about: { title: aboutTitle, text: aboutText },
      empty: { first: emptyFirst, second: emptySecond },
      product: { want, priceLater, more },
    },
  };
}

function checkMeta(input) {
  if (!input || typeof input !== "object") return fail("validation");
  const title = cleanRequired(input.title, 120);
  const description = cleanRequired(input.description, 300);
  if (!title || !description) return fail("validation");
  return { ok: true, value: { title, description } };
}

function checkProduct(input, categories) {
  if (!input || typeof input !== "object") return fail("validation");
  const id = cleanId(input.id);
  if (!id) return fail("product_id");
  const title = cleanRequired(input.title, 120);
  if (!title) return fail("product_text");
  const category = cleanId(input.category);
  if (!category || !categories.some((item) => item.id === category)) return fail("category");
  if (typeof input.featured !== "boolean" || typeof input.published !== "boolean") return fail("validation");
  if (!Number.isInteger(input.order) || input.order < 0 || input.order > 9999) return fail("validation");
  const price = cleanPrice(input.price);
  if (!price.ok) return price;
  const summary = input.published ? cleanRequired(input.summary, 240) : cleanLine(input.summary, 240);
  const body = input.published ? cleanBody(input.body, 4000) : cleanBody(input.body, 4000);
  if (summary == null || body == null) return fail("validation");
  if (input.published && (!summary || !body)) return fail("product_text");
  if (!Array.isArray(input.images)) return fail("validation");
  const images = [];
  for (const key of input.images) {
    if (!imageKeyOk(key, id)) return fail("image_key");
    if (!images.includes(key)) images.push(key);
  }
  if (images.length > 8) return fail("validation");
  if (input.published && images.length === 0) return fail("product_images");
  return {
    ok: true,
    value: {
      id,
      title,
      price: price.value,
      category,
      summary: summary || "",
      body: body || "",
      featured: input.featured,
      order: input.order,
      published: input.published,
      images,
    },
  };
}

function checkProducts(input, categories) {
  if (!Array.isArray(input) || input.length > 200) return fail("validation");
  const products = [];
  const ids = new Set();
  for (const item of input) {
    const checked = checkProduct(item, categories);
    if (!checked.ok) return checked;
    if (ids.has(checked.value.id)) return fail("product_id");
    ids.add(checked.value.id);
    products.push(checked.value);
  }
  products.sort(compareProducts);
  return { ok: true, value: products };
}

function checkContent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("validation");
  const telegram = cleanTelegram(input.contacts?.telegram);
  if (!telegram.ok) return telegram;
  const meta = checkMeta(input.meta);
  if (!meta.ok) return meta;
  const texts = checkTexts(input.texts);
  if (!texts.ok) return texts;
  const categories = checkCategories(input.categories);
  if (!categories.ok) return categories;
  const products = checkProducts(input.products, categories.value);
  if (!products.ok) return products;
  return {
    ok: true,
    value: {
      contacts: { telegram: telegram.value },
      meta: meta.value,
      texts: texts.value,
      categories: categories.value,
      products: products.value,
    },
  };
}

function sanitizeContent(input) {
  const checked = checkContent(input);
  return checked.ok ? checked.value : null;
}

function toPublic(content) {
  return {
    contacts: content.contacts,
    meta: content.meta,
    texts: content.texts,
    categories: content.categories,
    products: content.products.filter((product) => product.published),
  };
}

function mergeContent(remote, seed) {
  const base = sanitizeContent(remote);
  const extra = sanitizeContent(seed);
  if (!base || !extra) return { ok: false };
  const categories = base.categories.slice();
  const categoryIds = new Set(categories.map((item) => item.id));
  const slugs = new Set(categories.map((item) => item.slug));
  for (const category of extra.categories) {
    if (categoryIds.has(category.id) || slugs.has(category.slug)) continue;
    categories.push(category);
    categoryIds.add(category.id);
    slugs.add(category.slug);
  }
  const products = base.products.slice();
  const ids = new Set(products.map((item) => item.id));
  for (const product of extra.products) {
    if (ids.has(product.id) || !categoryIds.has(product.category)) continue;
    products.push(product);
    ids.add(product.id);
  }
  const merged = sanitizeContent({
    contacts: base.contacts,
    meta: base.meta,
    texts: base.texts,
    categories,
    products,
  });
  if (!merged) return { ok: false };
  return { ok: true, value: merged, changed: JSON.stringify(merged) !== JSON.stringify(base) };
}

function dataBucket() {
  return process.env.DATA_BUCKET || "";
}

function siteBucket() {
  return process.env.SITE_BUCKET || "";
}

function localFile(objectKey) {
  const root = path.resolve(process.env.LOCAL_ROOT || "");
  const full = path.resolve(root, objectKey);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return "";
  return full;
}

function localS3(method, objectKey) {
  const file = localFile(objectKey);
  if (!file) return { ok: false, status: 400, text: "" };
  if (method === "GET") {
    if (!fs.existsSync(file)) return { ok: false, status: 404, text: "" };
    return { ok: true, status: 200, text: fs.readFileSync(file, "utf8") };
  }
  if (method === "PUT") return { ok: false, status: 500, text: "" };
  if (method === "DELETE") {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true, status: 204, text: "" };
  }
  return { ok: false, status: 405, text: "" };
}

function localPut(objectKey, body) {
  const file = localFile(objectKey);
  if (!file) return { ok: false, status: 400, text: "" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { ok: true, status: 200, text: "" };
}

async function remoteS3(bucket, method, objectKey, { body = "", contentType = "" } = {}) {
  const accessKey = process.env.STORAGE_ACCESS_KEY_ID;
  const secretKey = process.env.STORAGE_SECRET_ACCESS_KEY;
  if (!bucket || !accessKey || !secretKey) return { ok: false, status: 0, text: "" };

  const host = "storage.yandexcloud.net";
  const region = "ru-central1";
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payload = method === "GET" || method === "DELETE" || method === "HEAD" ? "" : body;
  const payloadHash = sha256(payload);
  const encodedKey = objectKey ? objectKey.split("/").map(encodeRfc3986).join("/") : "";
  const canonicalUri = `/${bucket}${encodedKey ? `/${encodedKey}` : ""}`;
  const headerLines = [
    ["host", host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ];
  if (contentType) headerLines.push(["content-type", contentType]);
  headerLines.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonicalHeaders = headerLines.map(([key, value]) => `${key}:${value}\n`).join("");
  const signedHeaders = headerLines.map(([key]) => key).join(";");
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = { Authorization: authorization, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) headers["Content-Type"] = contentType;

  const response = await fetch(`https://${host}${canonicalUri}`, {
    method,
    headers,
    body: payload ? body : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = method === "GET" ? await response.text() : "";
  return { ok: response.ok, status: response.status, text };
}

async function s3(bucket, method, objectKey, options = {}) {
  if (process.env.LOCAL_ROOT) {
    if (method === "PUT") return localPut(objectKey, options.body || "");
    return localS3(method, objectKey);
  }
  return remoteS3(bucket, method, objectKey, options);
}

function presignPut(bucket, objectKey, contentType) {
  if (process.env.LOCAL_ROOT) {
    return {
      url: `/api/media-upload?key=${encodeURIComponent(objectKey)}`,
      headers: { "Content-Type": contentType },
    };
  }
  const accessKey = process.env.STORAGE_ACCESS_KEY_ID;
  const secretKey = process.env.STORAGE_SECRET_ACCESS_KEY;
  if (!bucket || !accessKey || !secretKey) return null;

  const host = "storage.yandexcloud.net";
  const region = "ru-central1";
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${accessKey}/${credentialScope}`;
  const encodedKey = objectKey.split("/").map(encodeRfc3986).join("/");
  const canonicalUri = `/${bucket}/${encodedKey}`;
  const signedHeaders = "content-type;host";
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key])}`)
    .join("&");
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalRequest = ["PUT", canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    headers: { "Content-Type": contentType },
  };
}

async function readContent() {
  const stored = await s3(dataBucket(), "GET", CONTENT_KEY);
  if (stored.status === 404 || (process.env.LOCAL_ROOT && stored.status === 404)) {
    const fallback = loadDefault();
    return fallback ? clone(fallback) : null;
  }
  if (!stored.ok) return null;
  try {
    return sanitizeContent(JSON.parse(stored.text));
  } catch {
    return null;
  }
}

async function writeContent(content) {
  const result = await s3(dataBucket(), "PUT", CONTENT_KEY, {
    body: `${JSON.stringify(content, null, 2)}\n`,
    contentType: "application/json",
  });
  return result.ok;
}

async function handleContent(method) {
  if (method === "OPTIONS") return empty(204);
  if (method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
  const content = await readContent();
  if (!content) return json(502, { ok: false, error: "content_unavailable" });
  return json(200, toPublic(content));
}

async function handleAdmin(event, method) {
  if (method === "OPTIONS") return empty(204);
  if (method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!process.env.ADMIN_PASSWORD) return json(503, { ok: false, error: "not_configured" });
  if (!passwordOk(header(event, "x-admin-password"))) return json(401, { ok: false, error: "unauthorized" });

  const body = readPayload(event);
  if (body.error === "bad_json") return json(400, { ok: false, error: "bad_json" });
  const action = String(body.action || "");
  if (action === "login") return json(200, { ok: true });

  const current = await readContent();
  if (!current) return json(502, { ok: false, error: "content_unavailable" });

  if (action === "load") return json(200, { ok: true, content: current });

  if (action === "save-site") {
    const telegram = cleanTelegram(body.site?.contacts?.telegram);
    if (!telegram.ok) return json(422, { ok: false, error: telegram.error });
    const meta = checkMeta(body.site?.meta);
    if (!meta.ok) return json(422, { ok: false, error: meta.error });
    const texts = checkTexts(body.site?.texts);
    if (!texts.ok) return json(422, { ok: false, error: texts.error });
    const categories = checkCategories(body.site?.categories);
    if (!categories.ok) return json(422, { ok: false, error: categories.error });
    const categoryIds = new Set(categories.value.map((item) => item.id));
    if (current.products.some((product) => !categoryIds.has(product.category))) {
      return json(422, { ok: false, error: "category_in_use" });
    }
    const next = sanitizeContent({
      contacts: { telegram: telegram.value },
      meta: meta.value,
      texts: texts.value,
      categories: categories.value,
      products: current.products,
    });
    if (!next) return json(422, { ok: false, error: "validation" });
    if (!(await writeContent(next))) return json(502, { ok: false, error: "save_failed" });
    return json(200, { ok: true, content: next });
  }

  if (action === "save-product") {
    const checked = checkProduct(body.product, current.categories);
    if (!checked.ok) return json(422, { ok: false, error: checked.error });
    const exists = current.products.some((product) => product.id === checked.value.id);
    if (body.create === true && exists) return json(409, { ok: false, error: "id_taken" });
    if (body.create !== true && !exists) return json(404, { ok: false, error: "not_found" });
    const products = exists
      ? current.products.map((product) => (product.id === checked.value.id ? checked.value : product))
      : current.products.concat(checked.value);
    const next = sanitizeContent({ ...current, products });
    if (!next) return json(422, { ok: false, error: "validation" });
    if (!(await writeContent(next))) return json(502, { ok: false, error: "save_failed" });
    return json(200, { ok: true, content: next });
  }

  if (action === "delete-product") {
    const id = cleanId(body.id);
    const product = current.products.find((item) => item.id === id);
    if (!product) return json(404, { ok: false, error: "not_found" });
    const next = sanitizeContent({
      ...current,
      products: current.products.filter((item) => item.id !== id),
    });
    if (!next) return json(422, { ok: false, error: "validation" });
    if (!(await writeContent(next))) return json(502, { ok: false, error: "save_failed" });
    for (const key of product.images) {
      if (imageKeyOk(key, id)) await s3(siteBucket(), "DELETE", key);
    }
    return json(200, { ok: true, content: next });
  }

  if (action === "sign-upload") {
    const id = cleanId(body.productId);
    const product = current.products.find((item) => item.id === id);
    if (!product) return json(404, { ok: false, error: "not_found" });
    if (product.images.length >= 8) return json(422, { ok: false, error: "validation" });
    const stamp = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString("hex");
    const key = `media/${id}/${stamp}-${rand}.jpg`;
    if (!imageKeyOk(key, id)) return json(422, { ok: false, error: "image_key" });
    const signed = presignPut(siteBucket(), key, "image/jpeg");
    if (!signed) return json(502, { ok: false, error: "save_failed" });
    return json(200, { ok: true, key, url: signed.url, headers: signed.headers });
  }

  if (action === "delete-image") {
    const key = String(body.key || "");
    const match = IMAGE_PATTERN.exec(key);
    if (!match) return json(422, { ok: false, error: "image_key" });
    const product = current.products.find((item) => item.id === match[1]);
    if (!product || !product.images.includes(key)) return json(404, { ok: false, error: "not_found" });
    const images = product.images.filter((item) => item !== key);
    if (product.published && images.length === 0) return json(422, { ok: false, error: "product_images" });
    const next = sanitizeContent({
      ...current,
      products: current.products.map((item) => (item.id === product.id ? { ...item, images } : item)),
    });
    if (!next) return json(422, { ok: false, error: "validation" });
    if (!(await writeContent(next))) return json(502, { ok: false, error: "save_failed" });
    await s3(siteBucket(), "DELETE", key);
    return json(200, { ok: true, content: next });
  }

  return json(422, { ok: false, error: "validation" });
}

module.exports.handler = async function handler(event) {
  const method = String(event?.httpMethod || event?.requestContext?.httpMethod || "GET").toUpperCase();
  const route = routeOf(event);
  if (route === "content") return handleContent(method);
  if (route === "admin") return handleAdmin(event, method);
  return json(404, { ok: false, error: "not_found" });
};

module.exports.checkContent = checkContent;
module.exports.sanitizeContent = sanitizeContent;
module.exports.toPublic = toPublic;
module.exports.mergeContent = mergeContent;
module.exports.imageKeyOk = imageKeyOk;
module.exports.passwordOk = passwordOk;
module.exports.presignPut = presignPut;
module.exports.cleanTelegram = cleanTelegram;
