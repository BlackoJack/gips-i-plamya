const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  handler,
  sanitizeContent,
  toPublic,
  mergeContent,
  imageKeyOk,
  passwordOk,
  presignPut,
  cleanTelegram,
} = require("./index.js");

const repo = path.resolve(__dirname, "../..");

function draftFrom(seed) {
  return {
    contacts: { ...seed.contacts },
    meta: { ...seed.meta },
    texts: JSON.parse(JSON.stringify(seed.texts)),
    categories: seed.categories.map((item) => ({ ...item })),
    products: seed.products.map((item) => ({ ...item, images: [...item.images] })),
  };
}

test("сид из репозитория публикует только готовые изделия", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gips-seed-"));
  const out = path.join(dir, "content.json");
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/seed-content.ts", "--out", out], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const seed = JSON.parse(fs.readFileSync(out, "utf8"));
  const checked = sanitizeContent(seed);
  assert.ok(checked);
  assert.deepEqual(checked.products, []);
  assert.equal(checked.contacts.telegram, "");
  assert.equal(checked.contacts.whatsapp, "");
  assert.equal(checked.contacts.email, "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("пустой telegram допустим, чужой адрес нет", () => {
  assert.equal(cleanTelegram("").value, "");
  assert.equal(cleanTelegram("https://t.me/gips_plamya").value, "https://t.me/gips_plamya");
  assert.equal(cleanTelegram("https://example.com/gips").ok, false);
  assert.equal(cleanTelegram("https://t.me/gips?text=hi").ok, false);
});

test("ключ фото остаётся внутри своего изделия", () => {
  assert.equal(imageKeyOk("media/nabor_1/1.jpg", "nabor_1"), true);
  assert.equal(imageKeyOk("media/nabor_1/../svecha_1/1.jpg", "nabor_1"), false);
  assert.equal(imageKeyOk("media/svecha_1/1.jpg", "nabor_1"), false);
});

test("слияние добавляет новый id и не затирает цену", () => {
  const seed = sanitizeContent(JSON.parse(fs.readFileSync(path.join(__dirname, "content.default.json"), "utf8")));
  const remote = draftFrom(seed);
  remote.products.push({
    id: "vaza-1",
    title: "Уже в админке",
    price: 1900,
    category: "vases",
    summary: "Строка",
    body: "Описание вещи.",
    featured: true,
    order: 1,
    published: true,
    images: ["media/vaza-1/1.jpg"],
  });
  const extra = draftFrom(seed);
  extra.products.push({
    id: "vaza-2",
    title: "Новая ваза",
    price: 500,
    category: "vases",
    summary: "",
    body: "",
    featured: false,
    order: 2,
    published: false,
    images: ["media/vaza-2/1.jpg"],
  });
  const merged = mergeContent(remote, extra);
  assert.equal(merged.ok, true);
  assert.equal(merged.changed, true);
  const kept = merged.value.products.find((item) => item.id === remote.products[0].id);
  assert.equal(kept.price, 1900);
  assert.equal(kept.title, "Уже в админке");
  assert.ok(merged.value.products.some((item) => item.id === "vaza-2"));
  assert.equal(mergeContent(merged.value, extra).changed, false);
});

test("пароль сравнивается целиком, префикс не подходит", () => {
  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "secret-secret";
  assert.equal(passwordOk("secret-secret"), true);
  assert.equal(passwordOk("secret-secreT"), false);
  assert.equal(passwordOk(""), false);
  if (previous == null) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previous;
});

test("подпись загрузки указывает на бакет сайта", () => {
  const previous = {
    root: process.env.LOCAL_ROOT,
    id: process.env.STORAGE_ACCESS_KEY_ID,
    secret: process.env.STORAGE_SECRET_ACCESS_KEY,
  };
  delete process.env.LOCAL_ROOT;
  process.env.STORAGE_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.STORAGE_SECRET_ACCESS_KEY = "secret";
  const signed = presignPut("gips-bucket", "media/nabor_1/1.jpg", "image/jpeg");
  assert.match(signed.url, /^https:\/\/storage\.yandexcloud\.net\/gips-bucket\/media\/nabor_1\/1\.jpg\?/);
  assert.match(signed.url, /X-Amz-Signature=[0-9a-f]+$/);
  assert.equal(signed.headers["Content-Type"], "image/jpeg");
  if (previous.root == null) delete process.env.LOCAL_ROOT;
  else process.env.LOCAL_ROOT = previous.root;
  if (previous.id == null) delete process.env.STORAGE_ACCESS_KEY_ID;
  else process.env.STORAGE_ACCESS_KEY_ID = previous.id;
  if (previous.secret == null) delete process.env.STORAGE_SECRET_ACCESS_KEY;
  else process.env.STORAGE_SECRET_ACCESS_KEY = previous.secret;
});

test("админка прячет черновик и не даёт снять полку с изделиями", async () => {
  const previous = {
    root: process.env.LOCAL_ROOT,
    password: process.env.ADMIN_PASSWORD,
    data: process.env.DATA_BUCKET,
    site: process.env.SITE_BUCKET,
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "gips-admin-"));
  process.env.LOCAL_ROOT = folder;
  process.env.ADMIN_PASSWORD = "test-password-1";
  process.env.DATA_BUCKET = "data";
  process.env.SITE_BUCKET = "site";
  try {
    const call = (method, route, body, password) =>
      handler({
        httpMethod: method,
        headers: password ? { "x-admin-password": password } : {},
        body: body ? JSON.stringify(body) : "",
        path: route === "content" ? "/api/content" : "/api/admin",
        requestContext: { apiGateway: { operationContext: { route } } },
      });

    const denied = await call("POST", "admin", { action: "login" }, "nope");
    assert.equal(denied.statusCode, 401);

    const created = await call(
      "POST",
      "admin",
      {
        action: "save-product",
        create: true,
        product: {
          id: "chernovik",
          title: "Черновик",
          price: null,
          category: "vases",
          summary: "",
          body: "",
          featured: false,
          order: 50,
          published: false,
          images: [],
        },
      },
      "test-password-1",
    );
    assert.equal(created.statusCode, 200, created.body);
    const pub = await call("GET", "content");
    const visible = JSON.parse(pub.body);
    assert.equal(visible.products.some((item) => item.id === "chernovik"), false);

    const loaded = JSON.parse((await call("POST", "admin", { action: "load" }, "test-password-1")).body);
    assert.equal(loaded.content.products.some((item) => item.id === "chernovik"), true);

    const published = await call(
      "POST",
      "admin",
      {
        action: "save-product",
        product: { ...loaded.content.products.find((item) => item.id === "chernovik"), published: true, summary: "Строка", body: "Текст" },
      },
      "test-password-1",
    );
    assert.equal(published.statusCode, 422);
    assert.equal(JSON.parse(published.body).error, "product_images");

    const site = loaded.content;
    const removed = await call(
      "POST",
      "admin",
      {
        action: "save-site",
        site: {
          contacts: site.contacts,
          meta: site.meta,
          texts: site.texts,
          categories: site.categories.filter((item) => item.id !== "vases"),
        },
      },
      "test-password-1",
    );
    assert.equal(removed.statusCode, 422);
    assert.equal(JSON.parse(removed.body).error, "category_in_use");
  } finally {
    for (const [key, value] of Object.entries({
      LOCAL_ROOT: previous.root,
      ADMIN_PASSWORD: previous.password,
      DATA_BUCKET: previous.data,
      SITE_BUCKET: previous.site,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("заказ получает номер и остаётся в админке", async () => {
  const previous = {
    root: process.env.LOCAL_ROOT,
    password: process.env.ADMIN_PASSWORD,
    data: process.env.DATA_BUCKET,
    site: process.env.SITE_BUCKET,
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "gips-order-"));
  process.env.LOCAL_ROOT = folder;
  process.env.ADMIN_PASSWORD = "test-password-1";
  process.env.DATA_BUCKET = "data";
  process.env.SITE_BUCKET = "site";
  try {
    const call = (method, route, body, password) =>
      handler({
        httpMethod: method,
        headers: password ? { "x-admin-password": password } : {},
        body: body ? JSON.stringify(body) : "",
        path: `/api/${route}`,
        requestContext: { apiGateway: { operationContext: { route } } },
      });
    const saved = await call(
      "POST",
      "admin",
      {
        action: "save-product",
        create: true,
        product: {
          id: "vaza-12",
          title: "Ваза",
          price: 1200,
          category: "vases",
          summary: "Для цветов",
          body: "Гипсовая ваза.",
          featured: false,
          order: 1,
          published: true,
          images: ["media/vaza-12/1.jpg"],
        },
      },
      "test-password-1",
    );
    assert.equal(saved.statusCode, 200, saved.body);
    const ordered = await call("POST", "order", {
      name: "Анна",
      contact: "+7 913 000-00-00",
      note: "Самовывоз",
      items: [{ id: "vaza-12", qty: 2 }],
    });
    assert.equal(ordered.statusCode, 200, ordered.body);
    const receipt = JSON.parse(ordered.body);
    assert.equal(receipt.number, "ГП-1001");
    assert.equal(receipt.total, 2400);
    assert.equal(receipt.mail, false);
    const listed = JSON.parse((await call("POST", "admin", { action: "orders" }, "test-password-1")).body);
    assert.equal(listed.orders[0].number, "ГП-1001");
    assert.equal(listed.orders[0].contact, "+7 913 000-00-00");
    assert.equal(listed.orders[0].status, "new");
    assert.equal(listed.orders[0].adminNote, "");
    assert.equal(listed.orders[0].items[0].id, "vaza-12");
    const updated = JSON.parse(
      (
        await call(
          "POST",
          "admin",
          { action: "update-order", key: "orders/1001.json", status: "work", adminNote: "Позвонить после 18" },
          "test-password-1",
        )
      ).body,
    );
    assert.equal(updated.ok, true);
    assert.equal(updated.order.status, "work");
    assert.equal(updated.order.adminNote, "Позвонить после 18");
    assert.equal(updated.order.note, "Самовывоз");
    const again = JSON.parse((await call("POST", "admin", { action: "orders" }, "test-password-1")).body);
    assert.equal(again.orders[0].status, "work");
    const rejected = await call(
      "POST",
      "admin",
      { action: "update-order", key: "orders/1001.json", status: "lost", adminNote: "" },
      "test-password-1",
    );
    assert.equal(rejected.statusCode, 422);
  } finally {
    for (const [key, value] of Object.entries({
      LOCAL_ROOT: previous.root,
      ADMIN_PASSWORD: previous.password,
      DATA_BUCKET: previous.data,
      SITE_BUCKET: previous.site,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
