-- Migración: índices para el embudo de ventas y filtros por fecha en el CRM
-- Mejoran el rendimiento de las consultas que filtran por fecha de creación
-- del lead (dashboard CRM → Embudo de ventas).

create index if not exists idx_crm_leads_user_created
    on public.crm_leads (user_id, created_at);

create index if not exists idx_crm_leads_agente_created
    on public.crm_leads (agente_id, created_at);
