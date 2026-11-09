-- 0700. Модуль «Боты MAX и VK»: сервис messaging (логика) + шлюзы bot-max и bot-vk (только транспорт).
-- Каждое исходящее сообщение — неизменяемая запись: текст, канал, время отправки, доставки, прочтения.
-- Это доказательство для пункта договора о приглашении на просмотр.
create schema if not exists messaging;
comment on schema messaging is 'Подписки клиентов, согласия, шаблоны, очередь и журнал сообщений';

create table messaging.templates (
  code     text primary key,
  title    text not null,
  body     text not null,                    -- {number}, {date}, {cemetery}… подставляются из заказа
  buttons  jsonb not null default '[]'::jsonb, -- ряды кнопок: [[{"text": "...", "payload": "confirm:{order}"}]]
  enabled  boolean not null default true
);

insert into messaging.templates (code, title, body, buttons) values
  ('welcome', 'Подключение к заказу', 'Здравствуйте! Вы подключены к уведомлениям по заказу № {number}. Здесь будут статусы, фото готового памятника и согласование даты установки.', '[]'),
  ('stage_in_production', 'Заказ в работе', 'Заказ № {number} передан в производство.', '[]'),
  ('stage_ready', 'Памятник готов', 'Памятник по заказу № {number} готов. Скоро предложим дату установки.', '[]'),
  ('viewing_invite', 'Приглашение на просмотр', 'Памятник по заказу № {number} готов. Приглашаем вас на просмотр до {until} по адресу: {address}. Пожалуйста, подтвердите, что получили приглашение.', '[[{"text": "Получил(а) приглашение", "payload": "viewing_ack:{order}"}]]'),
  ('confirm_date', 'Подтверждение даты установки', 'Установка памятника по заказу № {number} запланирована на {date} ({cemetery}). Подтвердите, пожалуйста.', '[[{"text": "Подтверждаю", "payload": "confirm:{order}"}], [{"text": "Другая дата", "payload": "other:{order}"}], [{"text": "Позвоните мне", "payload": "call:{order}"}]]'),
  ('other_dates', 'Варианты даты', 'Выберите удобную дату установки:', '[]'),
  ('confirmed', 'Дата подтверждена', 'Спасибо! Установка {date}. Накануне напомним.', '[]'),
  ('call_back', 'Перезвоним', 'Менеджер позвонит вам в рабочее время.', '[]'),
  ('reminder', 'Напоминание накануне', 'Напоминаем: завтра, {date}, установка памятника по заказу № {number} ({cemetery}).', '[]'),
  ('installed', 'Установлено', 'Памятник по заказу № {number} установлен. Спасибо, что выбрали нас! Будем благодарны за отзыв.', '[]');

insert into core.settings (key, value) values
  ('messaging', '{"address": "г. Кстово", "reminderHour": 10, "undeliveredMinutes": 30, "noAnswerHours": 24, "viewingDays": 14, "linkCodeDays": 30}')
on conflict (key) do nothing;

create table messaging.link_codes (
  code       text primary key,
  order_id   uuid not null references core.orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table messaging.subscriptions (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references core.orders(id) on delete cascade,
  channel      text not null check (channel in ('max','vk')),
  chat_id      text not null,
  consent_at   timestamptz not null,
  consent_text text not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (order_id, channel, chat_id)
);

create table messaging.messages (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references core.orders(id) on delete set null,
  subscription_id uuid references messaging.subscriptions(id) on delete set null,
  channel      text not null,
  chat_id      text not null,
  template     text not null,
  body         text not null,
  buttons      jsonb not null default '[]'::jsonb,
  status       text not null default 'queued' check (status in ('queued','sending','sent','delivered','read','failed','cancelled')),
  not_before   timestamptz not null default now(),
  attempts     int not null default 0,
  locked_until timestamptz,
  external_id  text,
  last_error   text,
  alerted      boolean not null default false,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz, delivered_at timestamptz, read_at timestamptz, failed_at timestamptz
);
create index messages_queue_idx on messaging.messages (channel, status, not_before) where status in ('queued','sending');
create index messages_order_idx on messaging.messages (order_id, created_at);

-- Текст отправленного сообщения не меняется задним числом.
create or replace function messaging.protect_body() returns trigger language plpgsql as $$
begin
  if new.body is distinct from old.body or new.template is distinct from old.template or new.chat_id is distinct from old.chat_id then
    raise exception 'Сообщение неизменяемо';
  end if;
  return new;
end $$;
create trigger messages_immutable before update on messaging.messages for each row execute function messaging.protect_body();

create table messaging.inbound (
  id          bigint generated always as identity primary key,
  channel     text not null,
  chat_id     text not null,
  kind        text not null check (kind in ('start','text','button','delivered','read')),
  data        jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

-- Код для QR в салоне (deep-link «/start <код>»).
create or replace function messaging.create_link_code(p_order uuid) returns text
language plpgsql security definer set search_path = messaging, core, public as $$
declare v text; v_days int;
begin
  if not (core.is_staff() or session_user like 'svc_%' or exists (select 1 from pg_roles where rolname = session_user and rolsuper)) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select (value->>'linkCodeDays')::int into v_days from core.settings where key = 'messaging';
  v := lower(substr(translate(encode(gen_random_bytes(9), 'base64'), '+/=', 'xyz'), 1, 10));
  insert into messaging.link_codes (code, order_id, expires_at) values (v, p_order, now() + make_interval(days => coalesce(v_days, 30)));
  return v;
end $$;

-- Подставить переменные заказа в шаблон.
create or replace function messaging.render(p_template text, p_order uuid, p_vars jsonb default '{}'::jsonb) returns text
language plpgsql stable security definer set search_path = messaging, core, public as $$
declare v_body text; o record; k text; v_all jsonb;
begin
  select body into v_body from messaging.templates where code = p_template and enabled;
  if v_body is null then return null; end if;
  select number, cemetery, direction into o from core.api_orders where id = p_order;
  v_all := jsonb_build_object('number', o.number, 'cemetery', coalesce(o.cemetery, ''),
             'address', (select value->>'address' from core.settings where key = 'messaging')) || coalesce(p_vars, '{}'::jsonb);
  for k in select jsonb_object_keys(v_all) loop
    v_body := replace(v_body, '{' || k || '}', coalesce(v_all->>k, ''));
  end loop;
  return v_body;
end $$;

-- Поставить сообщение в очередь всем подпискам заказа. Нет подписок — вернёт 0 (менеджеру нужно позвонить).
create or replace function messaging.enqueue(p_order uuid, p_template text, p_vars jsonb default '{}'::jsonb,
                                             p_not_before timestamptz default now(), p_buttons jsonb default null,
                                             p_subscription uuid default null) returns int
language plpgsql security definer set search_path = messaging, core, public as $$
declare v_body text; v_buttons jsonb; n int;
begin
  v_body := messaging.render(p_template, p_order, p_vars);
  if v_body is null then return 0; end if;
  select coalesce(p_buttons, buttons) into v_buttons from messaging.templates where code = p_template;
  -- {order} в кнопках = id заказа, чтобы ответ пришёл с привязкой
  v_buttons := replace(v_buttons::text, '{order}', p_order::text)::jsonb;
  insert into messaging.messages (order_id, subscription_id, channel, chat_id, template, body, buttons, not_before)
  select p_order, s.id, s.channel, s.chat_id, p_template, v_body, v_buttons, p_not_before
  from messaging.subscriptions s where s.order_id = p_order and s.active and (p_subscription is null or s.id = p_subscription);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function messaging.cancel_pending(p_order uuid, p_template text) returns int
language plpgsql security definer set search_path = messaging, public as $$
declare n int;
begin
  update messaging.messages set status = 'cancelled' where order_id = p_order and template = p_template and status = 'queued';
  get diagnostics n = row_count; return n;
end $$;

-- ─── Для шлюзов bot-max / bot-vk ───────────────────────────────────────────────
create or replace function messaging.claim_outgoing(p_channel text, p_limit int default 20)
returns table (id uuid, chat_id text, body text, buttons jsonb, attempts int)
language plpgsql security definer set search_path = messaging, public as $$
begin
  return query
  with picked as (
    select m.id from messaging.messages m
    where m.channel = p_channel and m.not_before <= now()
      and (m.status = 'queued' or (m.status = 'sending' and m.locked_until < now()))
    order by m.not_before for update skip locked limit p_limit
  )
  update messaging.messages m set status = 'sending', locked_until = now() + interval '2 minutes', attempts = m.attempts + 1
  from picked where m.id = picked.id
  returning m.id, m.chat_id, m.body, m.buttons, m.attempts;
end $$;

create or replace function messaging.mark(p_id uuid, p_status text, p_external_id text default null, p_error text default null) returns void
language plpgsql security definer set search_path = messaging, bus, public as $$
declare m messaging.messages;
begin
  update messaging.messages set
    status = case
      when p_status = 'retry' then case when attempts >= 6 then 'failed' else 'queued' end
      when status in ('read') then status                                   -- не откатываем прочитанное
      when status = 'delivered' and p_status = 'sent' then status
      else p_status end,
    not_before = case when p_status = 'retry' then now() + make_interval(secs => least(power(2, attempts) * 10, 900)::int) else not_before end,
    locked_until = null,
    external_id = coalesce(p_external_id, external_id),
    last_error = coalesce(p_error, last_error),
    sent_at = case when p_status in ('sent','delivered','read') then coalesce(sent_at, now()) else sent_at end,
    delivered_at = case when p_status in ('delivered','read') then coalesce(delivered_at, now()) else delivered_at end,
    read_at = case when p_status = 'read' then coalesce(read_at, now()) else read_at end,
    failed_at = case when p_status = 'failed' or (p_status = 'retry' and attempts >= 6) then now() else failed_at end
  where id = p_id returning * into m;
  if m.status in ('sent','delivered','read','failed') then
    perform bus.publish('message.' || m.status, case when m.order_id is null then null else 'order:' || m.order_id end,
      jsonb_build_object('messageId', m.id, 'orderId', m.order_id, 'channel', m.channel, 'template', m.template, 'error', coalesce(m.last_error, '')),
      'message.' || m.status || ':' || m.id);
  end if;
end $$;

-- Входящее от клиента (текст, /start, нажатие кнопки, квитанции доставки/прочтения).
create or replace function messaging.record_inbound(p_channel text, p_chat_id text, p_kind text, p_data jsonb) returns bigint
language plpgsql security definer set search_path = messaging, bus, public as $$
declare v bigint;
begin
  insert into messaging.inbound (channel, chat_id, kind, data) values (p_channel, p_chat_id, p_kind, coalesce(p_data, '{}'::jsonb)) returning id into v;
  perform bus.publish('messaging.inbound', null, jsonb_build_object('inboundId', v, 'channel', p_channel, 'chatId', p_chat_id, 'kind', p_kind, 'data', p_data));
  return v;
end $$;

-- Доказательство по заказу: что, кому, когда отправлено и прочитано.
create or replace view messaging.api_evidence with (security_invoker = true) as
select m.order_id, o.number, m.id as message_id, m.channel, m.template, t.title, m.body, m.status,
       m.created_at, m.sent_at, m.delivered_at, m.read_at, s.consent_at
from messaging.messages m
join core.orders o on o.id = m.order_id
left join messaging.templates t on t.code = m.template
left join messaging.subscriptions s on s.id = m.subscription_id;

-- Экран менеджера: кто ответил, кто молчит.
create or replace view messaging.api_order_contacts with (security_invoker = true) as
select o.id as order_id, o.number, (select c.full_name from core.customers c where c.id = o.customer_id) as customer_name,
       exists (select 1 from messaging.subscriptions s where s.order_id = o.id and s.active) as subscribed,
       (select string_agg(distinct s.channel, ', ') from messaging.subscriptions s where s.order_id = o.id and s.active) as channels,
       (select max(m.created_at) from messaging.messages m where m.order_id = o.id) as last_message_at,
       (select count(*) from messaging.messages m where m.order_id = o.id and m.status in ('queued','sending','failed')) as undelivered
from core.orders o where o.status = 'open';

-- ─── Роли ──────────────────────────────────────────────────────────────────────
select core.ensure_service_role('svc_messaging');
grant usage on schema messaging, planning to svc_messaging;
grant select, insert, update on messaging.subscriptions, messaging.link_codes, messaging.inbound to svc_messaging;
grant select, update (status, alerted) on messaging.messages to svc_messaging;
grant select on messaging.templates to svc_messaging;
grant execute on function messaging.enqueue(uuid, text, jsonb, timestamptz, jsonb, uuid), messaging.cancel_pending(uuid, text), messaging.mark(uuid, text, text, text),
  messaging.render(text, uuid, jsonb), planning.free_dates(uuid, date, int), planning.order_assignment(uuid) to svc_messaging;

select core.ensure_service_role('svc_bot_max');
select core.ensure_service_role('svc_bot_vk');
grant usage on schema messaging to svc_bot_max, svc_bot_vk;
grant execute on function messaging.claim_outgoing(text, int), messaging.mark(uuid, text, text, text),
  messaging.record_inbound(text, text, text, jsonb) to svc_bot_max, svc_bot_vk;

-- ─── Доступ пользователей ──────────────────────────────────────────────────────
alter table messaging.templates enable row level security;
alter table messaging.link_codes enable row level security;
alter table messaging.subscriptions enable row level security;
alter table messaging.messages enable row level security;
alter table messaging.inbound enable row level security;
create policy templates_read on messaging.templates for select to authenticated using (core.is_staff());
create policy templates_admin on messaging.templates for update to authenticated using (core.has_role('admin')) with check (core.has_role('admin'));
create policy subs_read on messaging.subscriptions for select to authenticated using (core.is_staff());
create policy msgs_read on messaging.messages for select to authenticated using (core.is_staff());
create policy svc_subs on messaging.subscriptions for all to svc_messaging using (true) with check (true);
create policy svc_codes on messaging.link_codes for all to svc_messaging using (true) with check (true);
create policy svc_inbound on messaging.inbound for all to svc_messaging using (true) with check (true);
create policy svc_msgs on messaging.messages for all to svc_messaging using (true) with check (true);
create policy svc_tpl on messaging.templates for select to svc_messaging using (true);
grant usage on schema messaging to authenticated;
grant select on messaging.templates, messaging.subscriptions, messaging.messages, messaging.api_evidence, messaging.api_order_contacts to authenticated;
grant update (body, buttons, enabled) on messaging.templates to authenticated;
grant execute on function messaging.create_link_code(uuid) to authenticated;
