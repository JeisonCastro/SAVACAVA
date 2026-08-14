-- Migración: Web Factory — personalización de sitios (logo, slogan, WhatsApp)
-- Fecha: 2026-08-14
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Agrega a web_projects los campos opcionales que alimentan los tokens
-- {{LOGO}}, {{SLOGAN}} y {{WHATSAPP}} de las plantillas.

alter table public.web_projects add column if not exists logo text;
alter table public.web_projects add column if not exists slogan text;
alter table public.web_projects add column if not exists whatsapp text;
