-- Migración: Integración CRM ↔ Tiendas
-- Fecha: 2026-08-18
-- Idempotente: se puede ejecutar varias veces sin errores.
--
-- Objetivos:
--   1. Vincular agentes con tiendas (agente → tienda → catálogo de tienda)
--   2. Relacionar leads/órdenes con tiendas (CRM filtra por tienda)
--   3. Relacionar órdenes con agentes (trazabilidad de ventas)
--   4. Vista unificada de catálogo (tienda + CRM en una sola consulta)

-- ═══════════════════════════════════════════════════════════════
-- 1) AGENTE → TIENDA
-- ═══════════════════════════════════════════════════════════════
-- Cada agente puede estar vinculado a UNA tienda (web_projects con plantilla='tienda').
-- Si tiene tienda → su catálogo proviene de tienda_productos.
-- Si no tiene tienda → usa su catálogo CRM (crm_config_agente.catalogo, sin cambios).

ALTER TABLE public.agentes_ia
    ADD COLUMN IF NOT EXISTS tienda_id uuid REFERENCES public.web_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agentes_ia_tienda ON public.agentes_ia(tienda_id);

-- ═══════════════════════════════════════════════════════════════
-- 2) LEAD → TIENDA
-- ═══════════════════════════════════════════════════════════════
-- Para que el CRM pueda filtrar leads por tienda.

ALTER TABLE public.crm_leads
    ADD COLUMN IF NOT EXISTS proyecto_id uuid REFERENCES public.web_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_leads_proyecto ON public.crm_leads(proyecto_id);

-- ═══════════════════════════════════════════════════════════════
-- 3) ORDEN → AGENTE
-- ═══════════════════════════════════════════════════════════════
-- Para trazabilidad: qué agente generó cada venta de tienda.

ALTER TABLE public.tienda_ordenes
    ADD COLUMN IF NOT EXISTS agente_id integer REFERENCES public.agentes_ia(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tienda_ordenes_agente ON public.tienda_ordenes(agente_id);

-- ═══════════════════════════════════════════════════════════════
-- 4) CATÁLOGO UNIFICADO (vista)
-- ═══════════════════════════════════════════════════════════════
-- Combina productos de tienda + catálogo CRM en una sola vista.
-- El CRM y el chat pueden consultar esta vista para obtener el catálogo
-- correcto sin importar de dónde proviene.

CREATE OR REPLACE VIEW public.v_catalogo_unificado AS
-- Productos de tienda
SELECT
    tp.id,
    tp.proyecto_id,
    NULL::integer AS agente_id,
    tp.nombre,
    tp.descripcion,
    tp.precio_cents,
    tp.tipo,
    tp.imagen,
    tp.stock,
    tp.activo,
    tp.sku,
    tp.categoria_id,
    tc.nombre AS categoria_nombre,
    'tienda' AS fuente,
    tp.created_at
FROM public.tienda_productos tp
LEFT JOIN public.tienda_categorias tc ON tc.id = tp.categoria_id

UNION ALL

-- Catálogo CRM (expandido desde el jsonb)
SELECT
    (item->>'id')::uuid AS id,
    NULL::uuid AS proyecto_id,
   cca.agente_id,
    item->>'nombre' AS nombre,
    item->>'descripcion' AS descripcion,
    (item->>'precio_cents')::integer AS precio_cents,
    COALESCE(item->>'tipo', 'servicio') AS tipo,
    item->>'url_imagen' AS imagen,
    NULL::integer AS stock,
    COALESCE((item->>'disponible')::boolean, true) AS activo,
    NULL::text AS sku,
    NULL::uuid AS categoria_id,
    item->>'categoria' AS categoria_nombre,
    'crm' AS fuente,
    now() AS created_at
FROM public.crm_config_agente cca,
     jsonb_array_elements(COALESCE(cca.catalogo, '[]'::jsonb)) AS item
WHERE cca.crm_activo = true;
