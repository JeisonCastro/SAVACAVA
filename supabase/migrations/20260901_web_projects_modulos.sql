-- ============================================================
-- AUVRO · Módulos por proyecto (web_projects.modulos)
-- Permite activar módulos genéricos en un sitio al crearlo
-- (ej. "deportes" para el nicho deportivo). Tienda-admin muestra
-- la sección Deportes solo si el proyecto lo tiene activo.
-- Aplicado via `supabase db query --linked`.
-- ============================================================

alter table public.web_projects
    add column if not exists modulos jsonb not null default '[]'::jsonb;
