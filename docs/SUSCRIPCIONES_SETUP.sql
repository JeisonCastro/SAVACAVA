-- ============================================================
-- AUVRO · Ciclo de suscripciones mensuales
-- Pega este bloque en el SQL Editor de Supabase y ejecutalo.
-- Agrega a `perfiles` las fechas de inicio y vencimiento del plan.
-- ============================================================

alter table public.perfiles
    add column if not exists plan_inicio timestamptz,
    add column if not exists plan_vencimiento timestamptz;

create index if not exists idx_perfiles_plan_vencimiento
    on public.perfiles(plan_vencimiento);
