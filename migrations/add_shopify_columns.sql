-- Agregar columnas para Shopify en composio_connections
-- NOTA: Esta tabla es por usuario (no por agente)
ALTER TABLE composio_connections
ADD COLUMN IF NOT EXISTS shopify_store_url TEXT,
ADD COLUMN IF NOT EXISTS access_token TEXT;

-- Comentario para documentacion
COMMENT ON COLUMN composio_connections.shopify_store_url IS 'URL de la tienda Shopify (ej: mitienda.myshopify.com)';
COMMENT ON COLUMN composio_connections.access_token IS 'Access Token de la API Admin de Shopify';
