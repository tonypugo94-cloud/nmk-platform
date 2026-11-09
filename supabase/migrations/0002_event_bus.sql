-- 0002. Шина событий внутри PostgreSQL.
--
-- Как работает:
--  * сервис вызывает bus.publish() в той же транзакции, где меняет свои данные
--    (transactional outbox без отдельного ретранслятора);
--  * триггер раскладывает событие по подписчикам (bus.deliveries);
--  * каждый подписчик забирает свои доставки через bus.claim() с SKIP LOCKED,
--    подтверждает bus.ack() или возвращает bus.nack() — с экспоненциальной паузой;
--  * после max попыток доставка уходит в статус dead и видна в bus.api_stats.
-- Если подписчик лежит, его доставки просто копятся и обрабатываются после старта.

create schema if not exists bus;
comment on schema bus is 'Шина событий: публикация, подписки, доставки с повторами';

create table bus.events (
  id              bigint generated always as identity primary key,
  type            text not null check (type ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  key             text,                         -- агрегат, например order:<uuid>
  payload         jsonb not null default '{}'::jsonb,
  source          text not null,
  idempotency_key text unique,
  occurred_at     timestamptz not null default now()
);
create index events_type_idx on bus.events (type, occurred_at desc);
create index events_key_idx on bus.events (key, occurred_at desc);

create table bus.subscriptions (
  subscriber text not null,
  pattern    text not null check (pattern ~ '^(\*|[a-z0-9_]+(\.([a-z0-9_]+|\*))*)$'),
  created_at timestamptz not null default now(),
  primary key (subscriber, pattern)
);

create table bus.deliveries (
  id           bigint generated always as identity primary key,
  event_id     bigint not null references bus.events(id) on delete cascade,
  subscriber   text not null,
  status       text not null default 'pending' check (status in ('pending','processing','done','dead')),
  attempts     int not null default 0,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error   text,
  done_at      timestamptz,
  unique (event_id, subscriber)
);
create index deliveries_claim_idx on bus.deliveries (subscriber, status, available_at) where status in ('pending','processing');

create or replace function bus.pattern_matches(p_pattern text, p_type text) returns boolean
language sql immutable as $$
  select p_pattern = '*' or p_type like replace(p_pattern, '*', '%')
$$;

create or replace function bus.fanout() returns trigger
language plpgsql security definer set search_path = bus, public as $$
begin
  insert into bus.deliveries (event_id, subscriber)
  select distinct new.id, s.subscriber
  from bus.subscriptions s
  where bus.pattern_matches(s.pattern, new.type)
  on conflict do nothing;
  return null;
end $$;

create trigger events_fanout after insert on bus.events
for each row execute function bus.fanout();

-- Проверка, что сервис работает только со своими доставками.
create or replace function bus.assert_subscriber(p_subscriber text) returns void
language plpgsql stable as $$
begin
  if p_subscriber is distinct from session_user
     and not exists (select 1 from pg_roles where rolname = session_user and (rolsuper or rolname = 'service_role')) then
    raise exception 'subscriber % does not match session user %', p_subscriber, session_user
      using errcode = 'insufficient_privilege';
  end if;
end $$;

create or replace function bus.publish(
  p_type text, p_key text, p_payload jsonb default '{}'::jsonb, p_idempotency_key text default null
) returns bigint
language plpgsql security definer set search_path = bus, public as $$
declare v_id bigint;
begin
  insert into bus.events (type, key, payload, source, idempotency_key)
  values (p_type, p_key, coalesce(p_payload, '{}'::jsonb),
          coalesce(nullif(current_setting('app.service', true), ''), session_user), p_idempotency_key)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from bus.events where idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end $$;

create or replace function bus.subscribe(p_subscriber text, p_patterns text[]) returns void
language plpgsql security definer set search_path = bus, public as $$
begin
  perform bus.assert_subscriber(p_subscriber);
  insert into bus.subscriptions (subscriber, pattern)
  select p_subscriber, unnest(p_patterns)
  on conflict do nothing;
  delete from bus.subscriptions where subscriber = p_subscriber and pattern <> all(p_patterns);
end $$;

create or replace function bus.claim(p_subscriber text, p_limit int default 20, p_lease_seconds int default 60)
returns table (delivery_id bigint, attempts int, event_id bigint, type text, key text, payload jsonb, source text, occurred_at timestamptz)
language plpgsql security definer set search_path = bus, public as $$
begin
  perform bus.assert_subscriber(p_subscriber);
  return query
  with picked as (
    select d.id from bus.deliveries d
    where d.subscriber = p_subscriber
      and ((d.status = 'pending' and d.available_at <= now())
        or (d.status = 'processing' and d.locked_until < now()))
    order by d.id
    for update skip locked
    limit p_limit
  ), upd as (
    update bus.deliveries d
       set status = 'processing',
           locked_until = now() + make_interval(secs => p_lease_seconds),
           attempts = d.attempts + 1
      from picked where d.id = picked.id
    returning d.id, d.attempts, d.event_id
  )
  select upd.id, upd.attempts, e.id, e.type, e.key, e.payload, e.source, e.occurred_at
  from upd join bus.events e on e.id = upd.event_id
  order by upd.id;
end $$;

create or replace function bus.ack(p_delivery_id bigint) returns void
language plpgsql security definer set search_path = bus, public as $$
declare v_sub text;
begin
  select subscriber into v_sub from bus.deliveries where id = p_delivery_id;
  perform bus.assert_subscriber(v_sub);
  update bus.deliveries
     set status = 'done', done_at = now(), locked_until = null, last_error = null
   where id = p_delivery_id;
end $$;

create or replace function bus.nack(p_delivery_id bigint, p_error text, p_max_attempts int default 8) returns text
language plpgsql security definer set search_path = bus, public as $$
declare v_sub text; v_attempts int; v_status text;
begin
  select subscriber, attempts into v_sub, v_attempts from bus.deliveries where id = p_delivery_id;
  perform bus.assert_subscriber(v_sub);
  v_status := case when v_attempts >= p_max_attempts then 'dead' else 'pending' end;
  update bus.deliveries
     set status = v_status,
         locked_until = null,
         last_error = left(p_error, 2000),
         available_at = now() + make_interval(secs => least(power(2, v_attempts) * 5, 900)::int)
   where id = p_delivery_id;
  return v_status;
end $$;

-- Вернуть «мёртвые» доставки в работу (после исправления причины).
create or replace function bus.requeue_dead(p_subscriber text) returns int
language plpgsql security definer set search_path = bus, public as $$
declare n int;
begin
  update bus.deliveries set status = 'pending', attempts = 0, available_at = now(), last_error = null
   where subscriber = p_subscriber and status = 'dead';
  get diagnostics n = row_count;
  return n;
end $$;

-- Чистка: обработанные доставки и события старше N дней.
create or replace function bus.prune(p_days int default 30) returns void
language sql security definer set search_path = bus, public as $$
  delete from bus.deliveries where status = 'done' and done_at < now() - make_interval(days => p_days);
  delete from bus.events e where e.occurred_at < now() - make_interval(days => p_days)
    and not exists (select 1 from bus.deliveries d where d.event_id = e.id);
$$;

create or replace view bus.api_stats as
select subscriber,
       count(*) filter (where status = 'pending')    as pending,
       count(*) filter (where status = 'processing') as processing,
       count(*) filter (where status = 'dead')       as dead,
       min(available_at) filter (where status = 'pending') as oldest_pending
from bus.deliveries
group by subscriber;

revoke all on all tables in schema bus from public;
revoke all on all functions in schema bus from public;
grant usage on schema bus to authenticated;
grant select on bus.api_stats to authenticated;
grant execute on function bus.pattern_matches(text, text), bus.assert_subscriber(text) to public;

-- Сервисная роль получает доступ к ядру и шине одной функцией.
create or replace function core.ensure_service_role(p_role text) returns void
language plpgsql as $$
begin
  if p_role !~ '^svc_[a-z0-9_]+$' then
    raise exception 'service role name must match svc_[a-z0-9_]+: %', p_role;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'nmk_services') then
    create role nmk_services nologin;  -- общая группа сервисов: для политик RLS «сервисам можно читать»
  end if;
  if not exists (select 1 from pg_roles where rolname = p_role) then
    execute format('create role %I nologin', p_role);
  end if;
  execute format('grant nmk_services to %I', p_role);
  execute format('grant usage on schema core, bus to %I', p_role);
  execute format('grant execute on function core.register_module(jsonb), core.module_heartbeat(text), core.module_enabled(text) to %I', p_role);
  execute format('grant execute on function bus.publish(text, text, jsonb, text), bus.subscribe(text, text[]), bus.claim(text, int, int), bus.ack(bigint), bus.nack(bigint, text, int) to %I', p_role);
end $$;
