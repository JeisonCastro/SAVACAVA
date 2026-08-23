-- Migración: Extender CHECK constraint de tienda_permisos con roles de sitios web
-- Fecha: 2026-08-23
-- Agrega: admin_sitio, editor_sitio, visor_sitio

-- Eliminar el CHECK constraint anterior
ALTER TABLE public.tienda_permisos DROP CONSTRAINT IF EXISTS tienda_permisos_rol_check;

-- Crear nuevo CHECK constraint con todos los roles
ALTER TABLE public.tienda_permisos ADD CONSTRAINT tienda_permisos_rol_check
    CHECK (rol IN ('admin_tienda', 'editor_tienda', 'visor_tienda', 'admin_sitio', 'editor_sitio', 'visor_sitio'));
