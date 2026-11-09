-- 0004. Служебный сервис: чистка шины, обезличивание по сроку хранения.
select core.ensure_service_role('svc_housekeeping');
grant execute on function bus.prune(int), core.anonymize_customers() to svc_housekeeping;
