#!/usr/bin/env bash
# Сайт в Object Storage, каталог и админка — Cloud Function, оба на одном API Gateway.
# Нужны: yc init, привязанный платёжный аккаунт и ADMIN_PASSWORD в .env.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! command -v yc >/dev/null 2>&1; then
  echo "Не найден yc. Поставьте CLI и войдите в облако:"
  echo "  https://yandex.cloud/ru/docs/cli/quickstart"
  echo "  yc init"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Нужен node, чтобы собрать сайт."
  exit 1
fi

folder_id="$(yc config get folder-id 2>/dev/null || true)"
if [[ -z "$folder_id" ]]; then
  echo "Каталог не выбран. Выполните: yc init"
  exit 1
fi

if [[ ! -f .env ]]; then
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "Нет .env"
    exit 1
  fi
  touch .env
fi

read_env() {
  local line val
  line="$(grep -E "^${1}=" .env | tail -n 1 || true)"
  val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  printf "%s" "$val"
}

admin_password="$(read_env ADMIN_PASSWORD)"
if [[ -z "$admin_password" ]]; then
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "Нет ADMIN_PASSWORD"
    exit 1
  fi
  admin_password="$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)"
  printf '\nADMIN_PASSWORD=%s\n' "$admin_password" >> .env
  echo "В .env записан ADMIN_PASSWORD. Откройте файл, чтобы войти в админку."
fi

if [[ "$admin_password" == *$'\n'* || "$admin_password" == *'"'* ]]; then
  echo "ADMIN_PASSWORD не должен содержать кавычки и переносы строки."
  exit 1
fi

json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const value = process.argv[1].split(".").reduce((obj, key) => obj?.[key], JSON.parse(s));
      if (value == null || value === "") process.exit(1);
      process.stdout.write(String(value));
    });
  ' "$1"
}

exists() {
  "$@" >/dev/null 2>&1
}

sa_name="gips-gateway"
fn_name="gips-site"
gw_name="gips"
bucket="gips-${folder_id}"
data_bucket="gips-data-${folder_id}"

if exists yc iam service-account get --name "$sa_name"; then
  sa_id="$(yc iam service-account get --name "$sa_name" --format json | json_field id)"
else
  echo "Сервисный аккаунт $sa_name"
  sa_id="$(yc iam service-account create --name "$sa_name" --format json | json_field id)"
fi

if exists yc storage bucket get "$bucket"; then
  echo "Бакет $bucket уже есть"
else
  echo "Бакет $bucket"
  yc storage bucket create --name "$bucket" >/dev/null
fi

if exists yc storage bucket get "$data_bucket"; then
  echo "Бакет каталога уже есть"
else
  echo "Бакет каталога $data_bucket"
  yc storage bucket create --name "$data_bucket" >/dev/null
fi

if exists yc serverless function get --name "$fn_name"; then
  function_id="$(yc serverless function get --name "$fn_name" --format json | json_field id)"
else
  echo "Функция $fn_name"
  function_id="$(yc serverless function create --name "$fn_name" --format json | json_field id)"
fi

has_folder_role() {
  yc resource-manager folder list-access-bindings --id "$folder_id" --format json | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const role = process.argv[1];
      const id = process.argv[2];
      const list = JSON.parse(s);
      const ok = list.some((binding) => (binding.role_id || binding.role) === role && binding.subject && binding.subject.id === id);
      process.exit(ok ? 0 : 1);
    });
  ' "$1" "$sa_id"
}

echo "Права сервисного аккаунта"
if ! has_folder_role storage.editor; then
  yc resource-manager folder add-access-binding --id "$folder_id" --role storage.editor --service-account-id "$sa_id" >/dev/null
fi
if ! yc serverless function list-access-bindings --name "$fn_name" --format json | grep -q "$sa_id"; then
  yc serverless function add-access-binding --name "$fn_name" --role functions.functionInvoker --service-account-id "$sa_id" >/dev/null
fi

key_file="$root/yandex/.storage-key"
if [[ ! -f "$key_file" ]]; then
  echo "Ключ доступа к бакетам"
  yc iam access-key create --service-account-id "$sa_id" --format json >"$key_file"
  chmod 600 "$key_file"
fi
access_key="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.access_key.key_id)' "$key_file")"
secret_key="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.secret)' "$key_file")"

echo "Сид каталога"
node --experimental-strip-types scripts/seed-content.ts

echo "Версия функции"
yc serverless function version create \
  --function-name "$fn_name" \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 15s \
  --source-path "$root/yandex/lead" \
  --service-account-id "$sa_id" \
  --environment "DATA_BUCKET=${data_bucket}" \
  --environment "SITE_BUCKET=${bucket}" \
  --environment "STORAGE_ACCESS_KEY_ID=${access_key}" \
  --environment "STORAGE_SECRET_ACCESS_KEY=${secret_key}" \
  --environment "ADMIN_PASSWORD=${admin_password}" \
  >/dev/null

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if exists yc storage s3api head-object --bucket "$data_bucket" --key content/site.json; then
  echo "Сверяю каталог с репозиторием"
  yc storage s3 cp "s3://${data_bucket}/content/site.json" "$tmp/remote.json" --quiet
  status="$(node scripts/merge-seed.mjs "$tmp/remote.json" "$tmp/merged.json")"
  if [[ "$status" == "changed" ]]; then
    yc storage s3 cp "$tmp/merged.json" "s3://${data_bucket}/content/site.json" --content-type "application/json" --quiet
  elif [[ "$status" != "same" && "$status" != "keep" ]]; then
    echo "Не удалось сверить каталог"
    exit 1
  fi
else
  echo "Начальный каталог"
  yc storage s3 cp "$root/yandex/lead/content.default.json" "s3://${data_bucket}/content/site.json" --content-type "application/json" --quiet
fi

node --experimental-strip-types scripts/seed-content.ts --list-images >"$tmp/images.tsv"
if [[ -s "$tmp/images.tsv" ]]; then
  echo "Фото изделий, которых ещё нет в бакете"
  while IFS=$'\t' read -r id file; do
    [[ -z "${id:-}" ]] && continue
    if [[ ! "$id" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ || ! "$file" =~ ^[a-z0-9][a-z0-9_-]{0,40}\.jpg$ ]]; then
      echo "Странное фото ${id}/${file}"
      exit 1
    fi
    key="media/${id}/${file}"
    src="$root/src/content/products/${id}/${file}"
    if [[ ! -f "$src" ]]; then
      echo "Нет файла $src"
      exit 1
    fi
    if exists yc storage s3api head-object --bucket "$bucket" --key "$key"; then
      continue
    fi
    yc storage s3 cp "$src" "s3://${bucket}/${key}" --content-type "image/jpeg" --quiet
  done <"$tmp/images.tsv"
fi

spec="$root/yandex/.apigw.yaml"
sed \
  -e "s/__BUCKET__/${bucket}/g" \
  -e "s/__FUNCTION_ID__/${function_id}/g" \
  -e "s/__SA_ID__/${sa_id}/g" \
  "$root/yandex/apigw.template.yaml" >"$spec"

if exists yc serverless api-gateway get --name "$gw_name"; then
  echo "Обновляю API Gateway"
  yc serverless api-gateway update --name "$gw_name" --spec "$spec" >/dev/null
else
  echo "Создаю API Gateway"
  yc serverless api-gateway create --name "$gw_name" --spec "$spec" >/dev/null
fi

domain="$(yc serverless api-gateway get --name "$gw_name" --format json | json_field domain)"
site_url="https://${domain}"

yc storage bucket update --name "$bucket" --cors \
  "allowed-methods=[method-put,method-get,method-head],allowed-origins=[${site_url}],allowed-headers=[*],expose-headers=[ETag],max-age-seconds=3600" \
  >/dev/null

if [[ "${SKIP_SITE:-}" == "1" ]]; then
  echo
  echo "Сайт: ${site_url}"
  echo "Админка: ${site_url}/admin"
  exit 0
fi

echo "Сборка сайта для ${site_url}"
SITE_URL="$site_url" BASE_PATH=/ npm run build

content_type() {
  case "$1" in
    *.html) echo "text/html; charset=utf-8" ;;
    *.css) echo "text/css; charset=utf-8" ;;
    *.js|*.mjs) echo "text/javascript; charset=utf-8" ;;
    *.svg) echo "image/svg+xml" ;;
    *.png) echo "image/png" ;;
    *.jpg|*.jpeg) echo "image/jpeg" ;;
    *.webp) echo "image/webp" ;;
    *.woff2) echo "font/woff2" ;;
    *.xml) echo "application/xml" ;;
    *.txt|*.nojekyll) echo "text/plain; charset=utf-8" ;;
    *) echo "application/octet-stream" ;;
  esac
}

echo "Заливаю dist/ в бакет"
# Шлюз не подставляет index.html сам, поэтому страницу каталога кладём и как katalog/index.html, и как katalog.
while IFS= read -r -d '' file; do
  rel="${file#"$root/dist"/}"
  yc storage s3 cp "$file" "s3://${bucket}/${rel}" --content-type "$(content_type "$rel")" --quiet
  if [[ "$rel" == */index.html ]]; then
    parent="${rel%/index.html}"
    yc storage s3 cp "$file" "s3://${bucket}/${parent}" --content-type "text/html; charset=utf-8" --quiet
  fi
done < <(find "$root/dist" -type f -print0)

mkdir -p "$root/yandex"
cat >"$root/yandex/.state" <<EOF
BUCKET=${bucket}
DATA_BUCKET=${data_bucket}
FUNCTION_ID=${function_id}
SA_ID=${sa_id}
DOMAIN=${domain}
EOF

echo
echo "Сайт: ${site_url}"
echo "Админка: ${site_url}/admin"
