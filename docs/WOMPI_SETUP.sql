-- ============================================================
-- AUVRO · Integración de pagos Wompi
-- Pega este bloque en el SQL Editor de Supabase y ejecútalo.
-- Crea la tabla `pagos` usada por crear-pago.js y pago-webhook.js
-- ============================================================

create table if not exists public.pagos (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    tipo text not null check (tipo in ('tokens','plan')),
    concepto text not null,
    monto_cents bigint not null,
    tokens integer,
    plan_id integer,
    payment_link_id text unique,
    transaction_id text,
    estado text not null default 'pendiente' check (estado in ('pendiente','aprobado','fallido')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.pagos enable row level security;

create policy "pagos_select_own" on public.pagos
    for select using (auth.uid() = user_id);

create policy "pagos_insert_own" on public.pagos
    for insert with check (auth.uid() = user_id);

create index if not exists idx_pagos_payment_link on public.pagos(payment_link_id);
create index if not exists idx_pagos_user on public.pagos(user_id);
