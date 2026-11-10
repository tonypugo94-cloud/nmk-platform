-- 1300. Погода из МетеоПлана в планировщик, автоплан «сегодня на послезавтра».
-- МетеоПлан отдаёт по каждому городу и дню: вероятность и количество осадков, категорию дня
-- (clear / low_chance / light_rain / heavy_rain), признак снега, дневную температуру и уверенность прогноза.

alter table weather.forecasts
  add column if not exists category   text,            -- clear | low_chance | light_rain | heavy_rain
  add column if not exists is_snow    boolean,
  add column if not exists max_temp_c numeric(4,1),
  add column if not exists confidence text;            -- high | medium | low (сколько источников согласны)

-- Сервис погоды сам сопоставляет направление с городом МетеоПлана по названию, если meteo_ref пуст.
grant update (meteo_ref) on core.directions to svc_weather;
create policy directions_weather_update on core.directions for update to svc_weather using (true) with check (true);

-- Настройки автоплана. Значения поверх прежних: проект ещё не в эксплуатации.
--  planFromDays  — с какого дня от сегодняшнего планировать (2 = послезавтра);
--  horizonDays   — сколько рабочих дней собирать (1 = только этот день; воскресенье и резервная пятница пропускаются);
--  runAt         — во сколько (МСК) собирать план: после обновления МетеоПлана в 16:00;
--  skipCategories, rainSkipProb, skipSnow — когда день по направлению считается непригодным.
update core.settings set value = value || '{"planFromDays": 2, "horizonDays": 1, "runAt": "16:30",
  "skipCategories": ["heavy_rain"], "rainSkipProb": 80, "skipSnow": false}'::jsonb
where key = 'autoplan';

alter table autoplan.runs add column if not exists trigger text not null default 'manual'; -- daily | event | manual
alter table autoplan.runs add column if not exists target_days date[];

-- Прогноз в данных для алгоритма — с категорией и снегом.
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
    'weather', coalesce((select jsonb_agg(jsonb_build_object('directionId', f.direction_id, 'day', f.day, 'precipProb', f.precip_prob,
        'category', f.category, 'isSnow', f.is_snow))
      from weather.forecasts f where f.day between p_from and p_from + p_days * 2), '[]'::jsonb),
    'unordered', coalesce((select jsonb_agg(jsonb_build_object('id', u.order_id, 'number', u.number)) from planning.api_ready_unplanned u where u.direction_id is null), '[]'::jsonb)
  )
$$;

-- Кнопка «Собрать план сейчас» для менеджера: сервис автоплана получает событие и пересобирает.
create or replace function autoplan.request_run() returns void
language plpgsql security definer set search_path = autoplan, bus, core, public as $$
begin
  if not core.has_any_role(array['admin','manager','production_head','production_deputy']) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  perform bus.publish('autoplan.requested', null, jsonb_build_object('by', auth.uid()));
end $$;
grant execute on function autoplan.request_run() to authenticated;

-- Итог последнего запуска — для плашки на экране «Установки».
create or replace view autoplan.api_last_run with (security_invoker = true) as
select id, started_at, finished_at, trigger, target_days, planned, skipped, error
from autoplan.runs order by id desc limit 1;
grant select on autoplan.api_last_run to authenticated;
