-- ============================================================
-- AUVRO · Pipeline CRM por TIENDA (tienda_pipeline)
-- Los estados/pipeline del CRM se definen sobre la tienda (proyecto),
-- no por agente. Los agentes toman el pipeline (y catálogo y pasarela)
-- de la tienda a la que se les asigna (agentes_ia.tienda_id).
-- Aplicado manualmente a producción via `supabase db query`.
-- ============================================================

-- 1. Tabla de estados del pipeline por tienda
create table if not exists public.tienda_pipeline (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    nombre text not null,
    orden integer not null default 0,
    es_inicial boolean not null default false,
    es_cerrada boolean not null default false,
    es_perdida boolean not null default false,
    avance_automatico text,
    color text default '#0ea5e9',
    created_at timestamptz not null default now()
);

create index if not exists idx_tienda_pipeline_proyecto on public.tienda_pipeline(proyecto_id);

-- 2. Row Level Security (admin de plataforma o permiso de tienda)
alter table public.tienda_pipeline enable row level security;

drop policy if exists "tienda_pipeline_admin_select" on public.tienda_pipeline;
create policy "tienda_pipeline_admin_select" on public.tienda_pipeline
    for select using (
        exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
        or exists (select 1 from public.tienda_permisos tp
                   where tp.proyecto_id = tienda_pipeline.proyecto_id
                     and tp.user_id = auth.uid())
    );

drop policy if exists "tienda_pipeline_admin_insert" on public.tienda_pipeline;
create policy "tienda_pipeline_admin_insert" on public.tienda_pipeline
    for insert with check (
        exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
        or exists (select 1 from public.tienda_permisos tp
                   where tp.proyecto_id = tienda_pipeline.proyecto_id
                     and tp.user_id = auth.uid() and tp.rol in ('admin_tienda','editor_tienda'))
    );

drop policy if exists "tienda_pipeline_admin_update" on public.tienda_pipeline;
create policy "tienda_pipeline_admin_update" on public.tienda_pipeline
    for update using (
        exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
        or exists (select 1 from public.tienda_permisos tp
                   where tp.proyecto_id = tienda_pipeline.proyecto_id
                     and tp.user_id = auth.uid() and tp.rol in ('admin_tienda','editor_tienda'))
    );

drop policy if exists "tienda_pipeline_admin_delete" on public.tienda_pipeline;
create policy "tienda_pipeline_admin_delete" on public.tienda_pipeline
    for delete using (
        exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
        or exists (select 1 from public.tienda_permisos tp
                   where tp.proyecto_id = tienda_pipeline.proyecto_id
                     and tp.user_id = auth.uid() and tp.rol in ('admin_tienda','editor_tienda'))
    );

-- 3. RPC para cerrar una venta de tienda usando el pipeline de la TIENDA
--    (usado por el webhook con service role sobre leads con proyecto_id).
create or replace function public.cerrar_lead_venta_tienda(p_lead_id uuid, p_valor_cents bigint)
returns void
language plpgsql
security definer
as $$
declare
    v_proyecto_id uuid;
begin
    select proyecto_id into v_proyecto_id
    from public.crm_leads where id = p_lead_id;
    if v_proyecto_id is null then
        -- lead sin tienda: cae al RPC legado de crm_estados por usuario
        perform public.cerrar_lead_venta(p_lead_id, p_valor_cents);
        return;
    end if;
    update public.crm_leads
    set estado_id = (
            select e.id from public.tienda_pipeline e
            where e.proyecto_id = v_proyecto_id
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

-- 4. Seed: pipeline default para las tiendas existentes (PabloViajes y las que tengan agente)
--    Replica los estados default del CRM (Nuevo/Contactado/Calificado/Negociación/Ganado/Perdido).
insert into public.tienda_pipeline (proyecto_id, nombre, orden, es_inicial, es_cerrada, es_perdida, avance_automatico, color)
select w.id, s.nombre, s.orden, s.es_inicial, s.es_cerrada, s.es_perdida, s.avance_automatico, s.color
from public.web_projects w
cross join (
    select 'Nuevo' as nombre, 0 as orden, true as es_inicial, false as es_cerrada, false as es_perdida, null as avance_automatico, '#0ea5e9' as color
    union all select 'Contactado', 1, false, false, false, 'contactado', '#22c55e'
    union all select 'Calificado', 2, false, false, false, 'calificado', '#eab308'
    union all select 'Negociación', 3, false, false, false, 'negociacion', '#f97316'
    union all select 'Ganado', 4, false, true, false, null, '#16a34a'
    union all select 'Perdido', 5, false, false, true, null, '#ef4444'
) s
where w.plantilla = 'tienda'
  and not exists (select 1 from public.tienda_pipeline tp where tp.proyecto_id = w.id);
