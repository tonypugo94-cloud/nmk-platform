-- 0800. Модуль «Приложение бригады» (без отдельного сервиса: всё — функции БД, телефон работает и при недоступных сервисах).
create schema if not exists crew;
comment on schema crew is 'Маршрут бригады, фото до/после с геоточкой, отметка установки, проблемы на выезде';

create table crew.members (
  user_id uuid primary key references core.profiles(user_id) on delete cascade,
  crew_id uuid not null references core.crews(id) on delete cascade
);

create table crew.photos (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null unique,             -- id с телефона: повторная отправка не задваивает
  order_id   uuid not null references core.orders(id) on delete cascade,
  kind       text not null check (kind in ('before','after','problem','edge')),
  storage_path text not null,                  -- путь в Supabase Storage, бакет crew-photos
  taken_at   timestamptz not null,
  lat numeric(9,6), lon numeric(9,6), accuracy_m numeric(7,1),
  user_id    uuid,
  uploaded_at timestamptz not null default now()
);
create index photos_order_idx on crew.photos (order_id, kind);

create table crew.visits (
  order_id     uuid primary key references core.orders(id) on delete cascade,
  status       text not null check (status in ('installed','problem')),
  problem      text,
  user_id      uuid,
  updated_at   timestamptz not null default now()
);

create or replace function crew.assert_crew() returns void language plpgsql stable as $$
begin
  if not (core.has_any_role(array['admin','crew','manager','production_head','production_deputy'])
          or exists (select 1 from pg_roles where rolname = session_user and rolsuper)) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- Маршрут на день для бригады текущего пользователя (или всех — для офиса).
create or replace function crew.my_route(p_day date default current_date)
returns table (slot_id uuid, vehicle text, seq int, order_id uuid, number text, customer text, phone text,
               cemetery text, plot text, lat numeric, lon numeric, items jsonb, confirm_status text, visit_status text)
language plpgsql stable security definer set search_path = crew, planning, core, public as $$
declare v_crew uuid;
begin
  perform crew.assert_crew();
  select crew_id into v_crew from crew.members where user_id = auth.uid();
  return query
  select s.id, s.vehicle, a.seq, a.order_id, a.number, a.customer_name, a.customer_phone, a.cemetery, a.plot,
         cm.lat, cm.lon,
         (select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty) order by i.line_no) from core.api_order_items i
           where i.order_id = a.order_id and coalesce(i.kind, '') <> 'service'),
         a.confirm_status, v.status
  from planning.api_slots s
  join planning.api_assignments a on a.slot_id = s.id
  join core.orders o on o.id = a.order_id
  left join core.cemeteries cm on cm.id = o.cemetery_id
  left join crew.visits v on v.order_id = a.order_id
  where s.day = p_day and (v_crew is null or s.crew_id = v_crew)
  order by s.vehicle, a.seq;
end $$;

create or replace function crew.add_photo(p_order uuid, p_kind text, p_path text, p_taken_at timestamptz, p_lat numeric, p_lon numeric,
                                          p_accuracy numeric, p_client_id text) returns uuid
language plpgsql security definer set search_path = crew, bus, public as $$
declare v uuid;
begin
  perform crew.assert_crew();
  insert into crew.photos (client_id, order_id, kind, storage_path, taken_at, lat, lon, accuracy_m, user_id)
  values (p_client_id, p_order, p_kind, p_path, least(p_taken_at, now()), p_lat, p_lon, p_accuracy, auth.uid())
  on conflict (client_id) do nothing returning id into v;
  if v is not null then
    perform bus.publish('photo.uploaded', 'order:' || p_order, jsonb_build_object('orderId', p_order, 'photoId', v, 'kind', p_kind));
  end if;
  return coalesce(v, (select id from crew.photos where client_id = p_client_id));
end $$;

-- «Установлено». Без фото «после» не принимается — это доказательство в спорах.
create or replace function crew.complete(p_order uuid) returns void
language plpgsql security definer set search_path = crew, core, bus, public as $$
begin
  perform crew.assert_crew();
  if not exists (select 1 from crew.photos where order_id = p_order and kind = 'after') then
    raise exception 'Сначала сфотографируйте установленный памятник' using errcode = 'P0001';
  end if;
  insert into crew.visits (order_id, status, user_id) values (p_order, 'installed', auth.uid())
  on conflict (order_id) do update set status = 'installed', problem = null, user_id = excluded.user_id, updated_at = now();
  perform core.set_order_stage(p_order, 'installed', 'crew', 'Отметка бригады');
  perform bus.publish('installation.completed', 'order:' || p_order,
    jsonb_build_object('orderId', p_order, 'photos', (select count(*) from crew.photos where order_id = p_order)),
    'installation.completed:' || p_order);
end $$;

create or replace function crew.report_problem(p_order uuid, p_text text) returns void
language plpgsql security definer set search_path = crew, bus, public as $$
begin
  perform crew.assert_crew();
  insert into crew.visits (order_id, status, problem, user_id) values (p_order, 'problem', p_text, auth.uid())
  on conflict (order_id) do update set status = 'problem', problem = excluded.problem, user_id = excluded.user_id, updated_at = now();
  perform bus.publish('installation.problem', 'order:' || p_order, jsonb_build_object('orderId', p_order, 'text', p_text));
end $$;

-- Бакет для фото (если Storage Supabase установлен).
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('crew-photos', 'crew-photos', false) on conflict do nothing;
  end if;
end $$;

insert into core.roles (code, title, module_key, enabled) values ('crew', 'Бригада', 'crew', true)
on conflict (code) do update set module_key = 'crew', enabled = true;

-- Модуль без сервиса: регистрируется миграцией.
insert into core.app_modules (key, title, description, version, depends_on, roles, menu, service)
values ('crew', 'Бригада', 'Маршрут на день, фото до и после с геоточкой, «Установлено», «Проблема»', '0.1.0', '{planning}',
        '{admin,crew,manager,production_head,production_deputy}',
        '[{"path": "/crew", "title": "Выезд"}]', 'db')
on conflict (key) do nothing;

alter table crew.members enable row level security;
alter table crew.photos enable row level security;
alter table crew.visits enable row level security;
create policy members_read on crew.members for select to authenticated using (user_id = auth.uid() or core.is_staff());
create policy members_admin on crew.members for all to authenticated using (core.has_role('admin')) with check (core.has_role('admin'));
create policy photos_read on crew.photos for select to authenticated using (core.is_staff() or user_id = auth.uid());
create policy visits_read on crew.visits for select to authenticated using (core.is_staff() or core.has_role('crew'));
create policy photos_services on crew.photos for select to nmk_services using (true);
create policy visits_services on crew.visits for select to nmk_services using (true);
grant usage on schema crew to authenticated, nmk_services;
grant select on all tables in schema crew to authenticated;
grant select on crew.photos, crew.visits to nmk_services;
grant insert, update, delete on crew.members to authenticated;
grant execute on function crew.my_route(date), crew.add_photo(uuid, text, text, timestamptz, numeric, numeric, numeric, text),
  crew.complete(uuid), crew.report_problem(uuid, text) to authenticated;
