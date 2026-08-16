-- Migración: Pasarela de pago por tienda (claves Wompi del cliente)
-- Fecha: 2026-08-16
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Flujo: cada sitio "tienda" usa la pasarela Wompi DE SU CLIENTE (private key + events secret + sandbox),
--        igual que el CRM usa las claves de cada agente (crm_config_agente).
--        Las claves se guardan por proyecto y NUNCA se devuelven al frontend (solo estado enmascarado).
-- Patrón de seguridad: mismo que el resto del backend (service role bypassa RLS).

create table if not exists public.tienda_pasarela (
    proyecto_id uuid primary key references public.web_projects(id) on delete cascade,
    wompi_private_key text,
    wompi_events_secret text,
    wompi_sandbox boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- RLS: desactivada por defecto (el backend usa la service role).
-- alter table public.tienda_pasarela enable row level security;
