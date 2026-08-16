-- Migración: Múltiples imágenes por producto de tienda
-- Fecha: 2026-08-16
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Cada producto puede tener varias imágenes (ej. distintas presentaciones o
-- colores). `imagen` (columna previa) se mantiene como portada (primera).

alter table public.tienda_productos add column if not exists imagenes jsonb;
