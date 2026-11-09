# Развёртывание

Сервер в российском дата-центре: от 4 vCPU, 8 ГБ RAM, 100 ГБ NVMe, Ubuntu 24.04, Docker.

1. **Supabase.** Скопировать официальный `docker/` из репозитория supabase в `infra/supabase/`, заполнить его `.env` (ключи JWT, пароль БД). В `PGRST_DB_SCHEMAS` добавить схемы: `core,bus,integration,tracking,workload,warehouse,procurement,planning,weather,messaging,crew,autoplan,piecework,analytics`.
2. **Миграции:** `DATABASE_URL=postgres://postgres:...@<db>:5432/postgres pnpm db:migrate`.
3. **Роли сервисов:** заполнить `infra/.env` (пример — `infra/.env.example`), выполнить `infra/db-roles.sh`.
4. **Интерфейс:** `VITE_SUPABASE_URL=https://<домен> VITE_SUPABASE_ANON_KEY=<anon key> pnpm --filter @nmk/web-office build`.
5. **Запуск:** `cd infra && docker compose up -d --build`.
6. **Первый администратор:** создать пользователя в Supabase Studio (Auth), затем `select core.bootstrap_admin('почта', 'ФИО');`. Остальных пользователей и роли заводит администратор.
7. **Модули:** администратор включает модули на экране «Модули». Справочники: направления (с `meteo_ref`), кладбища (с координатами и псевдонимами из 1С), машины, бригады, места хранения, нормы, правила дозаказа, ставки сделки.
8. **Боты:** вебхук MAX — `https://<домен>/hooks/max` (секрет в `MAX_WEBHOOK_SECRET`), Callback API VK — `https://<домен>/hooks/vk`. В `core.settings` → `messaging` указать `maxBotUrl`, `vkGroup`, `address`, `ownerChats`.
9. **Мониторинг:** Uptime Kuma на `127.0.0.1:3001` (через SSH-туннель) — проверки `/health` каждого сервиса, оповещение в MAX/почту.

## Бэкапы и восстановление

- Ночной `pg_dump` в S3 (контейнер `backup`), хранение 30 дней.
- Для RPO ≤ 15 минут — включить архивацию WAL через WAL-G в контейнере БД (`archive_mode=on`, `archive_command='wal-g wal-push %p'`, базовый бэкап раз в сутки).
- Восстановление: поднять чистую БД, `gunzip -c dump.sql.gz | psql`, затем `pnpm db:migrate` (догонит новые миграции), затем `infra/db-roles.sh`. Проверять процедуру раз в квартал на отдельном сервере.

## Сопровождение

Профиль разработчика: TypeScript + PostgreSQL. Все изменения БД — только миграциями в `supabase/migrations`. Новый модуль — по инструкции в `docs/architecture.md`.
