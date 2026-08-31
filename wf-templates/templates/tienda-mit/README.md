# {{EMPRESA}}

Tienda en línea generada con **Web Factory (AUVRO)**. Plantilla: `tienda-mit` (estética Bootstrap / Start Bootstrap).

Estética basada en **Shop Homepage - Start Bootstrap** (https://startbootstrap.com/template/shop-homepage),
Copyright 2013-2023 Start Bootstrap LLC, licenciada bajo MIT (ver `LICENSE-MIT.txt`).

El **motor de comercio** (catálogo, carrito, checkout y pago seguro Wompi) es el de AUVRO: se conecta
a `/.netlify/functions/tienda` usando el `data-slug` del sitio. Se administra desde el dashboard AUVRO.

## Deploy

Este repositorio está conectado a Netlify; cada push a la rama `main` se despliega automáticamente.

## Local

```bash
git clone <URL_DEL_REPO> .
```

Abre `index.html` en tu navegador. No requiere dependencias.

## Personalización

Edita `index.html` y `styles.css` según la marca. Puedes reemplazar los textos
marcados (`EMPRESA`, `DESCRIPCION`, `SLOGAN`, `LOGO`, `WHATSAPP`, `SLUG`). Si el
número de WhatsApp queda vacío, los botones de WhatsApp se ocultan solos.
