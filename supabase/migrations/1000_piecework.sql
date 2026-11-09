-- 1000. Модуль «Сдельная оплата обработчиков» (сервис piecework).
-- Обработчик сканирует QR стелы или комплекта, выбирает деталь и операцию. Погонные метры
-- считаются из размеров изделия, сумма — по ставке сразу. Ставки заполняет начальник производства.
create schema if not exists piecework;
comment on schema piecework is 'Справочник операций и ставок, отметки работ, ведомости';

create table piecework.operations (
  code        text primary key,
  title       text not null,
  unit        text not null check (unit in ('m','pcs')),
  -- как считать погонные метры из размеров детали (мм): perimeter = 2×(длина+ширина), length = длина,
  -- width = ширина, manual = вводит рабочий
  measure     text not null default 'manual' check (measure in ('perimeter','length','width','two_lengths','manual')),
  rate        numeric(10,2) not null default 0,     -- ₽ за метр или за штуку
  needs_photo boolean not null default false,
  applies_to  text not null default 'any' check (applies_to in ('stela','kit','any')),
  active      boolean not null default true,
  sort        int not null default 100
);

-- Операции из листа «Отчёт за выполненные работы · цех отгрузки». Ставки — 0, пока НМК их не утвердит.
insert into piecework.operations (code, title, unit, measure, needs_photo, sort) values
  ('chamfer_tech',        'Фаска технологическая',          'm',   'perimeter',   false, 10),
  ('chamfer_pol_top',     'Фаска полированная, верх',       'm',   'perimeter',   true,  20),
  ('chamfer_pol_bottom',  'Фаска полированная, низ',        'm',   'perimeter',   true,  30),
  ('drilling',            'Сверление отверстия',            'pcs', 'manual',      false, 40),
  ('polish_plane_top',    'Ручная полировка плоскости, верх','pcs','manual',      true,  50),
  ('polish_plane_bottom', 'Ручная полировка плоскости, низ', 'pcs','manual',      true,  60),
  ('polish_plane_side',   'Ручная полировка плоскости, бок', 'pcs','manual',      true,  70),
  ('polish_ends',         'Полировка торцов',               'm',   'two_lengths', true,  80),
  ('grinding',            'Шлифовка',                       'pcs', 'manual',      false, 90),
  ('cutting',             'Распил',                         'm',   'manual',      false, 100);

create table piecework.records (
  id            bigint generated always as identity primary key,
  client_id     text not null unique,              -- повторная отправка из офлайна не задваивает
  user_id       uuid not null,
  order_id      uuid not null references core.orders(id) on delete cascade,
  cargo_unit_id uuid references tracking.cargo_units(id) on delete set null,
  order_item_id uuid references core.order_items(id) on delete set null,
  item_name     text not null,
  operation     text not null references piecework.operations(code),
  qty           numeric(10,3) not null check (qty > 0),
  rate          numeric(10,2) not null,
  amount        numeric(12,2) not null,
  photo_path    text,
  recorded_at   timestamptz not null default now(),
  voided_at     timestamptz,
  voided_by     uuid,
  void_reason   text
);
create index records_user_month_idx on piecework.records (user_id, recorded_at);

create or replace function piecework.measure_qty(p_measure text, p_length int, p_width int) returns numeric
language sql immutable as $$
  select case p_measure
    when 'perimeter'   then 2 * (coalesce(p_length, 0) + coalesce(p_width, 0)) / 1000.0
    when 'length'      then coalesce(p_length, 0) / 1000.0
    when 'width'       then coalesce(p_width, 0) / 1000.0
    when 'two_lengths' then 2 * coalesce(p_length, 0) / 1000.0
    else null end
$$;

-- Что можно отметить по бирке: детали грузового места и операции с рассчитанным количеством.
create or replace function piecework.options(p_tag text) returns jsonb
language sql stable security definer set search_path = piecework, tracking, core, public as $$
  with u as (select cu.* from tracking.tags g join tracking.cargo_units cu on cu.id = g.cargo_unit_id where g.code = upper(trim(p_tag)) and g.active),
  items as (
    select i.id, i.name, i.qty, i.length_mm, i.width_mm, u.kind as unit_kind
    from u cross join lateral jsonb_array_elements(u.contents) c
    join core.api_order_items i on i.id = (c->>'orderItemId')::uuid
  )
  select jsonb_build_object(
    'orderId', (select order_id from u), 'number', (select number from core.orders where id = (select order_id from u)),
    'items', coalesce((select jsonb_agg(jsonb_build_object('orderItemId', it.id, 'name', it.name, 'lengthMm', it.length_mm, 'widthMm', it.width_mm,
      'operations', (select jsonb_agg(jsonb_build_object('code', o.code, 'title', o.title, 'unit', o.unit, 'rate', o.rate, 'needsPhoto', o.needs_photo,
                       'qty', piecework.measure_qty(o.measure, it.length_mm, it.width_mm)) order by o.sort)
                     from piecework.operations o where o.active and o.applies_to in ('any', it.unit_kind)))) from items it), '[]'::jsonb))
$$;

create or replace function piecework.record(p_tag text, p_order_item uuid, p_operation text, p_qty numeric, p_photo text, p_client_id text) returns jsonb
language plpgsql security definer set search_path = piecework, tracking, core, bus, public as $$
declare u tracking.cargo_units; op piecework.operations; it record; v_qty numeric; v_id bigint; v_amount numeric;
begin
  if not core.has_any_role(array['admin','station','storekeeper']) and not exists (select 1 from pg_roles where rolname = session_user and rolsuper) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select cu.* into u from tracking.tags g join tracking.cargo_units cu on cu.id = g.cargo_unit_id where g.code = upper(trim(p_tag)) and g.active;
  if u.id is null then raise exception 'Неизвестный или погашенный QR-код'; end if;
  select * into op from piecework.operations where code = p_operation and active;
  if op.code is null then raise exception 'Нет такой операции'; end if;
  select i.* into it from core.api_order_items i where i.id = p_order_item and i.order_id = u.order_id;
  if it.id is null then raise exception 'Деталь не из этого заказа'; end if;
  if op.needs_photo and p_photo is null then raise exception 'Для операции «%» нужно фото кромки', op.title using errcode = 'P0001'; end if;
  v_qty := coalesce(p_qty, piecework.measure_qty(op.measure, it.length_mm, it.width_mm));
  if v_qty is null or v_qty <= 0 then raise exception 'Укажите количество'; end if;
  v_amount := round(v_qty * op.rate, 2);
  insert into piecework.records (client_id, user_id, order_id, cargo_unit_id, order_item_id, item_name, operation, qty, rate, amount, photo_path)
  values (p_client_id, coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'), u.order_id, u.id, it.id, it.name, op.code, v_qty, op.rate, v_amount, p_photo)
  on conflict (client_id) do nothing returning id into v_id;
  if v_id is not null then
    perform bus.publish('piecework.recorded', 'order:' || u.order_id,
      jsonb_build_object('orderId', u.order_id, 'recordId', v_id, 'operation', op.code, 'qty', v_qty, 'amount', v_amount, 'userId', auth.uid()));
  end if;
  return jsonb_build_object('qty', v_qty, 'unit', op.unit, 'amount', v_amount, 'duplicate', v_id is null);
end $$;

create or replace function piecework.void(p_record bigint, p_reason text) returns void
language plpgsql security definer set search_path = piecework, core, public as $$
begin
  if not core.has_any_role(array['admin','production_head','production_deputy']) and not exists (select 1 from pg_roles where rolname = session_user and rolsuper) then
    raise exception 'Отменить отметку может начальник производства или его заместитель' using errcode = 'insufficient_privilege';
  end if;
  update piecework.records set voided_at = now(), voided_by = auth.uid(), void_reason = p_reason where id = p_record and voided_at is null;
end $$;

-- Ведомость за месяц по рабочим.
create or replace view piecework.api_statement with (security_invoker = true) as
select date_trunc('month', r.recorded_at)::date as month, r.user_id, coalesce(p.full_name, 'Неизвестный') as worker,
       r.operation, o.title as operation_title, o.unit, sum(r.qty) as qty, sum(r.amount) as amount, count(*) as records
from piecework.records r
join piecework.operations o on o.code = r.operation
left join core.profiles p on p.user_id = r.user_id
where r.voided_at is null
group by 1, 2, 3, 4, 5, 6;

-- Заработок текущего пользователя за месяц — для телефона рабочего.
create or replace view piecework.api_my_month with (security_invoker = true) as
select coalesce(sum(amount), 0) as amount, count(*) as records
from piecework.records where user_id = auth.uid() and voided_at is null and recorded_at >= date_trunc('month', now());

select core.ensure_service_role('svc_piecework');
grant usage on schema piecework to svc_piecework;
grant select on piecework.records to svc_piecework;

alter table piecework.operations enable row level security;
alter table piecework.records enable row level security;
create policy ops_read on piecework.operations for select to authenticated using (true);
create policy ops_admin on piecework.operations for all to authenticated using (core.has_any_role(array['admin','production_head'])) with check (core.has_any_role(array['admin','production_head']));
-- рабочий видит только свои отметки; ведомость — начальник, зам, собственник
create policy records_read on piecework.records for select to authenticated
  using (user_id = auth.uid() or core.has_any_role(array['admin','production_head','production_deputy','owner']));
create policy records_service on piecework.records for select to svc_piecework using (true);
create policy records_services on piecework.records for select to nmk_services using (true);
grant usage on schema piecework to authenticated, nmk_services;
grant select on piecework.operations, piecework.records, piecework.api_statement, piecework.api_my_month to authenticated;
grant select on piecework.records, piecework.operations to nmk_services;
grant insert, update on piecework.operations to authenticated;
grant execute on function piecework.options(text), piecework.record(text, uuid, text, numeric, text, text), piecework.void(bigint, text) to authenticated;
