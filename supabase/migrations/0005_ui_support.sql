-- 0005. Поддержка интерфейса: realtime, первый администратор.

-- Realtime: менеджеры видят изменения заказов без перезагрузки (если публикация Supabase есть).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table core.orders, core.app_modules;
  end if;
end $$;

-- Назначить администратора по почте пользователя, созданного в Supabase Auth (выполняется вручную один раз).
create or replace function core.bootstrap_admin(p_email text, p_full_name text) returns void
language plpgsql security definer set search_path = core, public as $$
declare v uuid;
begin
  select id into v from auth.users where email = p_email;
  if v is null then raise exception 'пользователь % не найден в auth.users', p_email; end if;
  insert into core.profiles (user_id, full_name) values (v, p_full_name) on conflict (user_id) do update set full_name = excluded.full_name;
  insert into core.user_roles (user_id, role_code) values (v, 'admin') on conflict do nothing;
end $$;
revoke all on function core.bootstrap_admin(text, text) from public;
