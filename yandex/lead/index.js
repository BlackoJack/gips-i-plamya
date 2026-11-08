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
const tls = require("tls");

const CONTENT_KEY = "content/site.json";
const NOTIFY_KEY = "content/notify.json";
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const IMAGE_PATTERN = /^media\/([a-z0-9][a-z0-9_-]{0,40})\/([a-z0-9][a-z0-9_-]{0,40})\.jpg$/;
const ORDER_STATUS = new Set(["new", "work", "done", "cancelled"]);

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
  if (pathName.includes("/api/order")) return "order";
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

function addressOf(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(text) || text.length > 120) return "";
  return text;
}

function hostnameOf(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(text) || text.startsWith(".") || text.endsWith(".") || text.includes("..")) return "";
  return text;
}

function cleanWhatsapp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: true, value: "" };
  if (raw.length > 200 || /[\s<>]/.test(raw)) return fail("whatsapp");
  let digits = raw.replace(/\D/g, "");
  if (/^https?:/i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return fail("whatsapp");
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "wa.me" && host !== "api.whatsapp.com")) return fail("whatsapp");
    digits = url.pathname.replace(/\D/g, "");
  }
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length < 10 || digits.length > 15) return fail("whatsapp");
  return { ok: true, value: `https://wa.me/${digits}` };
}

function cleanMax(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: true, value: "" };
  if (raw.length > 200 || /[\s<>]/.test(raw)) return fail("max");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail("max");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "max.ru") return fail("max");
  if (url.username || url.password || url.search || url.hash) return fail("max");
  const pathName = url.pathname.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._-]{2,64}$/.test(pathName)) return fail("max");
  return { ok: true, value: `https://max.ru${pathName}` };
}

function cleanEmail(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: true, value: "" };
  const address = addressOf(raw.replace(/^mailto:/i, ""));
  if (!address) return fail("email");
  return { ok: true, value: address };
}

function checkContacts(input) {
  const source = input && typeof input === "object" ? input : {};
  const telegramRaw = typeof source.telegram === "string" ? source.telegram : source.telegram?.url || "";
  const whatsappRaw = typeof source.whatsapp === "string" ? source.whatsapp : source.whatsapp?.url || source.whatsapp?.label || "";
  const maxRaw = typeof source.max === "string" ? source.max : source.max?.url || "";
  const emailRaw = typeof source.email === "string" ? source.email : source.email?.label || source.email?.url || "";
  const telegram = cleanTelegram(telegramRaw);
  if (!telegram.ok) return telegram;
  const whatsapp = cleanWhatsapp(whatsappRaw);
  if (!whatsapp.ok) return whatsapp;
  const max = cleanMax(maxRaw);
  if (!max.ok) return max;
  const email = cleanEmail(emailRaw);
  if (!email.ok) return email;
  return {
    ok: true,
    value: { telegram: telegram.value, whatsapp: whatsapp.value, max: max.value, email: email.value },
  };
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
  const legacySteps = ["Выбрать изделие", "Написать в Telegram", "Договориться о наличии и получении в переписке"];
  const nextSteps =
    steps.length === legacySteps.length && steps.every((step, index) => step === legacySteps[index])
      ? ["Выбрать изделие", "Положить в корзину", "Оставить контакт — мы ответим"]
      : steps;
  const nextWant = want === "Хочу эту" ? "В корзину" : want;
  const nextEmptySecond = emptySecond === "Напишите — расскажем, что есть сейчас." ? "Загляните позже или оставьте заказ." : emptySecond;
  return {
    ok: true,
    value: {
      hero: { kicker, line, catalog },
      shelf,
      order: { title: orderTitle, steps: nextSteps },
      about: { title: aboutTitle, text: aboutText },
      empty: { first: emptyFirst, second: nextEmptySecond },
      product: { want: nextWant, priceLater, more },
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
  const contacts = checkContacts(input.contacts);
  if (!contacts.ok) return contacts;
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
      contacts: contacts.value,
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

async function remoteS3(bucket, method, objectKey, { body = "", contentType = "", query = null } = {}) {
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
  const canonicalQuery = query
    ? Object.keys(query)
        .sort()
        .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(String(query[key]))}`)
        .join("&")
    : "";
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = { Authorization: authorization, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) headers["Content-Type"] = contentType;

  const response = await fetch(`https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`, {
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

function cleanSmtpPassword(value) {
  return String(value ?? "").replace(/[\s\u00a0]/g, "");
}

function sanitizeNotify(input, previous) {
  const prev = previous && typeof previous === "object" ? previous : {};
  const source = input && typeof input === "object" ? input : {};
  const tokenRaw = String(source.telegramToken ?? "").trim();
  const chatRaw = String(source.telegramChatId ?? "").trim();
  const telegramToken = tokenRaw || String(prev.telegramToken ?? "").trim();
  const telegramChatId = chatRaw || String(prev.telegramChatId ?? "").trim();
  if (telegramToken && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(telegramToken)) return null;
  if (telegramChatId && !/^-?\d{1,20}$/.test(telegramChatId)) return null;
  if (source.mailTo && !addressOf(source.mailTo)) return null;
  if (source.smtpUser && !addressOf(source.smtpUser)) return null;
  if (source.smtpHost && !hostnameOf(source.smtpHost)) return null;
  const smtpPassword = cleanSmtpPassword(source.smtpPassword) || cleanSmtpPassword(prev.smtpPassword);
  if (smtpPassword.length > 200) return null;
  const mailTo = addressOf(source.mailTo) || addressOf(prev.mailTo);
  const smtpUser = addressOf(source.smtpUser) || addressOf(prev.smtpUser);
  const smtpHost = hostnameOf(source.smtpHost) || hostnameOf(prev.smtpHost) || "smtp.yandex.ru";
  if (smtpPassword && (!smtpUser || !mailTo)) return null;
  return { telegramToken, telegramChatId, mailTo, smtpHost, smtpPort: 465, smtpUser, smtpPassword };
}

async function readNotify() {
  const stored = await s3(dataBucket(), "GET", NOTIFY_KEY);
  let saved = {};
  if (stored.ok) {
    try {
      const parsed = JSON.parse(stored.text);
      if (parsed && typeof parsed === "object") saved = parsed;
    } catch {
      saved = {};
    }
  }
  return (
    sanitizeNotify(saved, {}) || {
      telegramToken: "",
      telegramChatId: "",
      mailTo: "",
      smtpHost: "smtp.yandex.ru",
      smtpPort: 465,
      smtpUser: "",
      smtpPassword: "",
    }
  );
}

async function writeNotify(notify) {
  const result = await s3(dataBucket(), "PUT", NOTIFY_KEY, {
    body: `${JSON.stringify(notify, null, 2)}\n`,
    contentType: "application/json",
  });
  return result.ok;
}

function createSession(socket) {
  let buffer = "";
  const queue = [];
  let pending = null;
  const push = (line) => {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(line);
    } else queue.push(line);
  };
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line.length >= 4 && line[3] === " ") push(line);
    }
  });
  return {
    socket,
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    write(line) {
      socket.write(`${line}\r\n`);
    },
  };
}

function openSmtp(host, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({ host, port, servername: host });
    const session = createSession(socket);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("smtp_timeout"));
    }, 8000);
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(session);
    });
  });
}

function expectCode(session, codes) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("smtp_timeout")), 8000);
    session.read().then(
      (line) => {
        clearTimeout(timer);
        const code = Number(String(line).slice(0, 3));
        if (!codes.includes(code)) reject(new Error(`smtp_${code}`));
        else resolve(code);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function encodeSubject(subject) {
  const clean = String(subject).replace(/[\r\n]+/g, " ").trim().slice(0, 180);
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

async function smtpReachable(host, port) {
  let session;
  try {
    session = await openSmtp(host, port);
    await expectCode(session, [220]);
    session.write("QUIT");
    return true;
  } catch {
    return false;
  } finally {
    session?.socket.destroy();
  }
}

async function sendSmtp({ host, port, user, password, to, subject, text }) {
  const from = addressOf(user);
  const recipient = addressOf(to);
  if (!from || !recipient || !hostnameOf(host) || !password) throw new Error("smtp_config");
  const stuffed = String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  const payload = [
    `From: ${from}`,
    `To: ${recipient}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    stuffed,
    ".",
  ].join("\r\n");
  const session = await openSmtp(host, port || 465);
  try {
    await expectCode(session, [220]);
    session.write("EHLO gips");
    await expectCode(session, [250]);
    session.write("AUTH LOGIN");
    await expectCode(session, [334]);
    session.write(Buffer.from(from).toString("base64"));
    await expectCode(session, [334]);
    session.write(Buffer.from(String(password)).toString("base64"));
    await expectCode(session, [235]);
    session.write(`MAIL FROM:<${from}>`);
    await expectCode(session, [250]);
    session.write(`RCPT TO:<${recipient}>`);
    await expectCode(session, [250, 251]);
    session.write("DATA");
    await expectCode(session, [354]);
    session.socket.write(`${payload}\r\n`);
    await expectCode(session, [250]);
    session.write("QUIT");
    await expectCode(session, [221]);
  } finally {
    session.socket.destroy();
  }
}

function smtpErrorCode(error) {
  const message = String(error?.message || "");
  if (/^smtp_\d{3}$/.test(message) || message === "smtp_timeout" || message === "smtp_config") return message;
  return "smtp_failed";
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

async function sendTelegram(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(4000),
  });
  return response.ok;
}

function orderKeyOk(key) {
  return typeof key === "string" && /^orders\/[1-9][0-9]{3,5}\.json$/.test(key);
}

function listOrderKeys(xml) {
  const keys = [];
  const pattern = /<Key>([^<]+)<\/Key>/g;
  let match = pattern.exec(xml);
  while (match) {
    const key = match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (orderKeyOk(key)) keys.push(key);
    match = pattern.exec(xml);
  }
  return keys;
}

async function orderKeys() {
  if (process.env.LOCAL_ROOT) {
    const dir = localFile("orders");
    if (!dir || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((name) => `orders/${name}`)
      .filter(orderKeyOk);
  }
  const listed = await s3(dataBucket(), "GET", "", { query: { "list-type": "2", prefix: "orders/" } });
  if (!listed.ok) return null;
  return listOrderKeys(listed.text);
}

async function takeOrderNumber() {
  const key = "orders/sequence.json";
  const stored = await s3(dataBucket(), "GET", key);
  let current = 1000;
  if (stored.ok) {
    try {
      const parsed = JSON.parse(stored.text);
      if (Number.isInteger(parsed.n) && parsed.n >= 1000 && parsed.n < 999999) current = parsed.n;
    } catch {
      current = 1000;
    }
  }
  const n = current + 1;
  const written = await s3(dataBucket(), "PUT", key, {
    body: `${JSON.stringify({ n })}\n`,
    contentType: "application/json",
  });
  return written.ok ? n : 0;
}

function moneyLine(price) {
  if (price == null) return "цену напишем";
  return `${new Intl.NumberFormat("ru-RU").format(price)} ₽`;
}

function orderText(order) {
  const lines = order.items.map((item) => {
    const sum = item.price == null ? "цену напишем" : moneyLine(item.price * item.qty);
    return `${item.id}  ${item.title}  ${item.qty} шт  ${item.price == null ? "цену напишем" : moneyLine(item.price)}  ${sum}`;
  });
  return [
    `Заказ ${order.number}`,
    "",
    `Имя: ${order.name}`,
    `Контакт: ${order.contact}`,
    order.note ? `Комментарий: ${order.note}` : "",
    "",
    "Артикул  Название  Количество  Цена  Сумма",
    ...lines,
    "",
    order.total == null ? "Итого: часть цен напишем в переписке" : `Итого: ${moneyLine(order.total)}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function deliverOrder(order) {
  const notify = await readNotify();
  const text = orderText(order);
  const mailConfigured = Boolean(notify?.smtpPassword && notify.smtpUser && notify.mailTo);
  const telegramConfigured = Boolean(notify?.telegramToken && notify.telegramChatId);
  const mail = mailConfigured
    ? withTimeout(
        sendSmtp({
          host: notify.smtpHost,
          port: 465,
          user: notify.smtpUser,
          password: notify.smtpPassword,
          to: notify.mailTo,
          subject: `Заказ ${order.number}`,
          text,
        }).then(() => true),
        9000,
      )
    : Promise.resolve(false);
  const telegram = telegramConfigured
    ? withTimeout(sendTelegram(notify.telegramToken, notify.telegramChatId, text), 4000)
    : Promise.resolve(false);
  const [mailOk, telegramOk] = await Promise.all([mail, telegram]);
  return { mail: mailOk === true, telegram: telegramOk === true, mailConfigured, telegramConfigured };
}

function publicOrder(data, key) {
  return {
    key,
    number: String(data.number || ""),
    name: String(data.name || ""),
    contact: String(data.contact || ""),
    note: String(data.note || ""),
    status: ORDER_STATUS.has(data.status) ? data.status : "new",
    adminNote: String(data.adminNote || "").slice(0, 2000),
    items: Array.isArray(data.items) ? data.items : [],
    total: Number.isInteger(data.total) ? data.total : null,
    at: String(data.at || ""),
    mail: data.mail === true,
    telegram: data.telegram === true,
  };
}

async function listOrders() {
  const keys = await orderKeys();
  if (!keys) return null;
  const newest = keys
    .sort((a, b) => Number(b.replace(/\D/g, "")) - Number(a.replace(/\D/g, "")))
    .slice(0, 40);
  const rows = await Promise.all(
    newest.map(async (key) => {
      const object = await s3(dataBucket(), "GET", key);
      if (!object.ok) return null;
      try {
        return publicOrder(JSON.parse(object.text), key);
      } catch {
        return null;
      }
    }),
  );
  return rows.filter(Boolean);
}

async function handleOrder(event, method) {
  if (method === "OPTIONS") return empty(204);
  if (method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const body = readPayload(event);
  if (body.error === "bad_json") return json(400, { ok: false, error: "bad_json" });
  if (typeof body.company === "string" && body.company.trim() !== "") return json(200, { ok: true });
  const name = cleanRequired(body.name, 80);
  const contact = cleanRequired(body.contact, 120);
  const note = cleanBody(body.note || "", 1000);
  if (!name || name.length < 2 || !contact || contact.length < 5 || note == null) return json(422, { ok: false, error: "validation" });
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) return json(422, { ok: false, error: "validation" });
  const content = await readContent();
  if (!content) return json(502, { ok: false, error: "content_unavailable" });
  const items = [];
  const seen = new Set();
  for (const row of body.items) {
    const id = cleanId(row?.id);
    const qty = Number(row?.qty);
    if (!id || seen.has(id) || !Number.isInteger(qty) || qty < 1 || qty > 20) return json(422, { ok: false, error: "validation" });
    const product = content.products.find((item) => item.id === id && item.published);
    if (!product) return json(422, { ok: false, error: "cart_changed" });
    seen.add(id);
    items.push({ id, title: product.title, qty, price: product.price });
  }
  const priced = items.every((item) => item.price != null);
  const total = priced ? items.reduce((sum, item) => sum + item.price * item.qty, 0) : null;
  const n = await takeOrderNumber();
  if (!n) return json(502, { ok: false, error: "save_failed" });
  const number = `ГП-${n}`;
  const record = {
    number,
    name,
    contact,
    note,
    items,
    total,
    status: "new",
    adminNote: "",
    at: new Date().toISOString(),
  };
  const key = `orders/${n}.json`;
  const saved = await s3(dataBucket(), "PUT", key, {
    body: `${JSON.stringify(record, null, 2)}\n`,
    contentType: "application/json",
  });
  if (!saved.ok) return json(502, { ok: false, error: "save_failed" });
  let delivery = { mail: false, telegram: false, mailConfigured: false, telegramConfigured: false };
  try {
    delivery = await deliverOrder(record);
  } catch {
    delivery = { mail: false, telegram: false, mailConfigured: false, telegramConfigured: false };
  }
  try {
    await s3(dataBucket(), "PUT", key, {
      body: `${JSON.stringify({ ...record, ...delivery }, null, 2)}\n`,
      contentType: "application/json",
    });
  } catch {
    /* заказ уже сохранён */
  }
  return json(200, { ok: true, number, mail: delivery.mail, total, items });
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

  if (action === "load") return json(200, { ok: true, content: current, notify: await readNotify() });

  if (action === "save-site") {
    const contacts = checkContacts(body.site?.contacts);
    if (!contacts.ok) return json(422, { ok: false, error: contacts.error });
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
      contacts: contacts.value,
      meta: meta.value,
      texts: texts.value,
      categories: categories.value,
      products: current.products,
    });
    if (!next) return json(422, { ok: false, error: "validation" });
    const notify = sanitizeNotify(body.notify || {}, await readNotify());
    if (!notify) return json(422, { ok: false, error: "mail" });
    if (!(await writeContent(next))) return json(502, { ok: false, error: "save_failed" });
    if (!(await writeNotify(notify))) return json(502, { ok: false, error: "save_failed" });
    return json(200, { ok: true, content: next, notify });
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

  if (action === "test-mail") {
    const notify = sanitizeNotify(body.notify || {}, await readNotify());
    if (!notify) return json(422, { ok: false, error: "mail" });
    if (!notify.smtpPassword || !notify.smtpUser || !notify.mailTo) {
      const [gmail, yandexMail] = await Promise.all([smtpReachable("smtp.gmail.com", 465), smtpReachable("smtp.yandex.ru", 465)]);
      return json(200, { ok: false, error: "smtp_no_password", gmail, yandex: yandexMail });
    }
    try {
      await sendSmtp({
        host: notify.smtpHost,
        port: 465,
        user: notify.smtpUser,
        password: notify.smtpPassword,
        to: notify.mailTo,
        subject: "Проверка почты с сайта",
        text: "Если это письмо пришло, заказы с сайта «Гипс и пламя» будут приходить сюда.",
      });
      return json(200, { ok: true });
    } catch (error) {
      return json(200, { ok: false, error: smtpErrorCode(error) });
    }
  }

  if (action === "orders") {
    const orders = await listOrders();
    if (!orders) return json(502, { ok: false, error: "orders_unavailable" });
    return json(200, { ok: true, orders });
  }

  if (action === "update-order") {
    if (!orderKeyOk(body.key) || !ORDER_STATUS.has(body.status)) return json(422, { ok: false, error: "validation" });
    const adminNote = cleanBody(body.adminNote ?? "", 2000);
    if (adminNote == null) return json(422, { ok: false, error: "validation" });
    const stored = await s3(dataBucket(), "GET", body.key);
    if (!stored.ok) return json(404, { ok: false, error: "not_found" });
    let data;
    try {
      data = JSON.parse(stored.text);
    } catch {
      return json(422, { ok: false, error: "validation" });
    }
    const next = { ...data, status: body.status, adminNote };
    const written = await s3(dataBucket(), "PUT", body.key, {
      body: `${JSON.stringify(next, null, 2)}\n`,
      contentType: "application/json",
    });
    if (!written.ok) return json(502, { ok: false, error: "save_failed" });
    return json(200, { ok: true, order: publicOrder(next, body.key) });
  }

  if (action === "delete-order") {
    if (!orderKeyOk(body.key)) return json(422, { ok: false, error: "validation" });
    const removed = await s3(dataBucket(), "DELETE", body.key);
    if (!removed.ok && removed.status !== 404) return json(502, { ok: false, error: "save_failed" });
    return json(200, { ok: true });
  }

  return json(422, { ok: false, error: "validation" });
}

module.exports.handler = async function handler(event) {
  const method = String(event?.httpMethod || event?.requestContext?.httpMethod || "GET").toUpperCase();
  const route = routeOf(event);
  if (route === "content") return handleContent(method);
  if (route === "admin") return handleAdmin(event, method);
  if (route === "order") return handleOrder(event, method);
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
