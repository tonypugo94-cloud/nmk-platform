-- 0600. Модули «Планировщик установок» (сервис planning) и «Погода» (сервис weather).
create schema if not exists weather;
comment on schema weather is 'Прогноз осадков по направлениям (из МетеоПлана)';

create table weather.forecasts (
  direction_id uuid not null references core.directions(id) on delete cascade,
  day          date not null,
  precip_prob  int check (precip_prob between 0 and 100),
  precip_mm    numeric(6,1),
  summary      text,
  fetched_at   timestamptz not null default now(),
  primary key (direction_id, day)
);

create schema if not exists planning;
comment on schema planning is 'Слоты «направление × день», машины, назначения, подтверждения, накладные';

insert into core.settings (key, value) values
  ('planning', '{"workDays": [1,2,3,4,5,6], "reserveDays": [5], "rainWarnProb": 60, "horizonDays": 14}')
on conflict (key) do nothing;

create table planning.slots (
  id           uuid primary key default gen_random_uuid(),
  day          date not null,
  direction_id uuid not null references core.directions(id),
  vehicle_id   uuid not null references core.vehicles(id),
  crew_id      uuid references core.crews(id),
  status       text not null default 'draft' check (status in ('draft','approved','printed','done')),
  note         text,
  created_at   timestamptz not null default now(),
  unique (day, vehicle_id)
);

create table planning.assignments (
  id             uuid primary key default gen_random_uuid(),
  slot_id        uuid not null references planning.slots(id) on delete cascade,
  order_id       uuid not null references core.orders(id) on delete cascade,
  seq            int not null default 100,
  confirm_status text not null default 'not_sent'
                 check (confirm_status in ('not_sent','sent','confirmed','other_date','call_me','declined')),
  confirm_at     timestamptz,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index assignments_one_active on planning.assignments (order_id) where active;

create table planning.waybills (
  id         text primary key,
  slot_id    uuid not null references planning.slots(id) on delete cascade,
  day        date not null,
  content    jsonb not null,
  printed_at timestamptz not null default now(),
  printed_by uuid
);

create or replace function planning.is_reserve(p_day date) returns boolean language sql stable as $$
  select extract(isodow from p_day)::int in (select jsonb_array_elements_text(value->'reserveDays')::int from core.settings where key = 'planning')
$$;

create or replace view planning.api_slots with (security_invoker = true) as
select s.id, s.day, s.direction_id, d.name as direction, s.vehicle_id, v.kind || ' ' || v.plate as vehicle, v.capacity_kg,
       s.crew_id, c.name as crew, s.status, planning.is_reserve(s.day) as reserve_day,
       coalesce(sum(o.weight_kg) filter (where a.active), 0) as load_kg,
       coalesce(sum(o.weight_kg) filter (where a.active), 0) > v.capacity_kg as overload,
       count(a.id) filter (where a.active) as orders,
       count(a.id) filter (where a.active and a.confirm_status = 'confirmed') as confirmed,
       w.precip_prob, w.summary as weather
from planning.slots s
join core.directions d on d.id = s.direction_id
join core.vehicles v on v.id = s.vehicle_id
left join core.crews c on c.id = s.crew_id
left join planning.assignments a on a.slot_id = s.id
left join core.api_orders o on o.id = a.order_id
left join weather.forecasts w on w.direction_id = s.direction_id and w.day = s.day
group by s.id, d.name, v.kind, v.plate, v.capacity_kg, c.name, w.precip_prob, w.summary;

create or replace view planning.api_assignments with (security_invoker = true) as
select a.id, a.slot_id, s.day, a.order_id, o.number, o.customer_name, o.customer_phone, o.cemetery, o.plot, o.direction,
       o.weight_kg, a.seq, a.confirm_status, a.confirm_at
from planning.assignments a join planning.slots s on s.id = a.slot_id join core.api_orders o on o.id = a.order_id
where a.active;

create or replace view planning.api_ready_unplanned with (security_invoker = true) as
select o.id as order_id, o.number, o.customer_name, o.direction_id, o.direction, o.cemetery, o.weight_kg, o.due_date, o.days_left
from core.api_orders o
where o.status = 'open' and o.ready_for_install
  and not exists (select 1 from planning.assignments a where a.order_id = o.id and a.active)
order by o.due_date nulls last;

create or replace function planning.assert_planner() returns void language plpgsql stable as $$
begin
  if not (core.has_any_role(array['admin','manager','production_head','production_deputy'])
          or session_user like 'svc_%' or exists (select 1 from pg_roles where rolname = session_user and rolsuper)) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
end $$;

create or replace function planning.ensure_slot(p_day date, p_direction uuid, p_vehicle uuid) returns uuid
language plpgsql security definer set search_path = planning, public as $$
declare v uuid;
begin
  perform planning.assert_planner();
  select id into v from planning.slots where day = p_day and vehicle_id = p_vehicle;
  if v is not null then
    if (select direction_id from planning.slots where id = v) <> p_direction then
      raise exception 'Машина уже занята на % другим направлением', p_day;
    end if;
    return v;
  end if;
  insert into planning.slots (day, direction_id, vehicle_id) values (p_day, p_direction, p_vehicle) returning id into v;
  return v;
end $$;

-- Поставить заказ в машину (или перенести в другую).
create or replace function planning.assign(p_order uuid, p_slot uuid, p_seq int default null) returns jsonb
language plpgsql security definer set search_path = planning, core, bus, public as $$
declare v_prev planning.assignments; v_day date; v_new_day date; s record;
begin
  perform planning.assert_planner();
  select * into v_prev from planning.assignments where order_id = p_order and active;
  select day into v_new_day from planning.slots where id = p_slot;
  if v_new_day is null then raise exception 'Нет такого слота'; end if;
  if v_prev.id is not null then
    if v_prev.slot_id = p_slot then return jsonb_build_object('unchanged', true); end if;
    update planning.assignments set active = false where id = v_prev.id;
    select day into v_day from planning.slots where id = v_prev.slot_id;
  end if;
  insert into planning.assignments (slot_id, order_id, seq, confirm_status)
  values (p_slot, p_order, coalesce(p_seq, (select coalesce(max(seq), 0) + 10 from planning.assignments where slot_id = p_slot and active)),
          case when v_prev.id is not null and v_day = v_new_day then v_prev.confirm_status else 'not_sent' end);
  if v_prev.id is null then
    perform bus.publish('installation.planned', 'order:' || p_order,
      jsonb_build_object('orderId', p_order, 'date', v_new_day, 'slotId', p_slot, 'directionId', (select direction_id from planning.slots where id = p_slot)));
  elsif v_day <> v_new_day then
    perform bus.publish('installation.rescheduled', 'order:' || p_order,
      jsonb_build_object('orderId', p_order, 'from', v_day, 'to', v_new_day, 'slotId', p_slot));
  end if;
  select load_kg, capacity_kg, overload into s from planning.api_slots where id = p_slot;
  return jsonb_build_object('loadKg', s.load_kg, 'capacityKg', s.capacity_kg, 'overload', s.overload);
end $$;

create or replace function planning.unassign(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = planning, bus, public as $$
begin
  perform planning.assert_planner();
  update planning.assignments set active = false where order_id = p_order and active;
  if found then
    perform bus.publish('installation.cancelled', 'order:' || p_order, jsonb_build_object('orderId', p_order, 'reason', p_reason));
  end if;
end $$;

-- Ближайшие дни, куда можно поставить заказ: машины того же направления со свободным тоннажем,
-- затем дни, где есть свободная машина. Резервный день (пятница) — в конце списка.
create or replace function planning.free_dates(p_order uuid, p_from date default current_date + 1, p_limit int default 3)
returns table (day date, slot_id uuid, vehicle_id uuid, reserve boolean)
language sql stable security definer set search_path = planning, core, public as $$
  with o as (select direction_id, weight_kg from core.api_orders where id = p_order),
  cfg as (select value from core.settings where key = 'planning'),
  days as (
    select d::date as day from generate_series(p_from, p_from + ((select value->>'horizonDays' from cfg)::int), interval '1 day') d
    where extract(isodow from d)::int in (select jsonb_array_elements_text(value->'workDays')::int from cfg)
  ),
  existing as (
    select s.day, s.id as slot_id, s.vehicle_id from planning.api_slots s, o
    where s.direction_id = o.direction_id and s.day >= p_from and s.status in ('draft','approved')
      and s.load_kg + coalesce(o.weight_kg, 0) <= s.capacity_kg
  ),
  empty as (
    select d.day, null::uuid as slot_id, v.id as vehicle_id from days d
    cross join lateral (select v.id from core.vehicles v, o where v.active and v.capacity_kg >= coalesce(o.weight_kg, 0)
                        and not exists (select 1 from planning.slots s where s.day = d.day and s.vehicle_id = v.id)
                        order by v.capacity_kg limit 1) v
  ),
  candidates as (
    select distinct on (day) day, slot_id, vehicle_id from (select * from existing union all select * from empty) x
    order by day, slot_id nulls last
  )
  select day, slot_id, vehicle_id, planning.is_reserve(day) from candidates
  order by planning.is_reserve(day), day
  limit p_limit
$$;

-- «Отправить на подтверждение» из списка: бот спросит клиентов.
create or replace function planning.request_confirmation(p_orders uuid[]) returns int
language plpgsql security definer set search_path = planning, bus, public as $$
declare r record; n int := 0;
begin
  perform planning.assert_planner();
  for r in select a.id, a.order_id, s.day from planning.assignments a join planning.slots s on s.id = a.slot_id
           where a.active and a.order_id = any(p_orders) and a.confirm_status in ('not_sent','call_me') loop
    update planning.assignments set confirm_status = 'sent', confirm_at = now() where id = r.id;
    perform bus.publish('confirmation.requested', 'order:' || r.order_id,
      jsonb_build_object('orderId', r.order_id, 'assignmentId', r.id, 'date', r.day));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Ответ клиента из бота.
create or replace function planning.apply_confirmation(p_order uuid, p_answer text, p_date date default null) returns text
language plpgsql security definer set search_path = planning, core, bus, public as $$
declare a planning.assignments; s planning.slots; v_target uuid; c record;
begin
  select * into a from planning.assignments where order_id = p_order and active;
  if a.id is null then return 'no_assignment'; end if;
  select * into s from planning.slots where id = a.slot_id;
  if p_answer = 'confirmed' then
    update planning.assignments set confirm_status = 'confirmed', confirm_at = now() where id = a.id;
    return 'confirmed';
  elsif p_answer = 'other_date' and p_date is not null then
    select * into c from planning.free_dates(p_order, p_date, 10) f where f.day = p_date limit 1;
    if c.day is null then
      update planning.assignments set confirm_status = 'call_me', confirm_at = now() where id = a.id;
      return 'no_capacity';
    end if;
    v_target := coalesce(c.slot_id, planning.ensure_slot(c.day, s.direction_id, c.vehicle_id));
    perform planning.assign(p_order, v_target);
    update planning.assignments set confirm_status = 'confirmed', confirm_at = now() where order_id = p_order and active;
    return 'moved';
  elsif p_answer = 'call_me' or p_answer = 'other_date' then
    update planning.assignments set confirm_status = 'call_me', confirm_at = now() where id = a.id;
    return 'call_me';
  elsif p_answer = 'declined' then
    perform planning.unassign(p_order, 'Клиент отказался от даты');
    return 'declined';
  end if;
  raise exception 'unknown answer %', p_answer;
end $$;

-- Накладная на экипаж: порядок адресов и состав каждого заказа. Печать фиксирует состав и запускает погрузку.
create or replace function planning.print_waybill(p_slot uuid) returns jsonb
language plpgsql security definer set search_path = planning, core, bus, public as $$
declare s record; v_id text; v_content jsonb; v_orders uuid[];
begin
  perform planning.assert_planner();
  select * into s from planning.api_slots where id = p_slot;
  if s.id is null then raise exception 'Нет такого слота'; end if;
  select array_agg(order_id order by seq), jsonb_agg(jsonb_build_object(
           'seq', seq, 'orderId', order_id, 'number', number, 'customer', customer_name, 'phone', customer_phone,
           'cemetery', cemetery, 'plot', plot, 'weightKg', weight_kg, 'confirm', confirm_status,
           'items', (select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty, 'kind', i.kind) order by i.line_no)
                     from core.api_order_items i where i.order_id = x.order_id and coalesce(i.kind, '') <> 'service'))
         order by seq)
    into v_orders, v_content
  from planning.api_assignments x where slot_id = p_slot;
  if v_orders is null then raise exception 'В машине нет заказов'; end if;
  v_id := 'W-' || to_char(s.day, 'YYYYMMDD') || '-' || regexp_replace(s.vehicle, '\D', '', 'g');
  insert into planning.waybills (id, slot_id, day, content, printed_by)
  values (v_id, p_slot, s.day, jsonb_build_object('day', s.day, 'direction', s.direction, 'vehicle', s.vehicle, 'crew', s.crew,
          'loadKg', s.load_kg, 'capacityKg', s.capacity_kg, 'weather', s.weather, 'orders', v_content), auth.uid())
  on conflict (id) do update set content = excluded.content, printed_at = now(), printed_by = excluded.printed_by;
  update planning.slots set status = 'printed' where id = p_slot;
  perform bus.publish('waybill.printed', null,
    jsonb_build_object('waybillId', v_id, 'date', s.day, 'vehicleId', s.vehicle_id, 'orderIds', to_jsonb(v_orders)));
  return (select content || jsonb_build_object('id', id) from planning.waybills where id = v_id);
end $$;

create or replace function planning.mark_installed(p_order uuid) returns void
language sql security definer set search_path = planning, public as $$
  update planning.assignments set active = false where order_id = p_order and active
$$;

-- Роли сервисов
select core.ensure_service_role('svc_planning');
grant usage on schema planning to svc_planning;
grant execute on function planning.apply_confirmation(uuid, text, date), planning.unassign(uuid, text), planning.mark_installed(uuid) to svc_planning;

select core.ensure_service_role('svc_weather');
grant usage on schema weather to svc_weather;
grant select, insert, update, delete on weather.forecasts to svc_weather;
grant select on core.directions to svc_weather;

-- Доступ пользователей
alter table weather.forecasts enable row level security;
alter table planning.slots enable row level security;
alter table planning.assignments enable row level security;
alter table planning.waybills enable row level security;
create policy forecasts_read on weather.forecasts for select to authenticated using (true);
create policy slots_read on planning.slots for select to authenticated using (core.is_staff() or core.has_any_role(array['storekeeper','crew']));
create policy slots_write on planning.slots for all to authenticated
  using (core.has_any_role(array['admin','manager','production_head','production_deputy']))
  with check (core.has_any_role(array['admin','manager','production_head','production_deputy']));
create policy assignments_read on planning.assignments for select to authenticated using (core.is_staff() or core.has_any_role(array['storekeeper','crew']));
create policy waybills_read on planning.waybills for select to authenticated using (core.is_staff() or core.has_any_role(array['storekeeper','crew','station']));
grant usage on schema weather, planning to authenticated;
grant select on weather.forecasts, planning.slots, planning.assignments, planning.waybills,
                planning.api_slots, planning.api_assignments, planning.api_ready_unplanned to authenticated;
grant insert, update, delete on planning.slots to authenticated;
grant execute on function planning.ensure_slot(date, uuid, uuid), planning.assign(uuid, uuid, int), planning.unassign(uuid, text),
  planning.free_dates(uuid, date, int), planning.request_confirmation(uuid[]), planning.print_waybill(uuid) to authenticated;

-- Сервис погоды — полный доступ к своей таблице.
create policy forecasts_service on weather.forecasts for all to svc_weather using (true) with check (true);
