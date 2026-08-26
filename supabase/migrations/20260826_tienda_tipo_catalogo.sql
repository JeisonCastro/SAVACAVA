-- Agregar tipo 'catalogo' para productos sin precio ni carrito (solo exhibición)
-- Ejemplo: catálogo de tortas, portfolios, catálogos de productos sin venta online

ALTER TABLE public.tienda_productos
  DROP CONSTRAINT IF EXISTS tienda_productos_tipo_check;

ALTER TABLE public.tienda_productos
  ADD CONSTRAINT tienda_productos_tipo_check
  CHECK (tipo IN ('fisico', 'simple', 'variable', 'digital', 'servicio', 'catalogo'));
