-- Migración: Categorías, atributos y variantes en productos de tienda
-- Fecha: 2026-08-16
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Refleja el modelo del catálogo CRM (crm_config_agente.catalogo): cada producto
-- tiene `categoria` (agrupación/filtro), `atributos` (clave:valor libre, ej.
-- color, material, talla) y `variantes` (opciones con precio adicional y stock
-- propio, ej. color/talla/paquete). Sirve para físicos, digitales y servicios.

alter table public.tienda_productos add column if not exists categoria text;
alter table public.tienda_productos add column if not exists atributos jsonb;
alter table public.tienda_productos add column if not exists variantes jsonb;

-- Índice ligero para filtrar por categoría
create index if not exists tienda_productos_categoria_idx on public.tienda_productos (proyecto_id, categoria);
