-- Демо-справочники для локальной проверки. Применяется только при `supabase start` / `supabase db reset`.
-- Имена кладбищ совпадают с заказами эмулятора 1С (packages/accounting/src/emulator.ts).
-- Реальные данные НМК сюда не кладём.

insert into core.directions (name, sort, meteo_ref) values
  ('Кстово', 10, null), ('Арзамас', 20, null), ('Нижний Новгород', 30, null), ('Семёнов', 40, null)
on conflict (name) do nothing;

insert into core.cemeteries (name, aliases, direction_id, lat, lon)
select c.name, c.aliases, d.id, c.lat, c.lon
from (values
  ('Новое Кстово', array['Новое Кстово','кладб. Новое'], 'Кстово', 56.1440, 44.1660),
  ('Арзамасское городское', array['Арзамасское городское'], 'Арзамас', 55.3940, 43.8390),
  ('Красная Этна', array['Красная Этна'], 'Нижний Новгород', 56.2650, 43.8720),
  ('Семёновское', array['Семёновское'], 'Семёнов', 56.7890, 44.4920)
) as c(name, aliases, direction, lat, lon)
join core.directions d on d.name = c.direction
on conflict (name, direction_id) do nothing;

insert into core.vehicles (kind, plate, capacity_kg) values
  ('ГАЗон Next', 'А101АА152', 1500),
  ('Газель', 'В202ВВ152', 1500),
  ('УАЗ', 'С303СС152', 800)
on conflict (plate) do nothing;

insert into core.crews (name, leader, phone) values
  ('Бригада 1', 'Иванов С.', '+7 900 000-00-01'),
  ('Бригада 2', 'Сидоров А.', '+7 900 000-00-02'),
  ('Бригада 3', 'Фёдоров К.', '+7 900 000-00-03')
on conflict (name) do nothing;

insert into procurement.suppliers (name, phone) values
  ('Карьер «Габбро» (демо)', '+7 900 000-10-10')
on conflict (name) do nothing;
