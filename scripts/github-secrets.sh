#!/usr/bin/env bash
# Кладёт локальные ключи в секреты GitHub. Значения не печатает.
# Перед запуском: gh auth login -h github.com и один локальный deploy:yandex.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI не вошёл в аккаунт. Выполните: gh auth login -h github.com"
  exit 1
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

for file in yandex/.ci-key.json yandex/.storage-key .env; do
  if [[ ! -f "$file" ]]; then
    echo "Нет файла $file"
    exit 1
  fi
done

folder_id="$(yc config get folder-id)"
admin_password="$(read_env ADMIN_PASSWORD)"

if [[ -z "$folder_id" || -z "$admin_password" ]]; then
  echo "Пустой каталог yc или ADMIN_PASSWORD в .env."
  exit 1
fi

gh secret set YC_SA_JSON < yandex/.ci-key.json
gh secret set YC_STORAGE_KEY < yandex/.storage-key
gh secret set YC_FOLDER_ID --body "$folder_id"
gh secret set ADMIN_PASSWORD --body "$admin_password"

echo "Секреты записаны: YC_SA_JSON, YC_STORAGE_KEY, YC_FOLDER_ID, ADMIN_PASSWORD"
