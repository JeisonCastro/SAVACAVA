# FORMIES_PENDIENTES.md — Pendientes, Decisiones y Config Externas

> Se actualiza conforme avanza la implementación. Tareas sin completar, decisiones pendientes
> y configuraciones que requieren acción del cliente/operador (no del código).

## Pendientes de implementación (loop)

- [ ] Migración DB `deportes_*` + seeds planes (ELITE/FORMATIVO).
- [ ] Backend `deportes.js` + `subir-imagen-deporte.js` + bucket `deportes`.
- [ ] Dashboard: sección "Deportes" (deportistas, club, visorías, torneos, noticias, galería, consentimientos).
- [ ] Plantilla `tienda` con identidad deportiva + tokens + agente IA deportivo.
- [ ] Pagos visoría/club/gira/perfil (Wompi) + notificaciones.
- [ ] Seguridad: fichas públicas sin datos privados de menores; consentimientos obligatorios.
- [ ] Responsive + SEO + auditoría final.

## Decisiones tomadas

- Los módulos deportivos son **genéricos de AUVRO** (cualquier cliente del nicho); FORMIES es el primer tenant.
- Sitio público FORMIES = plantilla `tienda` existente (motor comercial + agente + WhatsApp + Wompi).
- Deportista es entidad propia; no se modela como producto.
- Pagos visoría/club/gira/perfil reutilizan `tienda_productos` + `tienda_ordenes` + Wompi.

## Decisiones pendientes (requieren al usuario)

- [ ] **Bucket/dominio público**: confirmar si el bucket de imágenes deportivas se llama `deportes` o se reutiliza `productos`.
- [ ] **Campo de venta del Club**: los planes ELITE/FORMATIVO — ¿se cobran como suscripción recurrente (nuevo) o como pago único por mes vía tienda? (Inicialmente: pago único mensual vía tienda/Wompi.)
- [ ] **Precios en COP vs USD**: la Gira Argentina es US$1.300 — confirmar si se cobra en USD o COP equivalente (Wompi cobra COP; se puede usar tasa fija configurable).
- [ ] **Visoría $60K**: ¿requiere cupo limitado y evaluación registrada en panel? (Sí por defecto.)

## Configuraciones externas necesarias

- [ ] Llaves Wompi del cliente (prod/sandbox) → `tienda_pasarela`.
- [ ] Conexión WhatsApp Business (Meta) del cliente.
- [ ] Tokens de edición IA del sitio (`site-editor`) si se usan.
- [ ] Dominio personalizado FORMIES (opcional) en `web_projects.dominio`.
- [ ] Credenciales GitHub (para Web Factory) ya configuradas a nivel plataforma.

## Notas

- Todo cambio funcional se documenta en `docs/AUVRO_CONTEXT.md` (changelog) en el mismo commit.
