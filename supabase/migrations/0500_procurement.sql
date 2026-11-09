-- 0500. Модуль «Заявки на поставку» (сервис procurement).
-- Потребность = (минимум + страховой запас) − (остаток в учётной системе − спрос открытых заказов, по которым камень ещё не взят).
create schema if not exists procurement;
comment on schema procurement is 'Правила дозаказа, черновики заявок, утверждение, ожидаемые поставки';

create table procurement.suppliers (
  id      uuid primary key default gen_random_uuid(),
  name    text not null unique,
  phone   text, email text, notes text,
  active  boolean not null default true
);

create table procurement.rules (
  catalog_item_id uuid primary key references core.catalog_items(id) on delete cascade,
  supplier_id     uuid not null references procurement.suppliers(id),
  min_qty         numeric(12,2) not null default 0,
  safety_qty      numeric(12,2) not null default 0,
  pack_qty        numeric(12,2) not null default 1 check (pack_qty > 0),
  lead_days       int not null default 7,
  active          boolean not null default true
);

create table procurement.drafts (
  id          uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references procurement.suppliers(id),
  status      text not null default 'draft' check (status in ('draft','approved','received','cancelled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  approved_by uuid, approved_at timestamptz, eta date, received_at timestamptz,
  late_notified boolean not null default false
);
create unique index drafts_one_open_per_supplier on procurement.drafts (supplier_id) where status = 'draft';

create table procurement.draft_lines (
  draft_id        uuid not null references procurement.drafts(id) on delete cascade,
  catalog_item_id uuid not null references core.catalog_items(id),
  qty             numeric(12,2) not null,
  stock_qty       numeric(12,2) not null,
  demand_qty      numeric(12,2) not null,
  primary key (draft_id, catalog_item_id)
);

insert into core.settings (key, value) values ('procurement', '{"demandStages": ["accepted"]}') on conflict do nothing;

create or replace view procurement.api_needs with (security_invoker = true) as
with demand as (
  select i.catalog_item_id, sum(i.qty) as qty
  from core.order_items i join core.orders o on o.id = i.order_id
  where o.status = 'open'
    and o.stage_code in (select jsonb_array_elements_text(value->'demandStages') from core.settings where key = 'procurement')
  group by i.catalog_item_id
), stock as (
  select catalog_item_id, sum(qty) as qty from integration.api_stock where catalog_item_id is not null group by catalog_item_id
)
select r.catalog_item_id, ci.name, r.supplier_id, s.name as supplier, r.min_qty, r.safety_qty, r.pack_qty, r.lead_days,
       coalesce(st.qty, 0) as stock_qty, coalesce(d.qty, 0) as demand_qty,
       coalesce(st.qty, 0) - coalesce(d.qty, 0) as free_qty,
       greatest(0, ceil((r.min_qty + r.safety_qty - (coalesce(st.qty, 0) - coalesce(d.qty, 0))) / r.pack_qty) * r.pack_qty) as need_qty
from procurement.rules r
join core.catalog_items ci on ci.id = r.catalog_item_id
join procurement.suppliers s on s.id = r.supplier_id and s.active
left join stock st on st.catalog_item_id = r.catalog_item_id
left join demand d on d.catalog_item_id = r.catalog_item_id
where r.active;

-- Пересчитать черновики. Утверждённые заявки не трогает. Ничего никуда не отправляет.
create or replace function procurement.recalculate() returns int
language plpgsql security definer set search_path = procurement, core, bus, public as $$
declare s record; v_draft uuid; v_new boolean; n int := 0;
begin
  for s in select supplier_id from procurement.api_needs group by supplier_id loop
    if exists (select 1 from procurement.api_needs where supplier_id = s.supplier_id and need_qty > 0) then
      select id into v_draft from procurement.drafts where supplier_id = s.supplier_id and status = 'draft';
      v_new := v_draft is null;
      if v_new then insert into procurement.drafts (supplier_id) values (s.supplier_id) returning id into v_draft; end if;
      delete from procurement.draft_lines where draft_id = v_draft;
      insert into procurement.draft_lines (draft_id, catalog_item_id, qty, stock_qty, demand_qty)
      select v_draft, catalog_item_id, need_qty, stock_qty, demand_qty from procurement.api_needs
       where supplier_id = s.supplier_id and need_qty > 0;
      update procurement.drafts set updated_at = now() where id = v_draft;
      if v_new then
        n := n + 1;
        perform bus.publish('procurement.draft_created', null, jsonb_build_object('draftId', v_draft, 'supplierId', s.supplier_id));
      end if;
    else
      delete from procurement.drafts where supplier_id = s.supplier_id and status = 'draft';
    end if;
  end loop;
  return n;
end $$;

create or replace function procurement.approve(p_draft uuid, p_lines jsonb default null) returns void
language plpgsql security definer set search_path = procurement, core, bus, public as $$
declare v_lead int;
begin
  if not (core.has_any_role(array['admin','production_head','production_deputy'])
          or exists (select 1 from pg_roles where rolname = session_user and rolsuper)) then
    raise exception 'Утверждает начальник производства или его заместитель' using errcode = 'insufficient_privilege';
  end if;
  -- можно поправить количество перед утверждением: [{catalogItemId, qty}]
  if p_lines is not null then
    update procurement.draft_lines l set qty = (x->>'qty')::numeric
      from jsonb_array_elements(p_lines) x where l.draft_id = p_draft and l.catalog_item_id = (x->>'catalogItemId')::uuid;
    delete from procurement.draft_lines where draft_id = p_draft and qty <= 0;
  end if;
  select max(r.lead_days) into v_lead from procurement.draft_lines l join procurement.rules r on r.catalog_item_id = l.catalog_item_id where l.draft_id = p_draft;
  update procurement.drafts set status = 'approved', approved_by = auth.uid(), approved_at = now(),
         eta = current_date + coalesce(v_lead, 7), updated_at = now()
   where id = p_draft and status = 'draft';
  if not found then raise exception 'Черновик % не найден или уже утверждён', p_draft; end if;
  perform bus.publish('procurement.approved', null, jsonb_build_object('draftId', p_draft));
end $$;

create or replace function procurement.mark_received(p_draft uuid) returns void
language sql security definer set search_path = procurement, public as $$
  update procurement.drafts set status = 'received', received_at = now(), updated_at = now() where id = p_draft and status = 'approved';
$$;

create or replace function procurement.detect_late() returns int
language plpgsql security definer set search_path = procurement, bus, public as $$
declare r record; n int := 0;
begin
  for r in select id, supplier_id, eta from procurement.drafts where status = 'approved' and eta < current_date and not late_notified loop
    update procurement.drafts set late_notified = true where id = r.id;
    perform bus.publish('supply.late', null, jsonb_build_object('draftId', r.id, 'supplierId', r.supplier_id, 'eta', r.eta));
    n := n + 1;
  end loop;
  return n;
end $$;

select core.ensure_service_role('svc_procurement');
grant usage on schema procurement to svc_procurement;
grant execute on function procurement.recalculate(), procurement.detect_late() to svc_procurement;

alter table procurement.suppliers enable row level security;
alter table procurement.rules enable row level security;
alter table procurement.drafts enable row level security;
alter table procurement.draft_lines enable row level security;
do $$ declare t text; begin
  foreach t in array array['suppliers','rules','drafts','draft_lines'] loop
    execute format('create policy %1$s_read on procurement.%1$s for select to authenticated using (core.has_any_role(array[''admin'',''production_head'',''production_deputy'',''owner'',''storekeeper'']))', t);
  end loop;
end $$;
create policy suppliers_write on procurement.suppliers for all to authenticated using (core.has_any_role(array['admin','production_head'])) with check (core.has_any_role(array['admin','production_head']));
create policy rules_write on procurement.rules for all to authenticated using (core.has_any_role(array['admin','production_head'])) with check (core.has_any_role(array['admin','production_head']));
grant usage on schema procurement to authenticated;
grant select on all tables in schema procurement to authenticated;
grant select on procurement.api_needs to authenticated;
grant insert, update, delete on procurement.suppliers, procurement.rules to authenticated;
grant execute on function procurement.approve(uuid, jsonb), procurement.mark_received(uuid) to authenticated;
