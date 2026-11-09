#!/usr/bin/env sh
# Выдаёт сервисным ролям вход и пароли из .env (после миграций). Пароли в репозиторий не попадают.
set -eu
for role in $(psql "$DATABASE_URL" -Atc "select rolname from pg_roles where rolname like 'svc_%'"); do
  var=$(echo "$role" | tr 'a-z' 'A-Z')_PASSWORD
  pass=$(eval echo "\${$var:-}")
  if [ -z "$pass" ]; then echo "нет пароля для $role ($var) — пропускаю"; continue; fi
  psql "$DATABASE_URL" -c "alter role $role login password '$pass'" >/dev/null
  echo "ok $role"
done
