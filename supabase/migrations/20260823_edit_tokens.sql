-- Migración: Agregar columna edit_tokens a web_projects
-- Fecha: 2026-08-23
-- Cada sitio inicia con 10,000 tokens de edición AI

-- Agregar columna edit_tokens (default 10000)
ALTER TABLE public.web_projects ADD COLUMN IF NOT EXISTS edit_tokens INTEGER NOT NULL DEFAULT 10000;

-- Agregar columna edit_tokens_used para tracking
ALTER TABLE public.web_projects ADD COLUMN IF NOT EXISTS edit_tokens_used INTEGER NOT NULL DEFAULT 0;

-- Tabla de log de consumo de tokens de edición
CREATE TABLE IF NOT EXISTS public.edit_token_log (
    id BIGSERIAL PRIMARY KEY,
    proyecto_id UUID REFERENCES public.web_projects(id) ON DELETE CASCADE,
    tokens_used INTEGER NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Tabla de órdenes de recarga de tokens de edición
CREATE TABLE IF NOT EXISTS public.edit_token_orders (
    id BIGSERIAL PRIMARY KEY,
    proyecto_id UUID REFERENCES public.web_projects(id) ON DELETE CASCADE,
    tokens_added INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    plan_name TEXT NOT NULL,
    estado TEXT DEFAULT 'pendiente',
    payment_link_id TEXT,
    transaction_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Asignar 10,000 tokens a todos los proyectos existentes que no tengan
UPDATE public.web_projects SET edit_tokens = 10000 WHERE edit_tokens IS NULL OR edit_tokens = 0;
