-- 0900. Модуль «Автопланировщик» (сервис autoplanner). Собирает машины на ближайшие дни,
-- отправляет клиентам даты на подтверждение. Менеджер утверждает. Выключен — работает ручное планирование.
create schema if not exists autoplan;
comment on schema autoplan is 'Запуски автопланировщика и их результаты';

insert into core.settings (key, value) values
  ('autoplan', '{"horizonDays": 5, "confirmLeadDays": 5, "rainSkipProb": 70, "base": {"lat": 56.150, "lon": 44.206}}')
on conflict (key) do nothing;

create table autoplan.runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  planned     int not null default 0,
  skipped     jsonb not null default '[]'::jsonb,   -- [{orderId, number, reason}]
  error       text
);

-- Всё, что нужно алгоритму, одним вызовом (сервис не читает таблицы планирования напрямую).
create or replace function autoplan.inputs(p_from date, p_days int) returns jsonb
language sql stable security definer set search_path = autoplan, planning, core, weather, public as $$
  select jsonb_build_object(
    'settings', (select value from core.settings where key = 'autoplan'),
    'planning', (select value from core.settings where key = 'planning'),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', u.order_id, 'number', u.number, 'directionId', u.direction_id, 'weightKg', u.weight_kg, 'dueDate', u.due_date,
        'lat', cm.lat, 'lon', cm.lon) order by u.due_date nulls last)
      from planning.api_ready_unplanned u join core.orders o on o.id = u.order_id left join core.cemeteries cm on cm.id = o.cemetery_id
      where u.direction_id is not null), '[]'::jsonb),
    'slots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'day', s.day, 'directionId', s.direction_id, 'vehicleId', s.vehicle_id,
        'loadKg', s.load_kg, 'capacityKg', s.capacity_kg, 'status', s.status))
      from planning.api_slots s where s.day between p_from and p_from + p_days * 2), '[]'::jsonb),
    'vehicles', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'capacityKg', v.capacity_kg) order by v.capacity_kg) from core.vehicles v where v.active), '[]'::jsonb),
    'weather', coalesce((select jsonb_agg(jsonb_build_object('directionId', f.direction_id, 'day', f.day, 'precipProb', f.precip_prob))
      from weather.forecasts f where f.day between p_from and p_from + p_days * 2), '[]'::jsonb),
    'unordered', coalesce((select jsonb_agg(jsonb_build_object('id', u.order_id, 'number', u.number)) from planning.api_ready_unplanned u where u.direction_id is null), '[]'::jsonb)
  )
$$;

-- Порядок объезда внутри машины.
create or replace function planning.set_sequence(p_slot uuid, p_orders uuid[]) returns void
language plpgsql security definer set search_path = planning, public as $$
begin
  perform planning.assert_planner();
  update planning.assignments a set seq = x.ord * 10
  from unnest(p_orders) with ordinality as x(order_id, ord)
  where a.slot_id = p_slot and a.active and a.order_id = x.order_id;
end $$;
grant execute on function planning.set_sequence(uuid, uuid[]) to authenticated;

-- Слоты, заказы в которых ещё не отправлены на подтверждение, и до даты осталось не больше N дней.
create or replace function autoplan.due_for_confirmation(p_lead int) returns uuid[]
language sql stable security definer set search_path = planning, public as $$
  select coalesce(array_agg(a.order_id), '{}') from planning.assignments a join planning.slots s on s.id = a.slot_id
  where a.active and a.confirm_status = 'not_sent' and s.day - current_date between 1 and p_lead
$$;

select core.ensure_service_role('svc_autoplanner');
grant usage on schema autoplan, planning to svc_autoplanner;
grant select, insert, update on autoplan.runs to svc_autoplanner;
grant execute on function autoplan.inputs(date, int), autoplan.due_for_confirmation(int), planning.ensure_slot(date, uuid, uuid),
  planning.assign(uuid, uuid, int), planning.set_sequence(uuid, uuid[]), planning.request_confirmation(uuid[]) to svc_autoplanner;

alter table autoplan.runs enable row level security;
create policy runs_read on autoplan.runs for select to authenticated using (core.is_staff());
create policy runs_service on autoplan.runs for all to svc_autoplanner using (true) with check (true);
grant usage on schema autoplan to authenticated;
grant select on autoplan.runs to authenticated;
