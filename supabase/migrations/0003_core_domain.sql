-- 0003. Предметная область ядра: справочники, клиенты, изделия, заказы, журнал заказа.

-- ─── Справочники ───────────────────────────────────────────────────────────────
create table core.directions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,          -- «Арзамас», «Кстово»…
  sort       int not null default 100,
  active     boolean not null default true,
  meteo_ref  text                           -- идентификатор точки в МетеоПлане
);

create table core.cemeteries (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  aliases      text[] not null default '{}', -- как пишут в 1С: «Новое Кстово», «кладб. Новое»
  direction_id uuid references core.directions(id),
  lat          numeric(9,6),
  lon          numeric(9,6),
  active       boolean not null default true,
  unique (name, direction_id)
);

create table core.vehicles (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,               -- ГАЗон, Газель, УАЗ
  plate        text not null unique,
  capacity_kg  int not null check (capacity_kg > 0),
  active       boolean not null default true
);

create table core.crews (
  id      uuid primary key default gen_random_uuid(),
  name    text not null unique,
  leader  text,
  phone   text,
  active  boolean not null default true
);

create table core.stages (
  code              text primary key,
  title             text not null,
  sort              int not null,
  onec_values       text[] not null default '{}', -- значения реквизита «Стадия производства» в 1С
  ready_for_install boolean not null default false,
  is_final          boolean not null default false
);

insert into core.stages (code, title, sort, onec_values, ready_for_install, is_final) values
  ('accepted',      'Принят',          10, array['принят'],          false, false),
  ('in_production', 'В производстве',  20, array['в производстве'],  false, false),
  ('ready',         'Готов',           30, array['готов'],           true,  false),
  ('installed',     'Установлен',      40, array['установлен'],      false, true);

-- ─── Клиенты и изделия ─────────────────────────────────────────────────────────
-- Персональных данных — минимум. После закрытия заказа и срока хранения — обезличивание.
create table core.customers (
  id            uuid primary key default gen_random_uuid(),
  onec_ref      text unique,
  full_name     text not null,
  phone         text,
  anonymized_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table core.catalog_items (
  id           uuid primary key default gen_random_uuid(),
  onec_ref     text unique,
  sku          text,
  name         text not null,
  kind         text not null default 'other'
               check (kind in ('stela','stand','flowerbed','tile','concrete','cross','service','other')),
  weight_kg    numeric(10,2),
  length_mm    int,
  width_mm     int,
  thickness_mm int,
  updated_at   timestamptz not null default now()
);

-- ─── Заказы ────────────────────────────────────────────────────────────────────
create table core.orders (
  id                uuid primary key default gen_random_uuid(),
  onec_ref          text unique,
  number            text not null,
  order_date        date,
  due_date          date,                        -- срок установки по договору
  customer_id       uuid references core.customers(id),
  cemetery_id       uuid references core.cemeteries(id),
  cemetery_text     text,                        -- как пришло из 1С, если не сопоставилось
  plot              text,                        -- участок / место захоронения
  direction_id      uuid references core.directions(id),
  stage_code        text not null default 'accepted' references core.stages(code),
  stage_source      text not null default 'onec' check (stage_source in ('onec','manual','tracking')),
  status            text not null default 'open' check (status in ('open','closed')),
  amount            numeric(12,2),
  notes             text,
  onec_stage        text,                        -- последнее значение реквизита стадии из 1С
  onec_data_version text,
  synced_at         timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index orders_open_idx on core.orders (status, due_date) where status = 'open';
create index orders_stage_idx on core.orders (stage_code) where status = 'open';

create table core.order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references core.orders(id) on delete cascade,
  catalog_item_id uuid references core.catalog_items(id),
  line_no         int not null,
  name            text not null,
  qty             numeric(10,2) not null default 1,
  weight_kg       numeric(10,2),                 -- вес строки = вес изделия × количество
  unique (order_id, line_no)
);

-- ─── Журнал заказа ─────────────────────────────────────────────────────────────
-- Любое событие шины с ключом order:<id> навсегда остаётся в истории заказа
-- (шину периодически чистим, журнал — нет).
create table core.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references core.orders(id) on delete cascade,
  event_id    bigint unique,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  source      text not null,
  occurred_at timestamptz not null default now()
);
create index order_events_order_idx on core.order_events (order_id, occurred_at desc);

create or replace function core.capture_order_event() returns trigger
language plpgsql security definer set search_path = core, public as $$
declare v_id uuid;
begin
  if new.key like 'order:%' then
    begin
      v_id := substring(new.key from 7)::uuid;
    exception when others then
      return null;
    end;
    insert into core.order_events (order_id, event_id, type, payload, source, occurred_at)
    select v_id, new.id, new.type, new.payload, new.source, new.occurred_at
    where exists (select 1 from core.orders where id = v_id)
    on conflict (event_id) do nothing;
  end if;
  return null;
end $$;

create trigger events_capture_order after insert on bus.events
for each row execute function core.capture_order_event();

-- ─── Представления для интерфейса и других сервисов ───────────────────────────
create or replace view core.api_orders with (security_invoker = true) as
select o.id, o.number, o.onec_ref, o.order_date, o.due_date,
       (o.due_date - current_date) as days_left,
       o.status, o.stage_code, s.title as stage_title, s.ready_for_install, o.stage_source,
       o.customer_id, c.full_name as customer_name, c.phone as customer_phone,
       o.cemetery_id, coalesce(cm.name, o.cemetery_text) as cemetery, o.plot,
       o.direction_id, d.name as direction,
       o.amount, o.notes,
       (select coalesce(sum(i.weight_kg), 0) from core.order_items i where i.order_id = o.id) as weight_kg,
       o.synced_at, o.updated_at
from core.orders o
join core.stages s on s.code = o.stage_code
left join core.customers c on c.id = o.customer_id
left join core.cemeteries cm on cm.id = o.cemetery_id
left join core.directions d on d.id = coalesce(o.direction_id, cm.direction_id);

create or replace view core.api_order_items with (security_invoker = true) as
select i.id, i.order_id, i.line_no, i.name, i.qty, i.weight_kg,
       ci.kind, ci.sku, ci.length_mm, ci.width_mm, ci.thickness_mm
from core.order_items i
left join core.catalog_items ci on ci.id = i.catalog_item_id;

-- ─── Применение заказа из учётной системы ──────────────────────────────────────
-- Вход — нормализованный заказ из пакета accounting (см. packages/accounting/src/types.ts).
create or replace function core.apply_accounting_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = core, bus, public as $$
declare
  v_customer_id uuid;
  v_order       core.orders%rowtype;
  v_existing    core.orders%rowtype;
  v_created     boolean := false;
  v_stage       text;
  v_mapped      text;
  v_cemetery    core.cemeteries%rowtype;
  v_item        jsonb;
  v_item_id     uuid;
  v_line        int := 0;
  v_key         text;
begin
  select * into v_existing from core.orders where onec_ref = p->>'ref';

  if found and v_existing.onec_data_version is not distinct from p->>'dataVersion' then
    return jsonb_build_object('orderId', v_existing.id, 'result', 'unchanged');
  end if;

  -- клиент
  if p->'customer' is not null and p->'customer'->>'ref' is not null then
    insert into core.customers (onec_ref, full_name, phone)
    values (p->'customer'->>'ref', coalesce(p->'customer'->>'fullName', 'Без имени'), p->'customer'->>'phone')
    on conflict (onec_ref) do update
      set full_name = excluded.full_name, phone = excluded.phone, updated_at = now()
      where core.customers.anonymized_at is null
    returning id into v_customer_id;
    if v_customer_id is null then
      select id into v_customer_id from core.customers where onec_ref = p->'customer'->>'ref';
    end if;
  end if;

  -- стадия: значение реквизита 1С → код стадии; неизвестное значение не меняет стадию
  -- Стадию из 1С применяем только если в 1С она реально поменялась с прошлой синхронизации:
  -- так ручная смена или скан на участке не откатится при любой другой правке заказа в 1С.
  select code into v_mapped from core.stages
   where lower(trim(p->>'stage')) = any(select lower(x) from unnest(onec_values) x);
  if v_existing.id is null then
    v_stage := coalesce(v_mapped, 'accepted');
  elsif v_mapped is not null and (p->>'stage') is distinct from v_existing.onec_stage then
    v_stage := v_mapped;
  else
    v_stage := v_existing.stage_code;
  end if;

  -- кладбище: по названию или псевдониму
  select * into v_cemetery from core.cemeteries
   where active and p->>'cemetery' is not null
     and (lower(name) = lower(trim(p->>'cemetery'))
          or lower(trim(p->>'cemetery')) = any(select lower(a) from unnest(aliases) a))
   limit 1;

  insert into core.orders as o (
    onec_ref, number, order_date, due_date, customer_id, cemetery_id, cemetery_text, plot,
    direction_id, stage_code, stage_source, status, amount, onec_stage, onec_data_version, synced_at, closed_at)
  values (
    p->>'ref', p->>'number', (p->>'date')::date, (p->>'dueDate')::date, v_customer_id,
    v_cemetery.id, p->>'cemetery', p->>'plot', v_cemetery.direction_id,
    v_stage, 'onec', coalesce(p->>'status', 'open'), (p->>'amount')::numeric,
    p->>'stage', p->>'dataVersion', now(),
    case when p->>'status' = 'closed' then now() end)
  on conflict (onec_ref) do update set
    number = excluded.number, order_date = excluded.order_date, due_date = excluded.due_date,
    customer_id = excluded.customer_id,
    cemetery_id = coalesce(excluded.cemetery_id, o.cemetery_id),
    cemetery_text = excluded.cemetery_text, plot = excluded.plot,
    direction_id = coalesce(o.direction_id, excluded.direction_id),
    stage_code = excluded.stage_code,
    stage_source = case when excluded.stage_code <> o.stage_code then 'onec' else o.stage_source end,
    status = excluded.status, amount = excluded.amount, onec_stage = excluded.onec_stage,
    onec_data_version = excluded.onec_data_version, synced_at = now(), updated_at = now(),
    closed_at = case when excluded.status = 'closed' and o.closed_at is null then now() else o.closed_at end
  returning * into v_order;

  v_created := v_existing.id is null;
  v_key := 'order:' || v_order.id;

  -- состав заказа
  delete from core.order_items where order_id = v_order.id;
  for v_item in select * from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
    v_line := v_line + 1;
    v_item_id := null;
    if v_item->>'itemRef' is not null then
      insert into core.catalog_items (onec_ref, sku, name, kind, weight_kg, length_mm, width_mm, thickness_mm)
      values (v_item->>'itemRef', v_item->>'sku', v_item->>'name', coalesce(v_item->>'kind', 'other'),
              (v_item->>'weightKg')::numeric, (v_item->>'lengthMm')::int, (v_item->>'widthMm')::int, (v_item->>'thicknessMm')::int)
      on conflict (onec_ref) do update set
        sku = excluded.sku, name = excluded.name, kind = excluded.kind,
        weight_kg = coalesce(excluded.weight_kg, core.catalog_items.weight_kg),
        length_mm = coalesce(excluded.length_mm, core.catalog_items.length_mm),
        width_mm = coalesce(excluded.width_mm, core.catalog_items.width_mm),
        thickness_mm = coalesce(excluded.thickness_mm, core.catalog_items.thickness_mm),
        updated_at = now()
      returning id into v_item_id;
    end if;
    insert into core.order_items (order_id, catalog_item_id, line_no, name, qty, weight_kg)
    select v_order.id, v_item_id, v_line, v_item->>'name', coalesce((v_item->>'qty')::numeric, 1),
           coalesce((v_item->>'weightKg')::numeric, ci.weight_kg) * coalesce((v_item->>'qty')::numeric, 1)
    from (select 1) one left join core.catalog_items ci on ci.id = v_item_id;
  end loop;

  -- события
  perform bus.publish('order.upserted', v_key,
    jsonb_build_object('orderId', v_order.id, 'number', v_order.number, 'created', v_created, 'source', 'onec'),
    'order.upserted:' || v_order.id || ':' || coalesce(v_order.onec_data_version, ''));

  if not v_created and v_existing.stage_code is distinct from v_order.stage_code then
    perform bus.publish('order.stage_changed', v_key,
      jsonb_build_object('orderId', v_order.id, 'from', v_existing.stage_code, 'to', v_order.stage_code, 'source', 'onec'),
      'order.stage_changed:' || v_order.id || ':' || coalesce(v_order.onec_data_version, ''));
  end if;

  if (v_created or v_existing.stage_code is distinct from v_order.stage_code)
     and exists (select 1 from core.stages where code = v_order.stage_code and ready_for_install) then
    perform bus.publish('order.ready_for_install', v_key,
      jsonb_build_object('orderId', v_order.id),
      'order.ready_for_install:' || v_order.id || ':' || coalesce(v_order.onec_data_version, ''));
  end if;

  if v_order.status = 'closed' and coalesce(v_existing.status, 'open') = 'open' then
    perform bus.publish('order.closed', v_key, jsonb_build_object('orderId', v_order.id),
      'order.closed:' || v_order.id);
  end if;

  if p->>'cemetery' is not null and v_order.cemetery_id is null then
    perform bus.publish('order.cemetery_unmatched', v_key,
      jsonb_build_object('orderId', v_order.id, 'cemetery', p->>'cemetery'),
      'order.cemetery_unmatched:' || v_order.id || ':' || coalesce(v_order.onec_data_version, ''));
  end if;

  return jsonb_build_object('orderId', v_order.id, 'result', case when v_created then 'created' else 'updated' end,
                            'stage', v_order.stage_code);
end $$;

-- Ручная смена стадии (запасной путь и будущие модули). Источник фиксируется.
create or replace function core.set_order_stage(p_order_id uuid, p_stage text, p_source text default 'manual', p_comment text default null)
returns void
language plpgsql security definer set search_path = core, bus, public as $$
declare v_prev text;
begin
  if p_source = 'manual' and not core.has_any_role(array['admin','production_head','production_deputy','manager'])
     and session_user not like 'svc_%' and not exists (select 1 from pg_roles where rolname = session_user and rolsuper) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select stage_code into v_prev from core.orders where id = p_order_id for update;
  if v_prev is null then raise exception 'order % not found', p_order_id; end if;
  if v_prev = p_stage then return; end if;
  update core.orders set stage_code = p_stage, stage_source = p_source, updated_at = now() where id = p_order_id;
  perform bus.publish('order.stage_changed', 'order:' || p_order_id,
    jsonb_build_object('orderId', p_order_id, 'from', v_prev, 'to', p_stage, 'source', p_source,
                       'comment', p_comment, 'by', auth.uid()));
  if exists (select 1 from core.stages where code = p_stage and ready_for_install) then
    perform bus.publish('order.ready_for_install', 'order:' || p_order_id, jsonb_build_object('orderId', p_order_id));
  end if;
end $$;

-- Обезличивание клиентов по сроку хранения (запускается по расписанию).
create or replace function core.anonymize_customers() returns int
language plpgsql security definer set search_path = core, bus, public as $$
declare v_days int; n int;
begin
  select (value #>> '{}')::int into v_days from core.settings where key = 'pii_retention_days';
  with target as (
    select c.id from core.customers c
    where c.anonymized_at is null
      and exists (select 1 from core.orders o where o.customer_id = c.id)
      and not exists (select 1 from core.orders o where o.customer_id = c.id
                      and (o.status = 'open' or o.closed_at > now() - make_interval(days => coalesce(v_days, 365))))
  )
  update core.customers c set full_name = 'Обезличено', phone = null, anonymized_at = now(), updated_at = now()
  from target where c.id = target.id;
  get diagnostics n = row_count;
  if n > 0 then perform bus.publish('customer.anonymized', null, jsonb_build_object('count', n)); end if;
  return n;
end $$;

-- ─── Доступ ────────────────────────────────────────────────────────────────────
alter table core.directions enable row level security;
alter table core.cemeteries enable row level security;
alter table core.vehicles enable row level security;
alter table core.crews enable row level security;
alter table core.stages enable row level security;
alter table core.customers enable row level security;
alter table core.catalog_items enable row level security;
alter table core.orders enable row level security;
alter table core.order_items enable row level security;
alter table core.order_events enable row level security;

do $$
declare t text;
begin
  foreach t in array array['directions','cemeteries','vehicles','crews','stages','catalog_items'] loop
    execute format('create policy %1$s_read on core.%1$s for select to authenticated using (core.is_staff() or core.has_any_role(array[''station'',''storekeeper'',''crew'']))', t);
    execute format('create policy %1$s_write on core.%1$s for all to authenticated using (core.has_any_role(array[''admin'',''production_head''])) with check (core.has_any_role(array[''admin'',''production_head'']))', t);
  end loop;
end $$;

-- Сервисам — чтение справочников и заказов (права на конкретные таблицы выдаются каждому сервису отдельно).
do $$
declare t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'nmk_services') then create role nmk_services nologin; end if;
  foreach t in array array['directions','cemeteries','vehicles','crews','stages','catalog_items','customers','orders','order_items','order_events'] loop
    execute format('create policy %1$s_services on core.%1$s for select to nmk_services using (true)', t);
  end loop;
end $$;

create policy customers_read on core.customers for select to authenticated using (core.is_staff());
create policy orders_read on core.orders for select to authenticated
  using (core.is_staff() or core.has_any_role(array['station','storekeeper','crew']));
create policy orders_edit on core.orders for update to authenticated
  using (core.has_any_role(array['admin','manager','production_head','production_deputy']))
  with check (core.has_any_role(array['admin','manager','production_head','production_deputy']));
create policy order_items_read on core.order_items for select to authenticated
  using (core.is_staff() or core.has_any_role(array['station','storekeeper','crew']));
create policy order_events_read on core.order_events for select to authenticated using (core.is_staff());

grant select on core.directions, core.cemeteries, core.vehicles, core.crews, core.stages, core.catalog_items,
                core.customers, core.orders, core.order_items, core.order_events,
                core.api_orders, core.api_order_items to authenticated;
grant insert, update, delete on core.directions, core.cemeteries, core.vehicles, core.crews, core.stages, core.catalog_items to authenticated;
-- в заказе пользователь может поправить только то, чего нет в 1С
grant update (cemetery_id, direction_id, plot, notes) on core.orders to authenticated;
grant execute on function core.set_order_stage(uuid, text, text, text) to authenticated;
