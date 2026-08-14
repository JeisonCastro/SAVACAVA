-- Migración: Web Factory — columna dominio_error (fallo del dominio opcional, no bloquea el proyecto)
-- Fecha: 2026-08-14
-- Idempotente: se puede ejecutar varias veces sin errores.

alter table public.web_projects
    add column if not exists dominio_error text;
