-- Agregar tipo 'tour' para productos de turismo (paquetes con tarifas/escalas por
-- pasajero via variaciones; no comprables directo, el agente de IA cierra por chat/WhatsApp).

ALTER TABLE public.tienda_productos
  DROP CONSTRAINT IF EXISTS tienda_productos_tipo_check;

ALTER TABLE public.tienda_productos
  ADD CONSTRAINT tienda_productos_tipo_check
  CHECK (tipo IN ('fisico', 'simple', 'variable', 'digital', 'servicio', 'catalogo', 'tour'));
