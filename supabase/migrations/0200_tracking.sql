-- 0200. Модуль «QR-метки и отметки участков» (сервис tracking).
-- QR не на каждую деталь, а на грузовые места: стела — своя бирка, комплектующие — один ярлык на паллет-комплект.
create schema if not exists tracking;
comment on schema tracking is 'Грузовые места, QR-метки, участки, сканы';

create table tracking.stations (
  code           text primary key,
  title          text not null,
  applies_to     text not null default 'stela' check (applies_to in ('stela','kit','any')),
  in_route       boolean not null default true,      -- обязательный шаг маршрута изделия
  sort           int not null,
  stage_on_take  text references core.stages(code),  -- стадия заказа при «Взял»
  stage_on_done  text references core.stages(code),  -- стадия заказа при «Готово»
  hours_per_day  numeric(5,1) not null default 8,    -- мощность участка (для распределения работ)
  active         boolean not null default true
);

insert into tracking.stations (code, title, applies_to, in_route, sort, stage_on_take, stage_on_done, hours_per_day) values
  ('milling',   'Фреза',                 'stela', false, 10, 'in_production', null,    8),
  ('laser',     'Лазер',                 'stela', true,  20, 'in_production', null,    16),
  ('sandblast', 'Пескоструй',            'stela', true,  30, 'in_production', 'ready', 16),
  ('photo',     'Вставка фото',          'stela', false, 40, null,            'ready', 8),
  ('chamfer',   'Фаска: стелы',          'stela', false, 60, null,            null,    8),
  ('kit',       'Фаска и комплектация',  'kit',   false, 60, null,            null,    8);

create table tracking.cargo_units (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references core.orders(id) on delete cascade,
  kind        text not null check (kind in ('stela','kit')),
  seq         int not null,                          -- номер места в заказе: 1, 2…
  contents    jsonb not null default '[]'::jsonb,    -- [{orderItemId, name, qty}]
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (order_id, seq)
);

create table tracking.tags (
  code        text primary key,                      -- короткий код в QR
  cargo_unit_id uuid not null unique references tracking.cargo_units(id) on delete cascade,
  printed_at  timestamptz,
  active      boolean not null default true
);

create table tracking.scans (
  id             bigint generated always as identity primary key,
  client_scan_id text not null unique,               -- id с телефона: повторная отправка из офлайна не задваивает
  tag_code       text not null references tracking.tags(code),
  cargo_unit_id  uuid not null references tracking.cargo_units(id) on delete cascade,
  order_id       uuid not null,
  station_code   text not null references tracking.stations(code),
  action         text not null check (action in ('take','done')),
  user_id        uuid,
  scanned_at     timestamptz not null,               -- время на телефоне
  received_at    timestamptz not null default now()
);
create index scans_unit_idx on tracking.scans (cargo_unit_id, scanned_at);

create or replace function tracking.new_code() returns text language sql volatile as $$
  select upper(substr(translate(encode(gen_random_bytes(8), 'base64'), '+/=0O1IL', 'XYZ'), 1, 8))
$$;

-- Грузовые места заказа: каждая стела — своё место; всё прочее физическое — один паллет-комплект.
create or replace function tracking.ensure_cargo_units(p_order_id uuid) returns int
language plpgsql security definer set search_path = tracking, core, bus, public as $$
declare v_seq int := 0; r record; v_unit uuid; v_kit jsonb; n int := 0;
begin
  if exists (select 1 from tracking.cargo_units where order_id = p_order_id) then return 0; end if;
  for r in select i.* from core.api_order_items i where i.order_id = p_order_id and i.kind = 'stela' order by i.line_no loop
    for k in 1..greatest(r.qty::int, 1) loop
      v_seq := v_seq + 1;
      insert into tracking.cargo_units (order_id, kind, seq, contents)
      values (p_order_id, 'stela', v_seq, jsonb_build_array(jsonb_build_object('orderItemId', r.id, 'name', r.name, 'qty', 1)))
      returning id into v_unit;
      insert into tracking.tags (code, cargo_unit_id) values (tracking.new_code(), v_unit);
      n := n + 1;
    end loop;
  end loop;
  select jsonb_agg(jsonb_build_object('orderItemId', i.id, 'name', i.name, 'qty', i.qty) order by i.line_no) into v_kit
    from core.api_order_items i
   where i.order_id = p_order_id and coalesce(i.kind, 'other') not in ('stela', 'service');
  if v_kit is not null then
    v_seq := v_seq + 1;
    insert into tracking.cargo_units (order_id, kind, seq, contents) values (p_order_id, 'kit', v_seq, v_kit) returning id into v_unit;
    insert into tracking.tags (code, cargo_unit_id) values (tracking.new_code(), v_unit);
    n := n + 1;
  end if;
  if n > 0 then
    perform bus.publish('tracking.cargo_created', 'order:' || p_order_id, jsonb_build_object('orderId', p_order_id, 'units', n),
                        'tracking.cargo_created:' || p_order_id);
  end if;
  return n;
end $$;

create or replace function tracking.deactivate_order(p_order_id uuid) returns void
language sql security definer set search_path = tracking, public as $$
  update tracking.tags set active = false where cargo_unit_id in (select id from tracking.cargo_units where order_id = p_order_id);
  update tracking.cargo_units set active = false where order_id = p_order_id;
$$;

-- Скан с телефона. Работает прямо через API базы, даже если сервис tracking лежит.
create or replace function tracking.record_scan(p_tag text, p_station text, p_action text, p_client_scan_id text, p_scanned_at timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = tracking, core, bus, public as $$
declare t record; st tracking.stations%rowtype; v_new boolean; v_stage text; v_order core.orders%rowtype;
begin
  if not (core.has_any_role(array['admin','station','storekeeper','production_head','production_deputy'])
          or session_user like 'svc_%' or exists (select 1 from pg_roles where rolname = session_user and rolsuper)) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select g.code, g.active, u.id as unit_id, u.order_id, u.kind, u.seq into t
    from tracking.tags g join tracking.cargo_units u on u.id = g.cargo_unit_id where g.code = upper(trim(p_tag));
  if t.code is null then raise exception 'Неизвестный QR-код %', p_tag using errcode = 'P0002'; end if;
  if not t.active then raise exception 'Бирка заказа уже не действует (заказ закрыт)' using errcode = 'P0001'; end if;
  select * into st from tracking.stations where code = p_station and active;
  if st.code is null then raise exception 'Неизвестный участок %', p_station; end if;
  if st.applies_to <> 'any' and st.applies_to <> t.kind then
    raise exception 'Это % — участок «%» с ним не работает', case t.kind when 'stela' then 'стела' else 'комплект' end, st.title;
  end if;

  insert into tracking.scans (client_scan_id, tag_code, cargo_unit_id, order_id, station_code, action, user_id, scanned_at)
  values (p_client_scan_id, t.code, t.unit_id, t.order_id, p_station, p_action, auth.uid(), least(coalesce(p_scanned_at, now()), now()))
  on conflict (client_scan_id) do nothing;
  v_new := found;

  select * into v_order from core.orders where id = t.order_id;
  if v_new then
    perform bus.publish('tracking.scanned', 'order:' || t.order_id,
      jsonb_build_object('orderId', t.order_id, 'cargoUnitId', t.unit_id, 'station', p_station, 'action', p_action, 'by', auth.uid()),
      'tracking.scanned:' || p_client_scan_id);
    v_stage := case p_action when 'take' then st.stage_on_take else st.stage_on_done end;
    -- стадию двигаем только вперёд
    if v_stage is not null and (select sort from core.stages where code = v_stage) > (select sort from core.stages where code = v_order.stage_code) then
      perform core.set_order_stage(t.order_id, v_stage, 'tracking', st.title);
    end if;
  end if;
  return jsonb_build_object('orderId', t.order_id, 'number', v_order.number, 'unit', t.seq, 'kind', t.kind, 'duplicate', not v_new);
end $$;

-- Для печати бирок и ярлыков.
create or replace view tracking.api_labels with (security_invoker = true) as
select u.id as cargo_unit_id, u.order_id, o.number, u.kind, u.seq,
       (select count(*) from tracking.cargo_units x where x.order_id = u.order_id) as units_total,
       u.contents, g.code as tag_code, g.printed_at, o.direction, o.customer_name, o.due_date
from tracking.cargo_units u
join tracking.tags g on g.cargo_unit_id = u.id
join core.api_orders o on o.id = u.order_id
where u.active;

-- Где изделие сейчас: последний скан.
create or replace view tracking.api_unit_position with (security_invoker = true) as
select distinct on (s.cargo_unit_id) s.cargo_unit_id, s.order_id, s.station_code, s.action, s.scanned_at
from tracking.scans s order by s.cargo_unit_id, s.scanned_at desc, s.id desc;

insert into core.roles (code, title, module_key, enabled) values ('station', 'Участок производства', 'tracking', true)
on conflict (code) do update set module_key = 'tracking';

select core.ensure_service_role('svc_tracking');
grant usage on schema tracking to svc_tracking;
grant select on all tables in schema tracking to svc_tracking;
grant select on core.api_order_items, core.api_orders to svc_tracking;
grant execute on function tracking.ensure_cargo_units(uuid), tracking.deactivate_order(uuid) to svc_tracking;

alter table tracking.stations enable row level security;
alter table tracking.cargo_units enable row level security;
alter table tracking.tags enable row level security;
alter table tracking.scans enable row level security;
create policy stations_read on tracking.stations for select to authenticated using (true);
create policy stations_admin on tracking.stations for all to authenticated using (core.has_any_role(array['admin','production_head'])) with check (core.has_any_role(array['admin','production_head']));
create policy units_read on tracking.cargo_units for select to authenticated using (core.is_staff() or core.has_any_role(array['station','storekeeper','crew']));
create policy tags_read on tracking.tags for select to authenticated using (core.is_staff() or core.has_any_role(array['station','storekeeper']));
create policy tags_print on tracking.tags for update to authenticated using (core.is_staff() or core.has_role('storekeeper'));
create policy scans_read on tracking.scans for select to authenticated using (core.is_staff() or user_id = auth.uid());
grant usage on schema tracking to authenticated;
grant select on all tables in schema tracking to authenticated;
grant select on tracking.api_labels, tracking.api_unit_position to authenticated;
grant update (printed_at) on tracking.tags to authenticated;
grant insert, update on tracking.stations to authenticated;
grant execute on function tracking.record_scan(text, text, text, text, timestamptz) to authenticated;
