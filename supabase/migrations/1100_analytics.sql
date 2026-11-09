-- 1100. Модуль «Панель собственника» (сервис analytics). Только чтение витрин, ничего не меняет.
create schema if not exists analytics;
comment on schema analytics is 'Витрины для собственника и недельная сводка';

insert into core.settings (key, value) values ('analytics', '{"penaltyPerDay": 0.03, "digestWeekday": 1, "digestHour": 8}')
on conflict (key) do nothing;

create table analytics.digests (
  week    date primary key,          -- понедельник недели, за которую сводка
  text    text not null,
  sent_at timestamptz not null default now()
);

-- Риск неустойки в рублях: просроченные и горящие заказы.
create or replace view analytics.api_risk with (security_invoker = true) as
select o.id as order_id, o.number, o.direction, o.stage_title, o.due_date, o.days_left, o.amount,
       coalesce((select min(r.slack_days) from workload.api_unit_route r where r.order_id = o.id and r.next_station is not null), o.days_left) as slack_days,
       round(coalesce(o.amount, 0) * (select (value->>'penaltyPerDay')::numeric from core.settings where key = 'analytics')
             * greatest(0, -coalesce((select min(r.slack_days) from workload.api_unit_route r where r.order_id = o.id and r.next_station is not null), o.days_left)), 0) as penalty_rub,
       (select string_agg(distinct q.station_code, ', ') from workload.api_queue q where q.order_id = o.id) as waiting_at
from core.api_orders o
where o.status = 'open' and o.stage_code <> 'installed' and o.due_date is not null
  and coalesce((select min(r.slack_days) from workload.api_unit_route r where r.order_id = o.id and r.next_station is not null), o.days_left) <= 2
order by penalty_rub desc, o.due_date;

-- План и факт установок по неделям.
create or replace view analytics.api_week_installs with (security_invoker = true) as
with weeks as (select generate_series(date_trunc('week', current_date) - interval '7 weeks', date_trunc('week', current_date), interval '1 week')::date as week),
plan as (
  select date_trunc('week', s.day)::date as week, count(distinct a.order_id) as planned
  from planning.assignments a join planning.slots s on s.id = a.slot_id join core.orders o on o.id = a.order_id
  where a.active or o.stage_code = 'installed' group by 1
),
fact as (
  select date_trunc('week', e.occurred_at)::date as week, count(distinct e.order_id) as installed
  from core.order_events e where e.type = 'order.stage_changed' and e.payload->>'to' = 'installed' group by 1
)
select w.week, coalesce(p.planned, 0) as planned, coalesce(f.installed, 0) as installed
from weeks w left join plan p on p.week = w.week left join fact f on f.week = w.week order by w.week;

-- Почему переносили установки (8 недель).
create or replace view analytics.api_reschedule_reasons with (security_invoker = true) as
select reason, count(*) as cnt from (
  select case
    when e.type = 'confirmation.answered' and e.payload->>'answer' = 'other_date' then 'Клиент попросил другую дату'
    when e.type = 'confirmation.answered' and e.payload->>'answer' = 'declined' then 'Клиент отказался от даты'
    when e.type = 'installation.cancelled' then coalesce(e.payload->>'reason', 'Отмена')
    when e.type = 'installation.problem' then 'Проблема на выезде'
    when e.type = 'load.incomplete' then 'Неполная погрузка'
  end as reason
  from core.order_events e
  where e.occurred_at > now() - interval '8 weeks'
    and e.type in ('confirmation.answered','installation.cancelled','installation.problem','load.incomplete')
) x where reason is not null group by reason order by cnt desc;

create or replace function analytics.summary() returns jsonb
language sql stable security definer set search_path = analytics, core, planning, workload, warehouse, procurement, messaging, piecework, public as $$
  select jsonb_build_object(
    'riskOrders', (select count(*) from analytics.api_risk),
    'riskRub', (select coalesce(sum(penalty_rub), 0) from analytics.api_risk),
    'readyWaiting', (select count(*) from workload.api_ready_waiting),
    'readyWaitingAvgDays', (select round(avg(days_waiting)) from workload.api_ready_waiting),
    'readyWaitingRub', (select coalesce(sum(o.amount), 0) from workload.api_ready_waiting w join core.orders o on o.id = w.order_id),
    'week', (select jsonb_build_object('planned', planned, 'installed', installed) from analytics.api_week_installs order by week desc offset 1 limit 1),
    'currentWeek', (select jsonb_build_object('planned', planned, 'installed', installed) from analytics.api_week_installs order by week desc limit 1),
    'hotStations', (select coalesce(jsonb_agg(jsonb_build_object('station', title, 'hot', hot, 'queued', queued) order by hot desc), '[]'::jsonb)
                    from workload.api_station_load where hot > 0),
    'vehicleLoadPct', (select round(100 * avg(least(load_kg / nullif(capacity_kg, 0), 1.5))) from planning.api_slots
                       where day between date_trunc('week', current_date)::date and date_trunc('week', current_date)::date + 6 and orders > 0),
    'stockBelowMin', (select count(*) from procurement.api_needs where need_qty > 0),
    'lateSupplies', (select count(*) from procurement.drafts where status = 'approved' and eta < current_date),
    'botShare', (select round(100.0 * count(*) filter (where subscribed) / nullif(count(*), 0)) from messaging.api_order_contacts),
    'confirmHoursMedian', (select round(extract(epoch from percentile_cont(0.5) within group (order by a.confirm_at - m.sent_at)) / 3600)
                           from planning.assignments a join messaging.messages m on m.order_id = a.order_id and m.template = 'confirm_date'
                           where a.confirm_status = 'confirmed' and m.sent_at is not null and a.confirm_at > m.sent_at
                             and m.sent_at > now() - interval '30 days'),
    'pieceworkMonthRub', (select coalesce(sum(amount), 0) from piecework.records where voided_at is null and recorded_at >= date_trunc('month', now()))
  )
$$;

-- Текст недельной сводки для собственника.
create or replace function analytics.digest_text(p_week date default (date_trunc('week', current_date) - interval '7 days')::date) returns text
language plpgsql stable security definer set search_path = analytics, core, public as $$
declare s jsonb; t text; w date := p_week;
begin
  s := analytics.summary();
  t := format('НМК · неделя %s–%s', to_char(w, 'DD.MM'), to_char(w + 6, 'DD.MM'));
  t := t || E'\nУстановлено ' || coalesce(s->'week'->>'installed', '0') || ' из ' || coalesce(s->'week'->>'planned', '0') || ' запланированных';
  t := t || E'\nПод риском неустойки: ' || (s->>'riskOrders') || ' заказ(ов), ' || to_char((s->>'riskRub')::numeric, 'FM999G999G999') || ' ₽';
  t := t || E'\nГотово под навесом: ' || (s->>'readyWaiting') || coalesce(', в среднем ' || (s->>'readyWaitingAvgDays') || ' дн.', '');
  if jsonb_array_length(s->'hotStations') > 0 then
    t := t || E'\nУзкое место: ' || (s->'hotStations'->0->>'station') || ', горит ' || (s->'hotStations'->0->>'hot');
  end if;
  if (s->>'stockBelowMin')::int > 0 then t := t || E'\nНиже минимума на складе: ' || (s->>'stockBelowMin') || ' поз.'; end if;
  if (s->>'lateSupplies')::int > 0 then t := t || E'\nОпаздывают поставки: ' || (s->>'lateSupplies'); end if;
  return t;
end $$;

insert into core.roles (code, title, module_key, enabled) values ('owner', 'Собственник', 'analytics', true)
on conflict (code) do update set module_key = 'analytics', enabled = true;

select core.ensure_service_role('svc_analytics');
grant usage on schema analytics to svc_analytics;
grant select, insert on analytics.digests to svc_analytics;
grant execute on function analytics.digest_text(date), analytics.summary() to svc_analytics;

alter table analytics.digests enable row level security;
create policy digests_read on analytics.digests for select to authenticated using (core.has_any_role(array['admin','owner']));
create policy digests_service on analytics.digests for all to svc_analytics using (true) with check (true);
grant usage on schema analytics to authenticated;
grant select on analytics.digests, analytics.api_risk, analytics.api_week_installs, analytics.api_reschedule_reasons to authenticated;
grant execute on function analytics.summary() to authenticated;

-- Отправка сводки в мессенджер собственнику (чаты задаются в настройках messaging.ownerChats).
insert into messaging.templates (code, title, body) values ('digest', 'Сводка собственнику', '{text}') on conflict do nothing;

create or replace function messaging.enqueue_direct(p_channel text, p_chat text, p_template text, p_vars jsonb) returns uuid
language plpgsql security definer set search_path = messaging, public as $$
declare v uuid; v_body text; k text;
begin
  select body into v_body from messaging.templates where code = p_template and enabled;
  for k in select jsonb_object_keys(p_vars) loop v_body := replace(v_body, '{' || k || '}', coalesce(p_vars->>k, '')); end loop;
  insert into messaging.messages (channel, chat_id, template, body) values (p_channel, p_chat, p_template, v_body) returning id into v;
  return v;
end $$;
grant execute on function messaging.enqueue_direct(text, text, text, jsonb) to svc_messaging;
