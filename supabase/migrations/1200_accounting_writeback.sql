-- 1200. Модуль «Запись стадий в 1С» (сервис accounting-writeback). По умолчанию выключен:
-- обмен только на чтение. Включается, когда участки отмечают стадии сканом, а в 1С сделано
-- расширение с HTTP-сервисом (работа стороннего специалиста 1С по нашему ТЗ, docs/1c-extension.md).
select core.ensure_service_role('svc_accounting_writeback');
grant select on core.orders, core.stages to svc_accounting_writeback;
