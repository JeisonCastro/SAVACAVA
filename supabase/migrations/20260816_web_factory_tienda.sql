-- Migración: E-commerce en Web Factory (plantilla "tienda")
-- Fecha: 2026-08-16
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Flujo: Tienda estática (plantilla tienda generada por Web Factory) ->
--        funciones Netlify tienda.js (catálogo, checkout, órdenes, descarga) ->
--        Supabase (catálogo y órdenes) -> Wompi payment link ->
--        pago-webhook marca la orden como "pagada" y entrega el producto digital.
-- Patrón de seguridad: mismo que el resto del backend (service role bypassa RLS).

-- 1) Catálogo de productos por sitio (proyecto web)
create table if not exists public.tienda_productos (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    nombre text not null,
    descripcion text,
    precio_cents integer not null default 0,
    tipo text not null default 'fisico' check (tipo in ('fisico', 'digital', 'servicio')),
    imagen text,
    archivo_url text,
    stock integer,
    activo boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 2) Órdenes de compra por sitio
create table if not exists public.tienda_ordenes (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    cliente_nombre text,
    cliente_email text,
    cliente_telefono text,
    direccion text,
    total_cents integer not null default 0,
    estado text not null default 'pendiente' check (estado in ('pendiente', 'pagada', 'cancelada')),
    payment_link_id text,
    transaction_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 3) Líneas de la orden (precio congelado en el momento de la compra)
create table if not exists public.tienda_orden_items (
    id uuid primary key default gen_random_uuid(),
    orden_id uuid not null references public.tienda_ordenes(id) on delete cascade,
    producto_id uuid references public.tienda_productos(id) on delete set null,
    nombre text not null,
    precio_cents integer not null default 0,
    cantidad integer not null default 1
);

-- 4) Vincular el intento de pago (pagos) con la orden de tienda, para que
--    pago-webhook sepa qué orden marcar como pagada.
alter table public.pagos add column if not exists orden_id uuid;

-- Índices
create index if not exists tienda_productos_proyecto_idx on public.tienda_productos (proyecto_id);
create index if not exists tienda_ordenes_proyecto_idx on public.tienda_ordenes (proyecto_id);
create index if not exists tienda_ordenes_payment_link_idx on public.tienda_ordenes (payment_link_id);

-- RLS: desactivada por defecto (el backend usa la service role).
-- alter table public.tienda_productos enable row level security;
-- alter table public.tienda_ordenes enable row level security;
-- alter table public.tienda_orden_items enable row level security;
