# FORMIES_AUVRO_MAP.md — Matriz de Reutilización (AUVRO → Nicho Deportivo)

> Este mapa refleja la **realidad del código** de AUVRO (auditado a fecha 2026-09-01) y cómo los
> requerimientos de FORMIES S.A.S. (y de CUALQUIER cliente del nicho deportivo) se resuelven
> reutilizando, adaptando o extendiendo la plataforma AUVRO. AUVRO es la plataforma base;
> FORMIES es un tenant/implementación sobre ella. Los módulos nuevos son **genéricos**:
> viven particionados por `proyecto_id` y sirven a cualquier cliente del nicho.

## Arquitectura AUVRO (resumen)

- **Tenant = `web_projects`** (proyecto web generado). Todo lo demás se cuelga de `proyecto_id`.
- **Backend**: funciones Netlify (Node 22, esbuild), patrón `supabase-admin.js` (service role) + auth Bearer JWT de Supabase. Cada función expone acciones (`action=...`).
- **Frontend admin**: SPA `dashboard.html` (vistas: agentes, crm, webfactory, bandeja, integraciones, tokens, config, admin) + `tienda-admin.html` (gestión tipo WooCommerce de una tienda).
- **Sitio público**: plantilla estática generada por Web Factory (GitHub repo privado + Netlify deploy), tokens `{{EMPRESA}}` etc., widget de agente IA embebido.
- **Pagos**: Wompi (payment links), por proyecto (pasarela del cliente en `tienda_pasarela`).
- **Base de datos**: Supabase Postgres, RLS desactivada (service role), migraciones idempotentes en `supabase/migrations/`.

## Matriz de reutilización

| Requerimiento FORMIES | Funcionalidad AUVRO | Estado | Acción |
| --------------------- | ------------------- | ------ | ------ |
| Tienda online | `tienda.js` + plantilla `tienda` + Wompi | 🟢 | Reutilizar |
| Productos (balones, uniformes, medias...) | `tienda_productos` (simple/variable) | 🟢 | Adaptar (categorías deportivas) |
| Servicios (perfil deportivo, visoría, club) | `tienda_productos` tipo `servicio` | 🟢 | Adaptar |
| Gira Argentina | `tienda_productos` tipo `tour` + variaciones tarifas | 🟢 | Adaptar (US$1.300, editar desde admin) |
| Perfil Deportivo ($350K) | `tienda_productos` tipo `servicio` | 🟢 | Adaptar |
| Visoría ($60K) | `tienda_productos` `servicio` + inscripciones nuevas | 🟡 | Extender |
| Planes Club (ELITE $180K, FORMATIVO $150K) | `tienda_productos` `servicio`/suscripción + tabla planes nueva | 🟡 | Extender |
| Agentes IA | `agentes_ia`, `chat.js`, `widget.js`, `tool-workflows.js` | 🟢 | Reutilizar (prompt FORMIES + fuentes) |
| CRM | `crm.js`, `crm_leads`, `crm_config_agente`, `tienda_pipeline`, `notifications` | 🟢 | Adaptar (clasificar por Agency/Club/Visoría/Gira/FUNMIES) |
| WhatsApp | `whatsapp-webhook.js`, `chat.js`, conexiones Meta | 🟢 | Reutilizar |
| Pagos Wompi | `crear-pago.js`, `pago-webhook.js`, `tienda.js checkout` | 🟢 | Reutilizar |
| Deportistas | No existe | 🔴 | Crear (entidad propia `deportistas`) |
| Ficha deportiva / buscador | No existe | 🔴 | Crear (sobre `deportistas`) |
| Agency | No existe (usa Deportista + CRM + tienda) | 🔴 | Crear (adaptando lo anterior) |
| Club (planes, horarios, inscripciones) | No existe como módulo | 🔴 | Crear (reusando pagos/formularios) |
| Visorías (registro→form→consent→pago→programación→evaluación) | No existe | 🔴 | Crear (reusando tienda/pagos/CRM) |
| Torneos | No existe (solo Google Calendar tool) | 🔴 | Crear (eventos con resultados/fotos) |
| Noticias / CMS | No existe CMS (solo editor IA del sitio) | 🔴 | Crear (contenido por proyecto) |
| Galería | Solo galería de producto | 🔴 | Crear (galería por proyecto, buckets) |
| Consentimiento / privacidad | No existe (solo `politicas.html` estática) | 🔴 | Crear (consentimientos por proyecto) |
| Administración autónoma | `dashboard.html` + `tienda-admin.html` | 🟢 | Adaptar (añadir sección Deportes) |
| Roles/permisos | `tienda_permisos` (admin/editor sitio+tienda) | 🟢 | Reutilizar |
| Almacenamiento imágenes/videos | Supabase Storage (buckets) + `subir-imagen-producto.js` | 🟡 | Extender (bucket `deportes`) |

## Entidades nuevas (genéricas, particionadas por `proyecto_id`)

- `deportes_deportistas` — ficha del deportista (foto, datos, posición, estadísticas, videos, ficha, público/activo).
- `deportes_club_planes` — planes administrables (seed: ELITE $180.000, FORMATIVO $150.000).
- `deportes_club_horarios` — categorías/horarios.
- `deportes_inscripciones` — inscripciones a club/planes/visorías (responsable, deportista, estado, pago).
- `deportes_visorias` — convocatorias de visoría (fecha, costo $60K, cupo, estado).
- `deportes_torneos` — torneos/eventos (categorías, fechas, lugar, resultados, fotos).
- `deportes_noticias` — CMS/noticias (convocatorias, resultados, torneos, visorías, jugadores, giras, institucional).
- `deportes_galeria` — galería multimedia (club, agency, argentina, FUNMIES).
- `deportes_consentimientos` — consentimiento/responsable/uso de imagen/tratamiento de datos/fecha/estado/versión.

> Los pagos de visoría/club/gira/perfil se apoyan en `tienda_productos` + `tienda_ordenes` +
> Wompi existentes; `deportes_inscripciones` referencia la orden/pago.

## Decisión de diseño

- AUVRO **no se bifurca**: se extiende con módulos deportivos genéricos disponibles para todo
  proyecto que los active. FORMIES es el primer tenant que los usa (plantilla `tienda` + módulos).
- El sitio público FORMIES usa la **plantilla `tienda` existente** (motor comercial + agente IA +
  WhatsApp + Wompi), con identidad/contenido FORMIES.
