-- ============================================================
-- AUVRO · Módulos deportivos GENÉRICOS (nicho deportivo)
-- Particionados por `proyecto_id` (cualquier cliente del nicho:
-- FORMIES es el primer tenant). Siguen el patrón de tienda/pipeline:
-- tablas idempotentes + índices + RLS por admin/permiso de proyecto.
-- Aplicar via `supabase db push` o `supabase db query`.
-- ============================================================

-- ────────────────────────────────────────────────────────────────
-- 1) DEPORTISTAS (ficha completa del jugador) — entidad propia,
--    NO un producto de tienda.
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_deportistas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    nombre text not null,
    fotografia_url text,
    fecha_nacimiento date,
    edad integer,
    categoria text,
    posicion text,
    pierna text default 'Derecha',
    altura_cm integer,
    peso_kg numeric,
    club text,
    pais text,
    ciudad text,
    nivel text,
    experiencia text,
    perfil text,
    logros jsonb not null default '[]'::jsonb,
    estadisticas jsonb not null default '{}'::jsonb,
    videos jsonb not null default '[]'::jsonb,
    ficha jsonb not null default '{}'::jsonb,
    publico boolean not null default true,
    activo boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_deportes_deportistas_proyecto on public.deportes_deportistas(proyecto_id);
create index if not exists idx_deportes_deportistas_busqueda on public.deportes_deportistas(proyecto_id, categoria, posicion, pais, ciudad, nivel, edad);

-- ────────────────────────────────────────────────────────────────
-- 2) CLUB: PLANES (administrables; seed ELITE/FORMATIVO)
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_club_planes (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    nombre text not null,
    descripcion text,
    precio_cents integer not null default 0,
    periodo text not null default 'mensual',
    activo boolean not null default true,
    created_at timestamptz not null default now(),
    unique (proyecto_id, nombre)
);
create index if not exists idx_deportes_club_planes_proyecto on public.deportes_club_planes(proyecto_id);

-- ────────────────────────────────────────────────────────────────
-- 3) CLUB: HORARIOS (categoría / día / hora)
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_club_horarios (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    categoria text,
    dia text,
    hora_inicio text,
    hora_fin text,
    activo boolean not null default true,
    created_at timestamptz not null default now()
);
create index if not exists idx_deportes_club_horarios_proyecto on public.deportes_club_horarios(proyecto_id);

-- ────────────────────────────────────────────────────────────────
-- 4) VISORÍAS (convocatorias): fecha, costo, cupo, estado
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_visorias (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    titulo text not null,
    descripcion text,
    fecha timestamptz,
    costo_cents integer not null default 60000,
    cupo integer,
    lugar text,
    activo boolean not null default true,
    created_at timestamptz not null default now()
);
create index if not exists idx_deportes_visorias_proyecto on public.deportes_visorias(proyecto_id);

-- ────────────────────────────────────────────────────────────────
-- 5) INSCRIPCIONES (club/plan/visoría): responsable + deportista +
--    consentimiento + estado + vínculo a orden/pago de tienda.
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_inscripciones (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    tipo text not null default 'club',          -- club | visoria | torneo | gira
    plan_id uuid,
    visoria_id uuid,
    deportista_id uuid,
    deportista_nombre text,
    fecha_nacimiento date,
    deporte text,
    horario text,
    responsable_nombre text,
    responsable_email text,
    responsable_telefono text,
    datos jsonb not null default '{}'::jsonb,
    consentimiento boolean not null default false,
    consentimiento_uso_imagen boolean not null default false,
    consentimiento_tratamiento boolean not null default false,
    estado text not null default 'solicitada', -- solicitada | programada | evaluada | pagada | cancelada
    evaluacion jsonb not null default '{}'::jsonb,
    orden_id uuid,
    pago_id text, -- id del link de pago Wompi (no es UUID); varchar en APIs viejas
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_deportes_inscripciones_proyecto on public.deportes_inscripciones(proyecto_id);
create index if not exists idx_deportes_inscripciones_estado on public.deportes_inscripciones(proyecto_id, estado);

-- ────────────────────────────────────────────────────────────────
-- 6) TORNEOS / EVENTOS
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_torneos (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    titulo text not null,
    categoria text,
    fecha_inicio timestamptz,
    fecha_fin timestamptz,
    lugar text,
    descripcion text,
    resultados jsonb not null default '[]'::jsonb,
    fotos jsonb not null default '[]'::jsonb,
    activo boolean not null default true,
    created_at timestamptz not null default now()
);
create index if not exists idx_deportes_torneos_proyecto on public.deportes_torneos(proyecto_id);

-- ────────────────────────────────────────────────────────────────
-- 7) NOTICIAS / CMS
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_noticias (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    titulo text not null,
    categoria text default 'General',
    contenido text,
    imagen_url text,
    fecha_publicacion timestamptz not null default now(),
    activo boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_deportes_noticias_proyecto on public.deportes_noticias(proyecto_id);
create index if not exists idx_deportes_noticias_fecha on public.deportes_noticias(proyecto_id, fecha_publicacion desc);

-- ────────────────────────────────────────────────────────────────
-- 8) GALERÍA (multimedia por proyecto)
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_galeria (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    categoria text default 'General',
    titulo text,
    url text not null,
    tipo text not null default 'imagen',        -- imagen | video
    orden integer not null default 0,
    activo boolean not null default true,
    created_at timestamptz not null default now()
);
create index if not exists idx_deportes_galeria_proyecto on public.deportes_galeria(proyecto_id);

-- ────────────────────────────────────────────────────────────────
-- 9) CONSENTIMIENTOS (privacidad / uso de imagen / datos)
-- ────────────────────────────────────────────────────────────────
create table if not exists public.deportes_consentimientos (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    sujeto_nombre text,
    sujeto_tipo text default 'deportista',      -- deportista | responsable | visitante
    responsable text,
    uso_imagen boolean not null default false,
    tratamiento_datos boolean not null default false,
    documento_version text default 'v1',
    fecha timestamptz not null default now(),
    estado text not null default 'aceptado',    -- aceptado | revocado | pendiente
    notas text,
    created_at timestamptz not null default now()
);
create index if not exists idx_deportes_consentimientos_proyecto on public.deportes_consentimientos(proyecto_id);

-- Trazabilidad: consentimiento asociado a la inscripción que lo generó.
alter table public.deportes_consentimientos
    add column if not exists inscripcion_id uuid references public.deportes_inscripciones(id) on delete cascade;

-- ============================================================
-- RLS + POLICIES (mismo patrón que tienda_pipeline):
-- admin de plataforma o usuario con permiso sobre el proyecto.
-- ============================================================
-- Nota: las políticas se generan por tabla con un DO loop para
-- evitar repetir. RLS se habilita solo si aún no lo está.
do $$
declare t text;
begin
    foreach t in array array[
        'deportes_deportistas','deportes_club_planes','deportes_club_horarios',
        'deportes_visorias','deportes_inscripciones','deportes_torneos',
        'deportes_noticias','deportes_galeria','deportes_consentimientos'
    ] loop
        execute format('alter table public.%I enable row level security;', t);

        execute format($p$drop policy if exists %I on public.%I;$p$, 'deportes_' || t || '_select', t);
        execute format($p$create policy %I on public.%I for select using (
            exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
            or exists (select 1 from public.tienda_permisos tp
                       where tp.proyecto_id = %I.proyecto_id and tp.user_id = auth.uid())
        );$p$, 'deportes_' || t || '_select', t, t);

        execute format($p$drop policy if exists %I on public.%I;$p$, 'deportes_' || t || '_insert', t);
        execute format($p$create policy %I on public.%I for insert with check (
            exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
            or exists (select 1 from public.tienda_permisos tp
                       where tp.proyecto_id = %I.proyecto_id and tp.user_id = auth.uid()
                         and tp.rol in ('admin_tienda','editor_tienda','admin_sitio','editor_sitio'))
        );$p$, 'deportes_' || t || '_insert', t, t);

        execute format($p$drop policy if exists %I on public.%I;$p$, 'deportes_' || t || '_update', t);
        execute format($p$create policy %I on public.%I for update using (
            exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
            or exists (select 1 from public.tienda_permisos tp
                       where tp.proyecto_id = %I.proyecto_id and tp.user_id = auth.uid()
                         and tp.rol in ('admin_tienda','editor_tienda','admin_sitio','editor_sitio'))
        );$p$, 'deportes_' || t || '_update', t, t);

        execute format($p$drop policy if exists %I on public.%I;$p$, 'deportes_' || t || '_delete', t);
        execute format($p$create policy %I on public.%I for delete using (
            exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
            or exists (select 1 from public.tienda_permisos tp
                       where tp.proyecto_id = %I.proyecto_id and tp.user_id = auth.uid()
                         and tp.rol in ('admin_tienda','editor_tienda','admin_sitio','editor_sitio'))
        );$p$, 'deportes_' || t || '_delete', t, t);
    end loop;
end $$;

-- ============================================================
-- SEED: planes de club por defecto (ELITE / FORMATIVO) para cada
-- proyecto de tipo tienda que no tenga planes aún (idempotente).
-- Precios en centavos: ELITE $180.000, FORMATIVO $150.000.
-- ============================================================
insert into public.deportes_club_planes (proyecto_id, nombre, descripcion, precio_cents, periodo)
select w.id, p.nombre, p.descripcion, p.precio_cents, p.periodo
from public.web_projects w
cross join (
    select 'ELITE' as nombre, 'Plan ELITE: entrenamiento intensivo, acompañamiento y prioridad en convocatorias.' as descripcion, 18000000 as precio_cents, 'mensual' as periodo
    union all select 'FORMATIVO', 'Plan FORMATIVO: formación deportiva integral con enfoque técnico y táctico.', 15000000, 'mensual'
) p
where w.plantilla = 'tienda'
  and not exists (select 1 from public.deportes_club_planes cp where cp.proyecto_id = w.id);
