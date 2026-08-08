-- ============================================================
-- AUVRO · CRM agente-centrico
-- Pega este bloque en el SQL Editor de Supabase y ejecutalo.
-- Crea: crm_config (pasarela por usuario), crm_estados (pipeline
-- personalizado con flags) y crm_leads (datos capturados).
-- Modifica: agentes_ia (crm_activo, crm_campos) y pagos (tipo 'venta', lead_id).
-- ============================================================

-- 1. Configuracion CRM por usuario (incluye pasarela del vendedor)
create table if not exists public.crm_config (
    user_id uuid primary key references auth.users(id) on delete cascade,
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

-- 2. Estados del pipeline (100% personalizados por el negocio)
create table if not exists public.crm_estados (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    nombre text not null,
    orden integer not null default 0,
    es_inicial boolean not null default false,
    es_cerrada boolean not null default false,
    es_perdida boolean not null default false,
    avance_automatico text,
    color text default '#0ea5e9',
    created_at timestamptz not null default now()
);

-- 3. Leads capturados por los agentes
create table if not exists public.crm_leads (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    agente_id integer references public.agentes_ia(id) on delete set null,
    conversacion_id uuid,
    external_user_id text,
    origen text default 'web',
    nombre text,
    telefono text,
    email text,
    interes text,
    preferencias jsonb default '{}'::jsonb,
    notas text,
    estado_id uuid references public.crm_estados(id) on delete set null,
    etapa_generica text,
    valor_venta_cents bigint,
    cerrado_en timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 4. Columnas CRM en agentes
alter table public.agentes_ia
    add column if not exists crm_activo boolean not null default false,
    add column if not exists crm_campos text[] default '{nombre,telefono,email,interes,preferencias}';

-- 5. pagos: permitir ventas de CRM (pago-en-chat) y ligar al lead
alter table public.pagos drop constraint if exists pagos_tipo_check;
alter table public.pagos add constraint pagos_tipo_check check (tipo in ('tokens','plan','venta'));
alter table public.pagos add column if not exists lead_id uuid;

-- 6. Indices
create index if not exists idx_crm_leads_user on public.crm_leads(user_id);
create index if not exists idx_crm_leads_agente on public.crm_leads(agente_id);
create index if not exists idx_crm_leads_estado on public.crm_leads(estado_id);
create index if not exists idx_crm_estados_user on public.crm_estados(user_id);
create index if not exists idx_crm_leads_ext on public.crm_leads(user_id, agente_id, external_user_id);

-- 7. Row Level Security (cada usuario solo ve/maneja lo suyo)
alter table public.crm_config enable row level security;
alter table public.crm_estados enable row level security;
alter table public.crm_leads enable row level security;

create policy "crm_config_select_own" on public.crm_config
    for select using (auth.uid() = user_id);

create policy "crm_estados_select_own" on public.crm_estados
    for select using (auth.uid() = user_id);
create policy "crm_estados_insert_own" on public.crm_estados
    for insert with check (auth.uid() = user_id);
create policy "crm_estados_update_own" on public.crm_estados
    for update using (auth.uid() = user_id);
create policy "crm_estados_delete_own" on public.crm_estados
    for delete using (auth.uid() = user_id);

create policy "crm_leads_select_own" on public.crm_leads
    for select using (auth.uid() = user_id);
create policy "crm_leads_insert_own" on public.crm_leads
    for insert with check (auth.uid() = user_id);
create policy "crm_leads_update_own" on public.crm_leads
    for update using (auth.uid() = user_id);

-- 8. RPC para marcar venta cerrada (usado por el webhook con service role)
create or replace function public.cerrar_lead_venta(p_lead_id uuid, p_valor_cents bigint)
returns void
language plpgsql
security definer
as $$
begin
    update public.crm_leads
    set estado_id = (
            select e.id from public.crm_estados e
            where e.user_id = (select user_id from public.crm_leads where id = p_lead_id)
              and e.es_cerrada = true
            order by e.orden asc
            limit 1
        ),
        valor_venta_cents = p_valor_cents,
        cerrado_en = now(),
        updated_at = now()
    where id = p_lead_id;
end;
$$;
