-- 0300. Модуль «Распределение работ и контроль сроков» (сервис workload).
-- Очередь участка = изделия, для которых этот участок следующий по маршруту, по запасу дней.
create schema if not exists workload;
comment on schema workload is 'Нормы, очереди участков, риски просрочки';

create table workload.norms (
  station_code text primary key references tracking.stations(code) on update cascade,
  minutes      numeric(7,1) not null check (minutes >= 0)   -- норма на одно изделие
);
insert into workload.norms values ('milling', 60), ('laser', 120), ('sandblast', 60), ('photo', 20), ('chamfer', 40), ('kit', 60);

insert into core.settings (key, value) values ('workload', '{"riskSlackDays": 2, "bufferDays": 1, "workdayHours": 8}')
on conflict (key) do nothing;

create table workload.risks (
  order_id   uuid not null references core.orders(id) on delete cascade,
  day        date not null default current_date,
  slack_days int not null,
  primary key (order_id, day)
);

-- Позиция каждого активного изделия по маршруту.
create or replace view workload.api_unit_route with (security_invoker = true) as
with done as (
  select cargo_unit_id, array_agg(distinct station_code) filter (where action = 'done') as done_st,
         (array_agg(station_code order by scanned_at desc, id desc))[1] as last_station,
         (array_agg(action order by scanned_at desc, id desc))[1] as last_action
  from tracking.scans group by cargo_unit_id
), cfg as (select value from core.settings where key = 'workload')
select u.id as cargo_unit_id, u.order_id, u.kind, o.number, o.due_date, (o.due_date - current_date) as days_left,
       nxt.code as next_station,
       coalesce(rem.minutes, 0) as remaining_minutes,
       (o.due_date - current_date)
         - ceil(coalesce(rem.minutes, 0) / (60.0 * ((select value from cfg)->>'workdayHours')::numeric))::int
         - ((select value from cfg)->>'bufferDays')::int as slack_days,
       coalesce(d.last_station = nxt.code and d.last_action = 'take', false) as in_work
from tracking.cargo_units u
join core.orders o on o.id = u.order_id and o.status = 'open'
left join done d on d.cargo_unit_id = u.id
left join lateral (
  select s.code from tracking.stations s
  where s.active and s.in_route and s.applies_to in (u.kind, 'any') and not (s.code = any(coalesce(d.done_st, '{}')))
  order by s.sort limit 1
) nxt on true
left join lateral (
  select sum(n.minutes) as minutes from tracking.stations s join workload.norms n on n.station_code = s.code
  where s.active and s.in_route and s.applies_to in (u.kind, 'any') and not (s.code = any(coalesce(d.done_st, '{}')))
) rem on true
where u.active;

create or replace view workload.api_queue with (security_invoker = true) as
select r.next_station as station_code, r.cargo_unit_id, r.order_id, r.number, r.due_date, r.days_left, r.slack_days, r.in_work, r.remaining_minutes
from workload.api_unit_route r where r.next_station is not null
order by r.slack_days nulls last, r.due_date;

create or replace view workload.api_station_load with (security_invoker = true) as
select s.code as station_code, s.title, s.hours_per_day,
       count(q.cargo_unit_id) filter (where q.in_work) as in_work,
       count(q.cargo_unit_id) filter (where not q.in_work) as queued,
       count(q.cargo_unit_id) filter (where q.slack_days <= 0) as hot,
       coalesce(sum(n.minutes) filter (where q.cargo_unit_id is not null), 0) / 60.0 as queue_hours
from tracking.stations s
left join workload.api_queue q on q.station_code = s.code
left join workload.norms n on n.station_code = s.code
where s.active
group by s.code, s.title, s.hours_per_day, s.sort
order by s.sort;

-- Готово, но не установлено: сколько дней стоит.
create or replace view workload.api_ready_waiting with (security_invoker = true) as
select o.id as order_id, o.number, o.due_date, o.direction, o.customer_name,
       current_date - coalesce((select max(e.occurred_at)::date from core.order_events e
                                where e.order_id = o.id and e.type = 'order.stage_changed' and e.payload->>'to' = 'ready'),
                               o.updated_at::date) as days_waiting
from core.api_orders o where o.status = 'open' and o.stage_code = 'ready';

create or replace function workload.detect_risks() returns int
language plpgsql security definer set search_path = workload, core, bus, public as $$
declare r record; n int := 0; v_thr int;
begin
  select (value->>'riskSlackDays')::int into v_thr from core.settings where key = 'workload';
  for r in select order_id, min(slack_days) as slack, max(number) as number from workload.api_unit_route
           where next_station is not null group by order_id having min(slack_days) <= v_thr loop
    insert into workload.risks (order_id, slack_days) values (r.order_id, r.slack) on conflict do nothing;
    if found then
      n := n + 1;
      perform bus.publish('workload.risk_detected', 'order:' || r.order_id,
        jsonb_build_object('orderId', r.order_id, 'number', r.number, 'slackDays', r.slack),
        'workload.risk:' || r.order_id || ':' || current_date);
    end if;
  end loop;
  return n;
end $$;

select core.ensure_service_role('svc_workload');
grant usage on schema workload to svc_workload;
grant execute on function workload.detect_risks() to svc_workload;

alter table workload.norms enable row level security;
alter table workload.risks enable row level security;
create policy norms_read on workload.norms for select to authenticated using (true);
create policy norms_admin on workload.norms for all to authenticated using (core.has_any_role(array['admin','production_head'])) with check (core.has_any_role(array['admin','production_head']));
create policy risks_read on workload.risks for select to authenticated using (core.is_staff());
grant usage on schema workload to authenticated;
grant select on workload.norms, workload.risks, workload.api_unit_route, workload.api_queue, workload.api_station_load, workload.api_ready_waiting to authenticated;
grant insert, update on workload.norms to authenticated;
