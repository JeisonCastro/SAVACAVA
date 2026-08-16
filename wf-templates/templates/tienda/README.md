# {{EMPRESA}} — Tienda

Sitio de e-commerce generado con **Web Factory (AUVRO)**. Plantilla: `tienda` (estática, sin build).

## Cómo funciona

El catálogo, el carrito y el pago viven en la infraestructura de AUVRO:

- El sitio estático consulta `https://auvro.netlify.app/.netlify/functions/tienda` (acción `catalogo`) para listar productos.
- El checkout crea una orden en Supabase y un link de pago en **Wompi** (PSE, tarjeta, Nequi).
- `pago-webhook` marca la orden como pagada y entrega el producto digital.

## Deploy

Este repositorio está conectado a Netlify; cada push a la rama `main` se despliega automáticamente.

## Local

```bash
git clone <URL_DEL_REPO> .
```

Abre `index.html` en tu navegador. No requiere dependencias.

## Personalización

Edita `index.html` y `styles.css` según la marca. Puedes reemplazar los textos
marcados (`EMPRESA`, `DESCRIPCION`, `SLOGAN`, `LOGO`, `WHATSAPP`). Si el logo o el
número de WhatsApp quedan vacíos, el sitio se genera igual (esos elementos se ocultan).

Los productos y órdenes se administran desde el dashboard de AUVRO (sección Web Factory → Tienda).
