-- 0400. Модуль «Склад, места хранения и проверка погрузки» (сервис warehouse).
create schema if not exists warehouse;
comment on schema warehouse is 'Адресное хранение, поиск, погрузка по грузовым местам';

create table warehouse.places (
  code     text primary key,                 -- номер места под навесом: «76»
  zone     text not null default 'canopy',
  title    text,
  capacity int not null default 4,           -- сколько стел помещается в глубину
  sort     int not null default 100,
  active   boolean not null default true
);

create table warehouse.placements (
  cargo_unit_id uuid primary key references tracking.cargo_units(id) on delete cascade,
  place_code    text not null references warehouse.places(code),
  placed_at     timestamptz not null default now(),
  placed_by     uuid
);
create index placements_place_idx on warehouse.placements (place_code, placed_at desc);

create table warehouse.loads (
  id           uuid primary key default gen_random_uuid(),
  waybill_id   text unique,                  -- накладная на экипаж из планировщика
  load_date    date not null,
  vehicle_id   uuid references core.vehicles(id),
  status       text not null default 'open' check (status in ('open','completed','forced')),
  force_reason text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid
);

create table warehouse.load_units (
  load_id       uuid not null references warehouse.loads(id) on delete cascade,
  cargo_unit_id uuid not null references tracking.cargo_units(id) on delete cascade,
  order_id      uuid not null,
  scanned_at    timestamptz,
  primary key (load_id, cargo_unit_id)
);

-- Где лежит: место и сколько стоит перед ним (последняя поставленная — первая спереди).
create or replace view warehouse.api_placements with (security_invoker = true) as
select p.cargo_unit_id, u.order_id, o.number, u.kind, u.seq, p.place_code, p.placed_at,
       row_number() over (partition by p.place_code order by p.placed_at desc) as position_from_front,
       pl.capacity
from warehouse.placements p
join tracking.cargo_units u on u.id = p.cargo_unit_id
join core.orders o on o.id = u.order_id
join warehouse.places pl on pl.code = p.place_code;

create or replace view warehouse.api_places with (security_invoker = true) as
select pl.code, pl.zone, pl.capacity, pl.sort, count(p.cargo_unit_id) as occupied
from warehouse.places pl left join warehouse.placements p on p.place_code = pl.code
where pl.active group by pl.code, pl.zone, pl.capacity, pl.sort order by pl.sort, pl.code;

create or replace view warehouse.api_load_progress with (security_invoker = true) as
select l.id as load_id, l.load_date, l.status, lu.order_id, o.number,
       count(*) as units_total, count(lu.scanned_at) as units_scanned
from warehouse.loads l join warehouse.load_units lu on lu.load_id = l.id join core.orders o on o.id = lu.order_id
group by l.id, l.load_date, l.status, lu.order_id, o.number;

create or replace function warehouse.assert_store_role() returns void language plpgsql stable as $$
begin
  if not (core.has_any_role(array['admin','storekeeper','production_head','production_deputy','crew'])
          or session_user like 'svc_%' or exists (select 1 from pg_roles where rolname = session_user and rolsuper)) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
end $$;

create or replace function warehouse.unit_by_tag(p_tag text) returns tracking.cargo_units
language sql stable security definer set search_path = warehouse, tracking, public as $$
  select u.* from tracking.tags g join tracking.cargo_units u on u.id = g.cargo_unit_id where g.code = upper(trim(p_tag)) and g.active
$$;

create or replace function warehouse.place(p_tag text, p_place text) returns jsonb
language plpgsql security definer set search_path = warehouse, tracking, core, bus, public as $$
declare u tracking.cargo_units; v_pos int; v_cap int;
begin
  perform warehouse.assert_store_role();
  u := warehouse.unit_by_tag(p_tag);
  if u.id is null then raise exception 'Неизвестный или погашенный QR-код %', p_tag; end if;
  select capacity into v_cap from warehouse.places where code = p_place and active;
  if v_cap is null then raise exception 'Нет места %', p_place; end if;
  insert into warehouse.placements (cargo_unit_id, place_code, placed_by) values (u.id, p_place, auth.uid())
  on conflict (cargo_unit_id) do update set place_code = excluded.place_code, placed_at = now(), placed_by = excluded.placed_by;
  select count(*) into v_pos from warehouse.placements where place_code = p_place;
  perform bus.publish('storage.placed', 'order:' || u.order_id,
    jsonb_build_object('orderId', u.order_id, 'cargoUnitId', u.id, 'place', p_place, 'depth', v_pos));
  return jsonb_build_object('place', p_place, 'depth', v_pos, 'overCapacity', v_pos > v_cap);
end $$;

create or replace function warehouse.create_load(p_waybill_id text, p_date date, p_vehicle uuid, p_order_ids uuid[]) returns uuid
language plpgsql security definer set search_path = warehouse, tracking, public as $$
declare v_id uuid;
begin
  insert into warehouse.loads (waybill_id, load_date, vehicle_id) values (p_waybill_id, p_date, p_vehicle)
  on conflict (waybill_id) do update set load_date = excluded.load_date, vehicle_id = excluded.vehicle_id
  returning id into v_id;
  delete from warehouse.load_units where load_id = v_id and scanned_at is null and order_id <> all(p_order_ids);
  insert into warehouse.load_units (load_id, cargo_unit_id, order_id)
  select v_id, u.id, u.order_id from tracking.cargo_units u where u.order_id = any(p_order_ids) and u.active
  on conflict do nothing;
  return v_id;
end $$;

create or replace function warehouse.scan_load(p_load uuid, p_tag text) returns jsonb
language plpgsql security definer set search_path = warehouse, tracking, core, bus, public as $$
declare u tracking.cargo_units; v_num text; v_total int; v_done int; v_lt int; v_ld int; v_other text;
begin
  perform warehouse.assert_store_role();
  u := warehouse.unit_by_tag(p_tag);
  if u.id is null then raise exception 'Неизвестный или погашенный QR-код %', p_tag; end if;
  select number into v_num from core.orders where id = u.order_id;
  if not exists (select 1 from warehouse.load_units where load_id = p_load and cargo_unit_id = u.id) then
    raise exception 'Это место заказа % — его нет в этой машине', v_num using errcode = 'P0001';
  end if;
  update warehouse.load_units set scanned_at = coalesce(scanned_at, now()) where load_id = p_load and cargo_unit_id = u.id;
  delete from warehouse.placements where cargo_unit_id = u.id;  -- уехало из-под навеса
  select count(*), count(scanned_at) into v_total, v_done from warehouse.load_units where load_id = p_load and order_id = u.order_id;
  select count(*), count(scanned_at) into v_lt, v_ld from warehouse.load_units where load_id = p_load;
  perform bus.publish('load.item_scanned', 'order:' || u.order_id,
    jsonb_build_object('loadId', p_load, 'orderId', u.order_id, 'cargoUnitId', u.id, 'scanned', v_done, 'total', v_total));
  return jsonb_build_object('number', v_num, 'orderScanned', v_done, 'orderTotal', v_total, 'loadScanned', v_ld, 'loadTotal', v_lt,
                            'text', format('Заказ %s: %s из %s', v_num, v_done, v_total));
end $$;

-- Закрыть погрузку можно только когда отсканированы все места. Иначе — только начальник с причиной.
create or replace function warehouse.complete_load(p_load uuid, p_force_reason text default null) returns jsonb
language plpgsql security definer set search_path = warehouse, core, bus, public as $$
declare v_missing jsonb; v_forced boolean := false;
begin
  perform warehouse.assert_store_role();
  select jsonb_agg(jsonb_build_object('number', o.number, 'seq', u.seq, 'kind', u.kind) order by o.number, u.seq) into v_missing
  from warehouse.load_units lu join tracking.cargo_units u on u.id = lu.cargo_unit_id join core.orders o on o.id = lu.order_id
  where lu.load_id = p_load and lu.scanned_at is null;
  if v_missing is not null then
    if p_force_reason is null then
      raise exception 'Погрузка не завершена: не отсканировано %', v_missing using errcode = 'P0001';
    end if;
    if not (core.has_any_role(array['admin','production_head','production_deputy'])
            or exists (select 1 from pg_roles where rolname = session_user and rolsuper)) then
      raise exception 'Закрыть неполную погрузку может только начальник производства или его зам' using errcode = 'insufficient_privilege';
    end if;
    v_forced := true;
  end if;
  update warehouse.loads set status = case when v_forced then 'forced' else 'completed' end,
         force_reason = p_force_reason, completed_at = now(), completed_by = auth.uid()
   where id = p_load;
  perform bus.publish(case when v_forced then 'load.incomplete' else 'load.completed' end, null,
    jsonb_build_object('loadId', p_load, 'missing', coalesce(v_missing, '[]'::jsonb), 'reason', p_force_reason));
  return jsonb_build_object('status', case when v_forced then 'forced' else 'completed' end, 'missing', coalesce(v_missing, '[]'::jsonb));
end $$;

insert into core.roles (code, title, module_key, enabled) values ('storekeeper', 'Кладовщик', 'warehouse', true)
on conflict (code) do update set module_key = 'warehouse', enabled = true;

select core.ensure_service_role('svc_warehouse');
grant usage on schema warehouse, tracking to svc_warehouse;
grant execute on function warehouse.create_load(text, date, uuid, uuid[]) to svc_warehouse;

alter table warehouse.places enable row level security;
alter table warehouse.placements enable row level security;
alter table warehouse.loads enable row level security;
alter table warehouse.load_units enable row level security;
create policy places_read on warehouse.places for select to authenticated using (true);
create policy places_admin on warehouse.places for all to authenticated using (core.has_any_role(array['admin','production_head'])) with check (core.has_any_role(array['admin','production_head']));
create policy placements_read on warehouse.placements for select to authenticated using (core.is_staff() or core.has_any_role(array['storekeeper','station','crew']));
create policy loads_read on warehouse.loads for select to authenticated using (core.is_staff() or core.has_any_role(array['storekeeper','crew']));
create policy load_units_read on warehouse.load_units for select to authenticated using (core.is_staff() or core.has_any_role(array['storekeeper','crew']));
grant usage on schema warehouse to authenticated;
grant select on all tables in schema warehouse to authenticated;
grant select on warehouse.api_placements, warehouse.api_places, warehouse.api_load_progress to authenticated;
grant insert, update, delete on warehouse.places to authenticated;
grant execute on function warehouse.place(text, text), warehouse.scan_load(uuid, text), warehouse.complete_load(uuid, text) to authenticated;
