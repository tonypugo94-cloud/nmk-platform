# НМК: система управления производством

Каркас системы для Нижегородской мемориальной компании. Модули подключаются как независимые сервисы.

## Быстрый старт (разработка)

```bash
pnpm install
# локальный PostgreSQL 16 на :54329 (или свой: DATABASE_URL=...)
pnpm db:reset          # схемы с нуля + заглушка Supabase (только локально!)
pnpm test              # все тесты, включая обмен с эмулятором 1С
npx tsx packages/accounting/src/emulator.ts   # эмулятор 1С OData на :8091 (obmen/secret)
DATABASE_URL=... ONEC_ODATA_URL=http://localhost:8091/base/odata/standard.odata ONEC_USER=obmen ONEC_PASSWORD=secret \
  npx tsx services/accounting-sync/src/main.ts
```

## Что где

| Папка | Что внутри |
| --- | --- |
| `supabase/migrations` | Все изменения БД. `00xx` — ядро, `01xx` — модуль заказов, дальше по сотне на модуль |
| `supabase/local` | Заглушка auth/ролей Supabase для локальной разработки |
| `packages/shared` | Шина событий, каркас сервиса, предохранитель, логгер, каталог событий |
| `packages/accounting` | Интерфейс учётной системы, адаптер 1С OData, эмулятор 1С |
| `packages/db` | Применение миграций |
| `services/*` | Сервисы, по одному на модуль |
| `infra` | docker compose, Dockerfile, выдача паролей сервисным ролям |
| `apps/web-office` | Интерфейс (PWA, React): офис, участки, склад, бригады, собственник |
| `packages/bots` | Транспорт MAX и VK, шлюз мессенджера |
| `docs` | Архитектура, матрица отказов, развёртывание, ТЗ для специалиста 1С |

Подробно — в `docs/architecture.md`.
