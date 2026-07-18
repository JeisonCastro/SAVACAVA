-- Migración: Agregar campo is_admin a perfiles
-- Ejecutar en Supabase SQL Editor

-- 1) Agregar columna is_admin
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;

-- 2) Hacer que el primer usuario registrado sea admin automático
-- (Solo ejecutar UNA VEZ después de crear la columna)
-- UPDATE perfiles SET is_admin = true WHERE id = (
--     SELECT id FROM auth.users ORDER BY created_at ASC LIMIT 1
-- );

-- 3) Política RLS: solo admins pueden ver/modificar is_admin de otros
-- (Opcional, por seguridad extra)
