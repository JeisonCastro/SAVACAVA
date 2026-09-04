-- Migración: Módulo de Productos Turísticos (motor turismo) — FASE 1 (modelo de dominio)
-- Fecha: 2026-09-03
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Patrón: mismo que el módulo Deportes — tablas por proyecto/producto, service role en
-- el servidor, RLS por proyecto (admin o permiso de tienda/sitio sobre el proyecto).
-- No altera las tablas existentes tienda_* (solo las referencia).

-- ============================================================
-- 1) TUR_PRODUCTOS: editorial turística + admin (costo/margen) 1:1 con tienda_productos
-- ============================================================
create table if not exists public.tur_productos (
    producto_id uuid primary key references public.tienda_productos(id) on delete cascade,
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    tipo_experiencia text,                -- tour | actividad | excursion | traslado | entrada | experiencia | paquete ...
    destino text,
    ubicacion text,
    duracion text,
    idiomas jsonb not null default '[]'::jsonb,
    incluye jsonb not null default '[]'::jsonb,
    no_incluye jsonb not null default '[]'::jsonb,
    recomendaciones text,
    restricciones text,
    punto_encuentro text,
    politica_cancelacion text,
    pricing_modelo text not null default 'por_persona',  -- por_persona | por_reserva | por_vehiculo
    requiere_adulto boolean not null default false,
    min_pax integer not null default 1,
    max_pax integer,                       -- null = sin límite
    costo_proveedor_cents integer not null default 0,    -- ADMIN, nunca público
    moneda text not null default 'COP',
    impuesto_pct numeric not null default 0,
    migrado boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_tur_productos_proyecto on public.tur_productos(proyecto_id);

-- ============================================================
-- 2) TUR_PRODUCTO_TARIFAS: categorías de pasajero (Adulto, Niño, ...)
-- ============================================================
create table if not exists public.tur_producto_tarifas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    nombre text not null,
    edad_min integer,
    edad_max integer,
    precio_cents integer not null default 0,
    permitido boolean not null default true,
    orden integer not null default 0
);
create index if not exists idx_tur_tarifas_producto on public.tur_producto_tarifas(producto_id);

-- ============================================================
-- 3) TUR_PRODUCTO_ESCALAS: descuentos por tramo de grupo
-- ============================================================
create table if not exists public.tur_producto_escalas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    desde integer not null default 1,
    hasta integer,                          -- null = abierto (desde N en adelante)
    tipo text not null default 'pct',       -- pct | fijo
    aplica_a text not null default 'total', -- total | adultos | <id tarifa>
    valor numeric not null default 0,
    combina_con_promo boolean not null default false,
    antes_de_extras boolean not null default true
);
create index if not exists idx_tur_escalas_producto on public.tur_producto_escalas(producto_id);

-- ============================================================
-- 4) TUR_PRODUCTO_EXTRAS: servicios adicionales
-- ============================================================
create table if not exists public.tur_producto_extras (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    nombre text not null,
    descripcion text,
    tipo_precio text not null default 'por_persona', -- por_persona | por_adulto | por_nino | por_reserva | por_unidad
    precio_cents integer not null default 0,
    obligatorio boolean not null default false,
    min_qty integer not null default 1,
    max_qty integer,
    activo boolean not null default true
);
create index if not exists idx_tur_extras_producto on public.tur_producto_extras(producto_id);

-- ============================================================
-- 5) TUR_PRODUCTO_TEMPORADAS (opcional)
-- ============================================================
create table if not exists public.tur_producto_temporadas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    nombre text not null,
    desde date not null,
    hasta date not null,
    tipo text not null default 'pct',        -- pct | override
    valor numeric not null default 0,
    dias jsonb not null default '[]'::jsonb  -- dias de la semana que aplica ([] = todos)
);
create index if not exists idx_tur_temporadas_producto on public.tur_producto_temporadas(producto_id);

-- ============================================================
-- 6) TUR_PRODUCTO_FECHAS_BLOQUEADAS
-- ============================================================
create table if not exists public.tur_producto_fechas_bloqueadas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    fecha date not null,
    motivo text
);
create index if not exists idx_tur_fechasbloq_producto on public.tur_producto_fechas_bloqueadas(producto_id);

-- ============================================================
-- 7) TUR_SALIDA_PLANTILLAS: reglas de salida por producto
-- ============================================================
create table if not exists public.tur_salida_plantillas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    dias jsonb not null default '[]'::jsonb,     -- ['lun','mar',...] ([] = todos)
    hora_salida text,
    hora_regreso text,
    capacidad integer not null default 40,
    adelanto_cierre_hs integer not null default 0,
    activo boolean not null default true
);
create index if not exists idx_tur_plantillas_producto on public.tur_salida_plantillas(producto_id);

-- ============================================================
-- 8) TUR_SALIDAS: salida operativa (fecha + cupos atómicos)
-- ============================================================
create table if not exists public.tur_salidas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    plantilla_id uuid references public.tur_salida_plantillas(id) on delete set null,
    fecha date not null,
    hora_salida text,
    hora_regreso text,
    capacidad integer not null default 40,
    reservas_confirmadas integer not null default 0,
    estado text not null default 'abierta' check (estado in ('abierta','cerrada','cancelada')),
    unique (producto_id, fecha, hora_salida),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_tur_salidas_producto on public.tur_salidas(producto_id, fecha);
create index if not exists idx_tur_salidas_proyecto on public.tur_salidas(proyecto_id);

-- ============================================================
-- 9) TUR_RECOGIDAS / TUR_TRASLADOS / TUR_ITINERARIO
-- ============================================================
create table if not exists public.tur_recogidas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    nombre text not null,
    zona text,
    direccion text,
    lat numeric,
    lng numeric,
    hora text,
    costo_cents integer not null default 0,
    activo boolean not null default true
);
create index if not exists idx_tur_recogidas_producto on public.tur_recogidas(producto_id);

create table if not exists public.tur_traslados (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    tipo_vehiculo text,
    capacidad integer,
    origen text,
    destino text,
    horario text,
    precio_cents integer not null default 0,
    incluido boolean not null default false
);
create index if not exists idx_tur_traslados_producto on public.tur_traslados(producto_id);

create table if not exists public.tur_itinerario (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    orden integer not null default 0,
    hora text,
    titulo text,
    descripcion text
);
create index if not exists idx_tur_itinerario_producto on public.tur_itinerario(producto_id);

-- ============================================================
-- 10) TUR_RESERVAS + líneas (snapshot de precios)
-- ============================================================
create table if not exists public.tur_reservas (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    salida_id uuid references public.tur_salidas(id) on delete set null,
    estado text not null default 'pendiente' check (estado in ('cotizada','pendiente','pagada','cancelada')),
    origen text not null default 'online',  -- online | agente
    cliente jsonb not null default '{}'::jsonb,
    total_cents integer not null default 0,
    desglose jsonb not null default '{}'::jsonb,
    wompi_link_id text,
    wompi_url text,
    orden_tienda_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_tur_reservas_proyecto on public.tur_reservas(proyecto_id, created_at desc);
create index if not exists idx_tur_reservas_salida on public.tur_reservas(salida_id);

create table if not exists public.tur_reserva_pasajeros (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null references public.tur_reservas(id) on delete cascade,
    proyecto_id uuid references public.web_projects(id) on delete cascade,
    tarifa_nombre text not null,
    edad integer,
    precio_cents integer not null default 0,
    cantidad integer not null default 1
);
create index if not exists idx_tur_respax_reserva on public.tur_reserva_pasajeros(reserva_id);
create index if not exists idx_tur_respax_proyecto on public.tur_reserva_pasajeros(proyecto_id);

create table if not exists public.tur_reserva_extras (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null references public.tur_reservas(id) on delete cascade,
    proyecto_id uuid references public.web_projects(id) on delete cascade,
    extra_nombre text not null,
    tipo_precio text not null default 'por_persona',
    precio_cents integer not null default 0,
    cantidad integer not null default 1
);
create index if not exists idx_tur_resextras_reserva on public.tur_reserva_extras(reserva_id);
create index if not exists idx_tur_resextras_proyecto on public.tur_reserva_extras(proyecto_id);

-- Compatibilidad con instalaciones parciales (el bucle RLS usa proyecto_id):
alter table public.tur_reserva_pasajeros add column if not exists proyecto_id uuid references public.web_projects(id) on delete cascade;
alter table public.tur_reserva_extras add column if not exists proyecto_id uuid references public.web_projects(id) on delete cascade;

-- ============================================================
-- RLS + POLICIES (patrón Deportes): admin de plataforma o permiso sobre el proyecto.
-- ============================================================
do $$
declare t text;
begin
    foreach t in array array[
        'tur_productos','tur_producto_tarifas','tur_producto_escalas','tur_producto_extras',
        'tur_producto_temporadas','tur_producto_fechas_bloqueadas','tur_salida_plantillas',
        'tur_salidas','tur_recogidas','tur_traslados','tur_itinerario',
        'tur_reservas','tur_reserva_pasajeros','tur_reserva_extras'
    ] loop
        execute format('alter table public.%I enable row level security;', t);

        execute format($p$drop policy if exists %I on public.%I;$p$, 'tur_' || t || '_select', t);
        execute format($p$create policy %I on public.%I for select using (
            exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
            or exists (select 1 from public.tienda_permisos tp
                       where tp.proyecto_id = %I.proyecto_id and tp.user_id = auth.uid())
        );$p$, 'tur_' || t || '_select', t, t);

        execute format($p$drop policy if exists %I on public.%I;$p$, 'tur_' || t || '_insert', t);
        execute format($p$create policy %I on public.%I for insert with check (
            exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
            or exists (select 1 from public.tienda_permisos tp
                       where tp.proyecto_id = %I.proyecto_id and tp.user_id = auth.uid()
                         and tp.rol in ('admin_tienda','editor_tienda','admin_sitio','editor_sitio'))
        );$p$, 'tur_' || t || '_insert', t, t);

        execute format($p$drop policy if exists %I on public.%I;$p$, 'tur_' || t || '_update', t);
        execute format($p$create policy %I on public.%I for update using (
            exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
            or exists (select 1 from public.tienda_permisos tp
                       where tp.proyecto_id = %I.proyecto_id and tp.user_id = auth.uid()
                         and tp.rol in ('admin_tienda','editor_tienda','admin_sitio','editor_sitio'))
        );$p$, 'tur_' || t || '_update', t, t);

        execute format($p$drop policy if exists %I on public.%I;$p$, 'tur_' || t || '_delete', t);
        execute format($p$create policy %I on public.%I for delete using (
            exists (select 1 from public.perfiles p where p.id = auth.uid() and p.is_admin)
            or exists (select 1 from public.tienda_permisos tp
                       where tp.proyecto_id = %I.proyecto_id and tp.user_id = auth.uid()
                         and tp.rol in ('admin_tienda','editor_tienda','admin_sitio','editor_sitio'))
        );$p$, 'tur_' || t || '_delete', t, t);
    end loop;
end $$;
