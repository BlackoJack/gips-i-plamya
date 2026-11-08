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
  assert.equal(checked.contacts.telegramGroup, "");
  assert.equal(checked.contacts.maxGroup, "");
  assert.equal(checked.contacts.whatsappGroup, "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("группа принимается только своей ссылкой", () => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "content.default.json"), "utf8"));
  seed.contacts.telegramGroup = "https://t.me/+Abcd1234";
  seed.contacts.maxGroup = "https://max.ru/join/workshop";
  seed.contacts.whatsappGroup = "https://chat.whatsapp.com/Abcd123456";
  const saved = sanitizeContent(seed);
  assert.equal(saved.contacts.telegramGroup, "https://t.me/+Abcd1234");
  assert.equal(saved.contacts.maxGroup, "https://max.ru/join/workshop");
  assert.equal(saved.contacts.whatsappGroup, "https://chat.whatsapp.com/Abcd123456");
  seed.contacts.whatsappGroup = "https://wa.me/79130000000";
  assert.equal(sanitizeContent(seed), null);
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
  remote.popups = [
    {
      id: "vesna",
      enabled: true,
      title: "Весна",
      text: "Скидка на вазы.",
      kind: "discount",
      mode: "percent",
      value: 10,
      gift: "",
      code: "VESNA",
      pages: ["home"],
      delay: 2,
      repeat: "once",
    },
  ];
  const merged = mergeContent(remote, extra);
  assert.equal(merged.ok, true);
  assert.equal(merged.changed, true);
  const kept = merged.value.products.find((item) => item.id === remote.products[0].id);
  assert.equal(kept.price, 1900);
  assert.equal(kept.title, "Уже в админке");
  assert.equal(merged.value.popups[0].code, "VESNA");
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
    assert.equal(updated.order.items[0].qty, 2);
    assert.equal(updated.order.total, 2400);
    const resized = JSON.parse(
      (
        await call(
          "POST",
          "admin",
          {
            action: "update-order",
            key: "orders/1001.json",
            status: "work",
            adminNote: "Позвонить после 18",
            items: [{ id: "vaza-12", qty: 1 }],
          },
          "test-password-1",
        )
      ).body,
    );
    assert.equal(resized.order.items.length, 1);
    assert.equal(resized.order.items[0].qty, 1);
    assert.equal(resized.order.total, 1200);
    const emptied = await call(
      "POST",
      "admin",
      { action: "update-order", key: "orders/1001.json", status: "work", adminNote: "", items: [] },
      "test-password-1",
    );
    assert.equal(emptied.statusCode, 422);
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

test("окно даёт скидку на сервере и не публикует выключенное", async () => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "content.default.json"), "utf8"));
  assert.equal(sanitizeContent(seed).popups.length, 0);
  const previous = {
    root: process.env.LOCAL_ROOT,
    password: process.env.ADMIN_PASSWORD,
    data: process.env.DATA_BUCKET,
    site: process.env.SITE_BUCKET,
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "gips-popup-"));
  process.env.LOCAL_ROOT = folder;
  process.env.ADMIN_PASSWORD = "test-password-1";
  process.env.DATA_BUCKET = "data";
  process.env.SITE_BUCKET = "site";
  const popup = {
    id: "vesna",
    enabled: true,
    title: "Весна",
    text: "Десять процентов на этот заказ.",
    kind: "discount",
    mode: "percent",
    value: 10,
    gift: "",
    code: "vesna",
    pages: ["home", "cart"],
    delay: 1,
    repeat: "once",
  };
  try {
    const call = (method, route, body, password) =>
      handler({
        httpMethod: method,
        headers: password ? { "x-admin-password": password } : {},
        body: body ? JSON.stringify(body) : "",
        path: `/api/${route}`,
        requestContext: { apiGateway: { operationContext: { route } } },
      });
    const product = await call(
      "POST",
      "admin",
      {
        action: "save-product",
        create: true,
        product: {
          id: "vaza-12",
          title: "Ваза",
          price: 1000,
          category: "vases",
          summary: "Для цветов",
          body: "Гипсовая ваза.",
          featured: true,
          order: 1,
          published: true,
          images: ["media/vaza-12/1.jpg"],
        },
      },
      "test-password-1",
    );
    assert.equal(product.statusCode, 200, product.body);
    const saved = await call("POST", "admin", { action: "save-popup", create: true, popup }, "test-password-1");
    assert.equal(saved.statusCode, 200, saved.body);
    const steep = await call(
      "POST",
      "admin",
      { action: "save-popup", popup: { ...popup, value: 90 } },
      "test-password-1",
    );
    assert.equal(steep.statusCode, 422);
    assert.equal(JSON.parse(steep.body).error, "popup_discount");
    const hidden = await call(
      "POST",
      "admin",
      {
        action: "save-popup",
        create: true,
        popup: { ...popup, id: "draft", enabled: false, code: "DRAFT1", title: "Черновик" },
      },
      "test-password-1",
    );
    assert.equal(hidden.statusCode, 200, hidden.body);
    const visible = JSON.parse((await call("GET", "content")).body);
    assert.deepEqual(
      visible.popups.map((item) => item.id),
      ["vesna"],
    );
    assert.equal(visible.popups[0].code, "VESNA");
    const ordered = JSON.parse(
      (
        await call("POST", "order", {
          name: "Анна",
          contact: "+7 913 000-00-00",
          note: "",
          offer: "vesna",
          items: [{ id: "vaza-12", qty: 2 }],
        })
      ).body,
    );
    assert.equal(ordered.total, 1800);
    assert.equal(ordered.offer.off, 200);
    assert.equal(ordered.offer.value, 10);
    const forged = JSON.parse(
      (
        await call("POST", "order", {
          name: "Анна",
          contact: "+7 913 000-00-00",
          note: "",
          offer: { code: "VESNA", value: 90 },
          items: [{ id: "vaza-12", qty: 1 }],
        })
      ).body,
    );
    assert.equal(forged.total, 1000);
    assert.equal(forged.offer, null);
    const gift = await call(
      "POST",
      "admin",
      {
        action: "save-popup",
        create: true,
        popup: {
          id: "svecha",
          enabled: true,
          title: "Свеча в подарок",
          text: "К заказу приложим маленькую свечу.",
          kind: "gift",
          mode: "",
          value: 0,
          gift: "маленькая свеча",
          code: "GIFT",
          pages: ["cart"],
          delay: 0,
          repeat: "visit",
        },
      },
      "test-password-1",
    );
    assert.equal(gift.statusCode, 200, gift.body);
    const withGift = JSON.parse(
      (
        await call("POST", "order", {
          name: "Анна",
          contact: "+7 913 000-00-00",
          note: "",
          offer: "gift",
          items: [{ id: "vaza-12", qty: 1 }],
        })
      ).body,
    );
    assert.equal(withGift.total, 1000);
    assert.equal(withGift.offer.kind, "gift");
    assert.equal(withGift.offer.gift, "маленькая свеча");
    const listed = JSON.parse((await call("POST", "admin", { action: "orders" }, "test-password-1")).body);
    const stored = listed.orders.find((order) => order.number === withGift.number);
    const resized = JSON.parse(
      (
        await call(
          "POST",
          "admin",
          {
            action: "update-order",
            key: stored.key,
            status: "work",
            adminNote: "",
            items: [{ id: "vaza-12", qty: 2 }],
          },
          "test-password-1",
        )
      ).body,
    );
    assert.equal(resized.order.total, 2000);
    assert.equal(resized.order.offer.gift, "маленькая свеча");
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

test("один контакт не получает бонус окна второй раз", async () => {
  const previous = {
    root: process.env.LOCAL_ROOT,
    password: process.env.ADMIN_PASSWORD,
    data: process.env.DATA_BUCKET,
    site: process.env.SITE_BUCKET,
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "gips-offer-"));
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
    const product = await call(
      "POST",
      "admin",
      {
        action: "save-product",
        create: true,
        product: {
          id: "vaza-12",
          title: "Ваза",
          price: 1000,
          category: "vases",
          summary: "Для цветов",
          body: "Гипсовая ваза.",
          featured: true,
          order: 1,
          published: true,
          images: ["media/vaza-12/1.jpg"],
        },
      },
      "test-password-1",
    );
    assert.equal(product.statusCode, 200, product.body);
    const popup = await call(
      "POST",
      "admin",
      {
        action: "save-popup",
        create: true,
        popup: {
          id: "vesna",
          enabled: true,
          title: "Весна",
          text: "Десять процентов на этот заказ.",
          kind: "discount",
          mode: "percent",
          value: 10,
          gift: "",
          code: "VESNA",
          pages: ["cart"],
          delay: 0,
          repeat: "once",
        },
      },
      "test-password-1",
    );
    assert.equal(popup.statusCode, 200, popup.body);
    const order = (contact, offer) =>
      call("POST", "order", {
        name: "Анна",
        contact,
        note: "",
        offer,
        items: [{ id: "vaza-12", qty: 1 }],
      });
    const first = JSON.parse((await order("+7 913 000-00-00", "vesna")).body);
    assert.equal(first.number, "ГП-1001");
    assert.equal(first.total, 900);
    const again = await order("8 (913) 000-00-00", "VESNA");
    assert.equal(again.statusCode, 422);
    assert.equal(JSON.parse(again.body).error, "offer_used");
    const listed = JSON.parse((await call("POST", "admin", { action: "orders" }, "test-password-1")).body);
    assert.equal(listed.orders.length, 1);
    const plain = JSON.parse((await order("тел. 89130000000", "")).body);
    assert.equal(plain.number, "ГП-1002");
    assert.equal(plain.total, 1000);
    assert.equal(plain.offer, null);
    const other = JSON.parse((await order("anna@mail.ru", "vesna")).body);
    assert.equal(other.total, 900);
    const sameMail = await order("Anna@Mail.ru", "vesna");
    assert.equal(sameMail.statusCode, 422);
    assert.equal(JSON.parse(sameMail.body).error, "offer_used");
    const cancelled = await call(
      "POST",
      "admin",
      { action: "update-order", key: "orders/1001.json", status: "cancelled", adminNote: "" },
      "test-password-1",
    );
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const afterCancel = JSON.parse((await order("89130000000", "vesna")).body);
    assert.equal(afterCancel.total, 900);
    assert.equal(afterCancel.offer.code, "VESNA");
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
