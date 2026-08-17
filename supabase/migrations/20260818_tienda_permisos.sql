-- Migración: Permisos de tienda por usuario (acceso restringido a tienda-admin)
-- Fecha: 2026-08-18
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Flujo: Admin asigna permiso → usuario ingresa a dashboard → ve Web Factory →
--        solo sus tiendas asignadas → botón "Editar tienda" → tienda-admin.html.
-- Seguridad: backend usa service role; la tabla no tiene RLS (mismo patrón que el resto).

create table if not exists public.tienda_permisos (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    user_id uuid not null,
    rol text not null default 'admin_tienda' check (rol in ('admin_tienda', 'editor_tienda', 'visor_tienda')),
    created_at timestamptz not null default now(),
    unique (proyecto_id, user_id)
);

create index if not exists tienda_permisos_user_idx on public.tienda_permisos (user_id);
create index if not exists tienda_permisos_proyecto_idx on public.tienda_permisos (proyecto_id);

-- RLS: desactivada por defecto (el backend usa la service role).
-- alter table public.tienda_permisos enable row level security;
