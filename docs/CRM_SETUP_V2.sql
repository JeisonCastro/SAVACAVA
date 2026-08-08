-- ============================================================
-- AUVRO · CRM por AGENTE (configuracion individual)
-- Ejecuta este bloque UNA vez en el SQL Editor de Supabase.
-- Crea crm_config_agente (Wompi + catalogo + campos por agente)
-- y copia tu configuracion global actual a cada agente con
-- crm_activo = true. Despues cada agente se configura por separado.
-- ============================================================

-- 1. Configuracion CRM POR AGENTE
create table if not exists public.crm_config_agente (
    agente_id integer primary key references public.agentes_ia(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    crm_activo boolean not null default false,
    campos_captura text[] not null default '{nombre,telefono,email,interes,preferencias}',
    wompi_private_key text,
    wompi_public_key text,
    wompi_events_secret text,
    wompi_sandbox boolean not null default false,
    catalogo jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 2. Indices
create index if not exists idx_crm_config_agente_user on public.crm_config_agente(user_id);

-- 3. Migracion: copia la configuracion global actual a cada agente con CRM activo
insert into public.crm_config_agente
    (agente_id, user_id, crm_activo, campos_captura, wompi_private_key, wompi_public_key,
     wompi_events_secret, wompi_sandbox, catalogo, created_at, updated_at)
select
    a.id, a.user_id, c.crm_activo, c.campos_captura, c.wompi_private_key, c.wompi_public_key,
    c.wompi_events_secret, c.wompi_sandbox, c.catalogo, c.created_at, c.updated_at
from public.crm_config c
join public.agentes_ia a on a.user_id = c.user_id and a.crm_activo = true
on conflict (agente_id) do nothing;

-- 4. Row Level Security (cada usuario solo ve/maneja sus agentes)
alter table public.crm_config_agente enable row level security;

create policy "crm_config_agente_select_own" on public.crm_config_agente
    for select using (auth.uid() = user_id);

create policy "crm_config_agente_insert_own" on public.crm_config_agente
    for insert with check (auth.uid() = user_id);

create policy "crm_config_agente_update_own" on public.crm_config_agente
    for update using (auth.uid() = user_id);
