-- Migración: E-commerce evolucionado (modelo WooCommerce) — multi-tenant por proyecto
-- Fecha: 2026-08-17
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Reutilizable por WebFactory: todo queda particionado por `proyecto_id`.

-- 1) Categorías administradas por tienda (el admin las gestiona; se siembran presets)
create table if not exists public.tienda_categorias (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    nombre text not null,
    orden integer not null default 0,
    created_at timestamptz not null default now(),
    unique (proyecto_id, nombre)
);
create index if not exists tienda_categorias_proyecto_idx on public.tienda_categorias (proyecto_id);

-- 2) Atributos reutilizables entre productos de la misma tienda
create table if not exists public.tienda_atributos (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    nombre text not null,
    valores jsonb not null default '[]',
    created_at timestamptz not null default now(),
    unique (proyecto_id, nombre)
);
create index if not exists tienda_atributos_proyecto_idx on public.tienda_atributos (proyecto_id);

-- 3) Variaciones (combinaciones de atributos) por producto
create table if not exists public.tienda_variaciones (
    id uuid primary key default gen_random_uuid(),
    producto_id uuid not null references public.tienda_productos(id) on delete cascade,
    clave text not null,
    combinacion jsonb not null default '[]',
    nombre text not null,
    sku text,
    precio_cents integer,
    precio_promo_cents integer,
    stock integer,
    imagen text,
    activo boolean not null default true,
    created_at timestamptz not null default now(),
    unique (producto_id, clave)
);
create index if not exists tienda_variaciones_producto_idx on public.tienda_variaciones (producto_id);

-- 4) Clientes por tienda
create table if not exists public.tienda_clientes (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references public.web_projects(id) on delete cascade,
    email text not null,
    nombre text,
    telefono text,
    pedidos integer not null default 0,
    total_cents bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index if not exists tienda_clientes_proyecto_email_idx on public.tienda_clientes (proyecto_id, lower(email));

-- 5) Productos: tipo extendido (simple/variable/digital/servicio), categoría FK, selector de
--    atributos de variación, SKU y preparación para archivos/links/licencias/códigos digitales
alter table public.tienda_productos add column if not exists categoria_id uuid references public.tienda_categorias(id) on delete set null;
alter table public.tienda_productos add column if not exists atributos_selector jsonb;
alter table public.tienda_productos add column if not exists sku text;
alter table public.tienda_productos add column if not exists archivos jsonb;

-- 5b) El CHECK de tipo debe admitir simple/variable además de fisico/digital/servicio
alter table public.tienda_productos drop constraint if exists tienda_productos_tipo_check;
alter table public.tienda_productos add constraint tienda_productos_tipo_check check (tipo in ('fisico', 'simple', 'variable', 'digital', 'servicio'));

-- 6) Órdenes: estado de pago, método de pago y cliente
alter table public.tienda_ordenes add column if not exists estado_pago text;
alter table public.tienda_ordenes add column if not exists metodo_pago text;
alter table public.tienda_ordenes add column if not exists cliente_id uuid references public.tienda_clientes(id) on delete set null;

-- 7) Líneas de orden: variación y sku
alter table public.tienda_orden_items add column if not exists variacion_nombre text;
alter table public.tienda_orden_items add column if not exists sku text;
alter table public.tienda_orden_items add column if not exists variacion_id uuid references public.tienda_variaciones(id) on delete set null;
