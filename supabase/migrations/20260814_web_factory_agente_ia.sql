-- Migración: Web Factory — agente de IA embebible en el sitio generado
-- Fecha: 2026-08-14
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Agrega a web_projects el id del agente (agentes_ia) cuyo widget.js
-- se inyecta en el index.html del sitio generado (campo opcional).

alter table public.web_projects add column if not exists agente_id bigint;
