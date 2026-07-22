-- Agregar columnas para Shopify en composio_connections
ALTER TABLE composio_connections
ADD COLUMN IF NOT EXISTS agente_id UUID REFERENCES agentes(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS shopify_store_url TEXT,
ADD COLUMN IF NOT EXISTS access_token TEXT;

-- Crear indice para busqueda rapida por agente
CREATE INDEX IF NOT EXISTS idx_composio_connections_agente ON composio_connections(agente_id);

-- Comentario para documentacion
COMMENT ON COLUMN composio_connections.agente_id IS 'ID del agente asociado a esta conexion';
COMMENT ON COLUMN composio_connections.shopify_store_url IS 'URL de la tienda Shopify (ej: mitienda.myshopify.com)';
COMMENT ON COLUMN composio_connections.access_token IS 'Access Token de la API Admin de Shopify';
