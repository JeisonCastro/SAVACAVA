-- Migración: Web Factory (proyectos web generados para clientes)
-- Fecha: 2026-08-13
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Flujo: AUVRO Admin -> crear proyecto -> Supabase -> GitHub -> Netlify -> Deploy.
-- La tabla se lee/escribe con la service role (bypassa RLS), igual que el resto del backend.

-- 1) Tabla de proyectos web generados
create table if not exists public.web_projects (
    id uuid primary key default gen_random_uuid(),
    cliente text not null,
    nombre text not null,
    slug text not null unique,
    plantilla text not null default 'landing',
    descripcion text,
    dominio text,
    estado text not null default 'creando',
    estado_deploy text,
    dominio_estado text,
    ssl_estado text,
    github_owner text,
    github_repo text,
    github_url text,
    netlify_site_id text,
    netlify_url text,
    clone_url text,
    error text,
    created_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Índice de listado (los más recientes primero)
create index if not exists web_projects_created_at_idx on public.web_projects (created_at desc);

-- RLS: desactivada por defecto (el backend usa la service role).
-- alter table public.web_projects enable row level security;
