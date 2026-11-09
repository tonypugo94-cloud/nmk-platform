-- 0100. Модуль «Заказы из учётной системы» (сервис accounting-sync), схема integration.
create schema if not exists integration;
comment on schema integration is 'Обмен с учётной системой (1С): версии, журнал синхронизаций, остатки';

create table integration.sync_state (
  ref          text primary key,          -- ссылка заказа в учётной системе
  data_version text,                      -- последняя успешно применённая версия
  synced_at    timestamptz,
  last_error   text,
  failed_at    timestamptz,
  attempts     int not null default 0
);

create table integration.runs (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('orders','stock')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  changed     int not null default 0,
  unchanged   int not null default 0,
  failed      int not null default 0,
  error       text
);
create index runs_kind_idx on integration.runs (kind, started_at desc);

create table integration.stock (
  item_ref      text not null,
  warehouse_ref text not null default '',
  qty           numeric(14,3) not null,
  synced_at     timestamptz not null default now(),
  primary key (item_ref, warehouse_ref)
);

-- Свежесть данных для баннера «Данные 1С на ЧЧ:ММ».
create or replace view integration.api_sync_status as
select k.kind,
       (select max(finished_at) from integration.runs r where r.kind = k.kind and r.ok) as last_success_at,
       (select ok from integration.runs r where r.kind = k.kind and r.finished_at is not null order by id desc limit 1) as last_ok,
       (select error from integration.runs r where r.kind = k.kind and r.finished_at is not null order by id desc limit 1) as last_error,
       (select count(*) from integration.sync_state s where k.kind = 'orders' and s.last_error is not null) as failed_orders
from (values ('orders'), ('stock')) as k(kind);

-- Остатки для других модулей (заявки на поставку), с привязкой к нашей номенклатуре.
create or replace view integration.api_stock as
select ci.id as catalog_item_id, ci.name, ci.kind, s.item_ref, sum(s.qty) as qty, max(s.synced_at) as synced_at
from integration.stock s
left join core.catalog_items ci on ci.onec_ref = s.item_ref
group by ci.id, ci.name, ci.kind, s.item_ref;

select core.ensure_service_role('svc_accounting_sync');
grant usage on schema integration to svc_accounting_sync;
grant select, insert, update, delete on all tables in schema integration to svc_accounting_sync;
grant execute on function core.apply_accounting_order(jsonb) to svc_accounting_sync;

grant usage on schema integration to authenticated;
grant select on integration.api_sync_status to authenticated;
