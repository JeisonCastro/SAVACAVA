-- Web Factory: permitir apagar/reactivar sitios (suspension por impago de demos).
-- Idempotente: se puede ejecutar mas de una vez.
alter table public.web_projects add column if not exists activo boolean not null default true;
