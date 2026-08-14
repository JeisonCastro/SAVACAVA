-- Migración: Web Factory — columna default_branch (rama que Netlify debe desplegar)
-- Fecha: 2026-08-13
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Al crear el repo con auto_init, GitHub crea la rama default (main o master); se guarda
-- aquí para que el site de Netlify se enlace a la rama correcta.

alter table public.web_projects
    add column if not exists default_branch text;
