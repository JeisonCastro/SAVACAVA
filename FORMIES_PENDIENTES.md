# FORMIES_PENDIENTES.md — Pendientes, Decisiones y Config Externas

> Se actualiza conforme avanza la implementación. Tareas sin completar, decisiones pendientes
> y configuraciones que requieren acción del cliente/operador (no del código).

## Pendientes de implementación (loop)

- [x] Migración DB `deportes_*` + seeds planes (ELITE/FORMATIVO) — **aplicada** (CLI linked).
- [x] Backend `deportes.js` + `subir-imagen-deporte.js` + bucket `deportes`.
- [x] Dashboard: sección "Deportes" (deportistas, club, visorías, torneos, noticias, galería, consentimientos).
- [x] Pagos visoría/club vía `pago_inscripcion` (orden tienda + Wompi) + botón en panel.
- [x] Agente IA deportivo: `construirTextoDeportesTienda` inyectado en el prompt del agente con tienda.
- [x] Plantilla `tienda` con secciones deportivas condicionales (deportistas, planes, visorías, noticias).
- [ ] **Catálogo FORMIES real**: crear en la tienda los productos/servicios (balones, uniformes, pantalonetas, medias, chaquetas, portero; Perfil Deportivo $350K; Gira Argentina tour US$1.300; Visoría $60K como `servicio` para pago directo). Requiere sesión de admin en el panel.
- [ ] **Agente IA FORMIES**: crear/editar el agente del sitio con `tienda_id` = proyecto FORMIES + prompt deportivo.
- [ ] Seguridad: verificar que las fichas públicas no exponen datos privados de menores sin consentimiento.
- [ ] Responsive + SEO + auditoría final.

## Decisiones tomadas

- Los módulos deportivos son **genéricos de AUVRO** (cualquier cliente del nicho); FORMIES es el primer tenant.
- Sitio público FORMIES = plantilla `tienda` existente (motor comercial + agente + WhatsApp + Wompi).
- Deportista es entidad propia; no se modela como producto.
- Pagos visoría/club/gira/perfil reutilizan `tienda_productos` + `tienda_ordenes` + Wompi.

## Decisiones pendientes (requieren al usuario)

- [ ] **Bucket/dominio público**: confirmar si el bucket de imágenes deportivas se llama `deportes` o se reutiliza `productos`. (Actual: `deportes`, ya usado por `subir-imagen-deporte.js`.)
- [ ] **Campo de venta del Club**: los planes ELITE/FORMATIVO — ¿se cobran como suscripción recurrente (nuevo) o como pago único por mes vía tienda? (Inicialmente: pago único mensual vía `pago_inscripcion`/Wompi.)
- [ ] **Precios en COP vs USD**: la Gira Argentina es US$1.300 — confirmar si se cobra en USD o COP equivalente (Wompi cobra COP; se puede usar tasa fija configurable).
- [x] **Visoría $60K**: requiere cupo limitado y evaluación registrada en panel. (Sí: `deportes_visorias.cupo` + `deportes_inscripciones.evaluacion`/estado `evaluada`.)

## Configuraciones externas necesarias

- [ ] Llaves Wompi del cliente (prod/sandbox) → `tienda_pasarela`.
- [ ] Conexión WhatsApp Business (Meta) del cliente.
- [ ] Tokens de edición IA del sitio (`site-editor`) si se usan.
- [ ] Dominio personalizado FORMIES (opcional) en `web_projects.dominio`.
- [ ] Credenciales GitHub (para Web Factory) ya configuradas a nivel plataforma.

## Notas

- Todo cambio funcional se documenta en `docs/AUVRO_CONTEXT.md` (changelog) en el mismo commit.
