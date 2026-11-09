-- 0001. Фундамент: роли пользователей, реестр модулей, настройки, сервисные роли БД.
-- Всё, что ниже, не зависит ни от одного прикладного модуля.

create extension if not exists pgcrypto;

create schema if not exists core;
comment on schema core is 'Ядро: пользователи, роли, реестр модулей, справочники, заказы';

-- ─── Роли пользователей ────────────────────────────────────────────────────────
-- Роли — данные, а не enum: новый модуль добавляет свои роли без изменения ядра.
create table core.roles (
  code        text primary key,
  title       text not null,
  module_key  text,                       -- какой модуль принёс роль (null — ядро)
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into core.roles (code, title, enabled) values
  ('admin',             'Администратор',                    true),
  ('manager',           'Менеджер',                         true),
  ('production_head',   'Начальник производства',           true),
  ('production_deputy', 'Заместитель начальника производства', true),
  ('owner',             'Собственник',                      false),
  ('station',           'Участок производства',             false),
  ('storekeeper',       'Кладовщик',                        false),
  ('crew',              'Бригада',                          false);

create table core.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  phone       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table core.user_roles (
  user_id   uuid not null references core.profiles(user_id) on delete cascade,
  role_code text not null references core.roles(code) on update cascade,
  primary key (user_id, role_code)
);

create or replace function core.has_role(p_role text) returns boolean
language sql stable security definer set search_path = core, public as $$
  select exists (
    select 1 from core.user_roles ur
    join core.roles r on r.code = ur.role_code and r.enabled
    join core.profiles p on p.user_id = ur.user_id and p.active
    where ur.user_id = auth.uid() and ur.role_code = p_role
  )
$$;

create or replace function core.has_any_role(p_roles text[]) returns boolean
language sql stable security definer set search_path = core, public as $$
  select exists (
    select 1 from core.user_roles ur
    join core.roles r on r.code = ur.role_code and r.enabled
    join core.profiles p on p.user_id = ur.user_id and p.active
    where ur.user_id = auth.uid() and ur.role_code = any(p_roles)
  )
$$;

create or replace function core.is_staff() returns boolean
language sql stable as $$ select core.has_any_role(array['admin','manager','production_head','production_deputy','owner']) $$;

-- ─── Реестр модулей ────────────────────────────────────────────────────────────
-- Каждый сервис при старте регистрирует свой манифест. Интерфейс строит меню из
-- включённых модулей. Новый модуль = новая запись, ядро не меняется.
create table core.app_modules (
  key           text primary key,              -- 'orders', 'planning', 'tracking'…
  title         text not null,
  description   text,
  version       text not null default '0.0.0',
  enabled       boolean not null default false, -- включает администратор
  depends_on    text[] not null default '{}',
  roles         text[] not null default '{}',   -- кому виден модуль в меню
  menu          jsonb not null default '[]'::jsonb, -- [{path, title, roles?}]
  service       text,                           -- имя сервиса-владельца
  health_url    text,
  registered_at timestamptz not null default now(),
  heartbeat_at  timestamptz
);

create or replace function core.register_module(p_manifest jsonb) returns void
language plpgsql security definer set search_path = core, public as $$
begin
  insert into core.app_modules (key, title, description, version, depends_on, roles, menu, service, health_url, heartbeat_at)
  values (
    p_manifest->>'key',
    p_manifest->>'title',
    p_manifest->>'description',
    coalesce(p_manifest->>'version', '0.0.0'),
    coalesce(array(select jsonb_array_elements_text(p_manifest->'dependsOn')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_manifest->'roles')), '{}'),
    coalesce(p_manifest->'menu', '[]'::jsonb),
    coalesce(p_manifest->>'service', session_user),
    p_manifest->>'healthUrl',
    now()
  )
  on conflict (key) do update set
    title = excluded.title, description = excluded.description, version = excluded.version,
    depends_on = excluded.depends_on, roles = excluded.roles, menu = excluded.menu,
    service = excluded.service, health_url = excluded.health_url, heartbeat_at = now();
  -- enabled намеренно не трогаем: включение — решение администратора.
end $$;

create or replace function core.module_heartbeat(p_key text) returns void
language sql security definer set search_path = core, public as $$
  update core.app_modules set heartbeat_at = now() where key = p_key
$$;

create or replace function core.module_enabled(p_key text) returns boolean
language sql stable security definer set search_path = core, public as $$
  select coalesce((select enabled from core.app_modules where key = p_key), false)
$$;

-- Состояние модулей для интерфейса: «работает / нет связи N минут».
create or replace view core.api_modules with (security_invoker = true) as
select key, title, description, version, enabled, depends_on, roles, menu, heartbeat_at,
       (service = 'db' or (heartbeat_at is not null and heartbeat_at > now() - interval '2 minutes')) as alive
from core.app_modules;

-- ─── Настройки ─────────────────────────────────────────────────────────────────
create table core.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into core.settings (key, value) values
  ('company', '{"name": "Нижегородская мемориальная компания"}'),
  ('pii_retention_days', '365');

-- ─── Сервисные роли БД ─────────────────────────────────────────────────────────
-- У каждого сервиса своя роль. Создаётся NOLOGIN; пароль и LOGIN выставляет
-- скрипт развёртывания (infra/db-roles.sh), пароли в репозиторий не попадают.
create or replace function core.ensure_service_role(p_role text) returns void
language plpgsql as $$
begin
  if p_role !~ '^svc_[a-z0-9_]+$' then
    raise exception 'service role name must match svc_[a-z0-9_]+: %', p_role;
  end if;
  if not exists (select 1 from pg_roles where rolname = p_role) then
    execute format('create role %I nologin', p_role);
  end if;
  execute format('grant usage on schema core to %I', p_role);
  execute format('grant execute on function core.register_module(jsonb), core.module_heartbeat(text), core.module_enabled(text) to %I', p_role);
end $$;

-- ─── Доступ для пользователей интерфейса ───────────────────────────────────────
alter table core.roles enable row level security;
alter table core.profiles enable row level security;
alter table core.user_roles enable row level security;
alter table core.app_modules enable row level security;
alter table core.settings enable row level security;

create policy roles_read on core.roles for select to authenticated using (true);
create policy roles_admin on core.roles for all to authenticated using (core.has_role('admin')) with check (core.has_role('admin'));

create policy profiles_read on core.profiles for select to authenticated using (user_id = auth.uid() or core.is_staff());
create policy profiles_admin on core.profiles for all to authenticated using (core.has_role('admin')) with check (core.has_role('admin'));

create policy user_roles_read on core.user_roles for select to authenticated using (user_id = auth.uid() or core.has_role('admin'));
create policy user_roles_admin on core.user_roles for all to authenticated using (core.has_role('admin')) with check (core.has_role('admin'));

create policy modules_read on core.app_modules for select to authenticated using (true);
create policy modules_admin on core.app_modules for update to authenticated using (core.has_role('admin')) with check (core.has_role('admin'));

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'nmk_services') then create role nmk_services nologin; end if;
end $$;
create policy settings_services on core.settings for select to nmk_services using (true);
grant usage on schema core to nmk_services;
grant select on core.settings to nmk_services;

create policy settings_read on core.settings for select to authenticated using (core.is_staff());
create policy settings_admin on core.settings for all to authenticated using (core.has_role('admin')) with check (core.has_role('admin'));

grant usage on schema core to authenticated;
grant select on core.roles, core.profiles, core.user_roles, core.app_modules, core.settings, core.api_modules to authenticated;
grant insert, update, delete on core.roles, core.profiles, core.user_roles, core.settings to authenticated;
grant update (enabled) on core.app_modules to authenticated;
