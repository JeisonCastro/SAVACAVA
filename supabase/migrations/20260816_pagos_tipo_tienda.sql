-- Migración: permitir pagos de tienda en la tabla pagos
-- Fecha: 2026-08-16
-- Motivo: el CHECK "pagos_tipo_check" de la tabla pagos no incluía el tipo
--         'tienda', por lo que el checkout de Web Factory fallaba con
--         "No se pudo registrar el pago." (error 23514, check_violation).
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Valores de tipo usados por el backend: 'venta' (CRM), 'tokens' (recargas),
--         'plan' (suscripciones) y 'tienda' (e-commerce Web Factory).

-- (Opcional, diagnóstico) ver la definición actual:
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'pagos_tipo_check';

alter table public.pagos drop constraint if exists pagos_tipo_check;
alter table public.pagos add constraint pagos_tipo_check check (tipo in ('venta', 'tokens', 'plan', 'tienda'));
