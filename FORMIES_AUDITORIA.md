# FORMIES_AUDITORIA.md — Auditoría del Módulo Deportes (AUVRO) en FORMIES

> Fecha: 2026-09-01. Auditoría del **canal de publicación** del módulo Deportes para FORMIES
> (y cualquier tenant del nicho deportivo): `admin → crear → subir → guardar → publicar → sitio público → usuario final`.
> Cada fila cita el código real que lo verifica.

## Resumen ejecutivo (veredicto)

- **El backend, frontend admin y plantilla son correctos.** El contenido que se guarda en admin ya se
  filtra por `publico=true AND activo=true` en `catalogo_publico` y se publica de forma **dinámica** (sin redeploy).
- **Causa raíz del "no se ve en público":** el sitio FORMIES (`https://formies-1.netlify.app/`) tenía un
  `index.html` snapshot **pre-Deportes** (sin `grid-deportistas`, `catalogo_publico`, ni secciones deportivas).
  Los sitios creados antes de añadir un módulo no reciben módulos nuevos (limitación ya documentada en
  `docs/AUVRO_CONTEXT.md:1442`).
- **Fix reutilizable (no FORMIES-específico):** acción `resync_template` en `web-factory.js` merge quirúrgico
  de `inyectarDeportesEnHtml` (secciones + CSS + JS) en el repo existente, + botón "Re-sincronizar plantilla"
  en el dashboard + rebuild en Netlify. Aplica a CUALQUIER store existente.
- **Segunda causa raíz (descubierta en la verificación final):** el JS del catálogo se inyectaba con
  `String.replace(regex, SNIPPET)`. El snippet contiene `return '$'` (signo de pesos) y, en un **string
  replacement**, `$'` se interpreta como *"el resto de la cadena tras la coincidencia"* → al insertarse tras
  `</body>` quedaba `return '\n</html>`, **rompiendo el parseo del `<script>`** → secciones ocultas pese a
  tener el módulo. Fix: insertar vía **callback** (`() => SNIPPET`) en los 3 `.replace()` de
  `inyectarDeportesEnHtml`, + `repararJsCatalogo` que **repara** el HTML ya sincronizado con ese daño.

## Matriz de verificación (evidencia de código)

| # | Requisito | Estado | Evidencia (archivo:línea) |
| - | --------- | ------ | ------------------------- |
| 1 | Admin puede crear/editar deportista | 🟢 | `tienda-admin.html:1166 depFormDeportista` → `guardar_deportista`; `deportes.js:252 guardarDeportista` |
| 2 | Subida de imagen directa (no solo URL) | 🟢 | `tienda-admin.html:1114 depSubir` (FileReader→`data_url`) → `subir-imagen-deporte.js:117` bucket `deportes`, URL pública en `fotografia_url` |
| 3 | Backend persiste `publico`/`activo` | 🟢 | `deportes.js:247 publico: body.publico !== false`, `:248 activo: body.activo !== false` |
| 4 | `catalogo_publico` filtra publicados | 🟢 | `deportes.js:117` `.eq('proyecto_id').eq('publico',true).eq('activo',true)` (deportistas); planes/visorías/noticias con `.eq('activo',true)` |
| 5 | Storefront público consuma `catalogo_publico` | 🟢 | `wf-templates/templates/tienda/index.html` línea 682 `fetch(...deportes)` `action:'catalogo_publico'`; rellena `grid-deportistas/planes/visorias/noticias` |
| 6 | Publicación dinámica (sin redeploy AUVRO) | 🟢 | La plantilla obtiene datos en el navegador del visitante desde el endpoint; no hay build por cada alta |
| 7 | **Sitio existente (FORMIES) recibe el módulo** | 🟢 (fix) | `web-factory.js` `inyectarDeportesEnHtml` + acción `resync_template` + `dashboard.html` botón "Re-sincronizar plantilla" |
| 8 | Merge no destructivo de la personalización | 🟢 | `inyectarDeportesEnHtml` solo inserta si faltan `grid-deportistas`/`catalogo_publico`; no reescribe el resto del HTML (test idempotente PASS) |
| 9 | Tenant isolation (admin) | 🟢 | `deportes.js:64-81 autenticarAdmin`: `is_admin` o `created_by===userId` o rol `tienda_permisos` del `proyecto_id`; `subir-imagen-deporte.js:79-93` mismo patrón; todo CRUD filtra `.eq('proyecto_id',…)` |
| 10 | Seguridad ficha pública de menores | 🟢 (fix) | `deportes.js:116` `catalogo_publico` ya NO incluye `estadisticas`, `videos`, `ficha`, `peso_kg` en el payload público |
| 11 | Estados Borrador/Publicado/Oculto/Archivado | 🟢 | `activo` (publicado/oculto) + `publico` (borrador/oculto del deportista); "Archivado/eliminado" via `eliminar_*`. Plantilla solo muestra `activo=true` |
| 12 | Reusabilidad (no código FORMIES) | 🟢 | Todo vive particionado por `proyecto_id`; sin mención de FORMIES en funciones; `dashboards` button es genérico |

## Comprobación realizada en el sitio público

`https://formies-1.netlify.app/` (antes del fix):
- Tiene motor tienda/`data-slug=formies`/widget ✓
- **Faltan** `catalogo_publico`, `grid-deportistas`, `grid-planes`, `id="deportistas"` ✗ ← causa raíz
- `formies.netlify.app` es OTRO producto francés (no AUVRO). El store real es `formies-1.netlify.app`.

## Pasos de operación (una sola vez) para publicar FORMIES

1. Desplegar AUVRO con el fix (`resync_template` + `inyectarDeportesEnHtml` con callback + `repararJsCatalogo` + botón).
2. En el dashboard → Web Factory → card FORMIES → "Re-sincronizar plantilla".
   - Este segundo re-sync es imprescindible: repara el JS del catálogo ya grabado en el repo con la corrupción `$'`.
3. Esperar el build Netlify (~1-2 min) y re-verificar que `https://formies-1.netlify.app/` ahora contiene
   `catalogo_publico` y `id="deportistas"` **y que el `fmtPesos` del JS es sano** (`return '$'`).
4. Crear contenido deportivo real en `tienda-admin` → Deportes (deportistas públicos `publico=true` activos,
   planes ELITE/FORMATIVO ya seedeados, visorías, noticias).
5. Re-abrir el sitio → secciones Deportes visibles con el contenido.

## Verificación automática del merge (test ejecutado)

El helper `inyectarDeportesEnHtml` se probó contra un `index.html` simulado pre-Deportes:
- Inserta `id="deportistas"/"planes"/"visorias"/"noticias"`, `grid-*`, JS `catalogo_publico`, CSS `.card-deporte` ✓
- **Preserva** el contenido personalizado (marcador `CUSTOM`), el `<footer>` y el `data-slug` ✓
- **Idempotente**: una segunda llamada no modifica nada (`out2 === out`) ✓