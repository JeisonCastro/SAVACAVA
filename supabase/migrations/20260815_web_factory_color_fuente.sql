-- Migración: Web Factory — personalización de sitios (color principal + estilo de fuente)
-- Fecha: 2026-08-15
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Agrega a web_projects los campos opcionales que alimentan la personalización
-- visual de las plantillas generadas (color de acento y fuente elegida).

alter table public.web_projects add column if not exists accent_color text;
alter table public.web_projects add column if not exists fuente text;
