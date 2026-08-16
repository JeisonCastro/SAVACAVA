-- Migración: Notificaciones de tienda (Gmail del cliente + avisos de ventas)
-- Fecha: 2026-08-16
-- Idempotente: se puede ejecutar varias veces sin errores.
-- Flujo: cada tienda puede conectar el Gmail DEL CLIENTE (Composio, entity por tienda)
--        y activar avisos por correo/WhatsApp para "nuevo pedido" y "pago confirmado".
--        También corrige el CHECK de pagos (permite tipo 'tienda'), sin el cual el
--        checkout fallaba con "No se pudo registrar el pago." (23514).

-- 1) Conexión Gmail de la tienda + configuración de avisos (en tienda_pasarela, 1 fila por tienda)
alter table public.tienda_pasarela add column if not exists composio_gmail_entity_id text;
alter table public.tienda_pasarela add column if not exists gmail_conectado_email text;
alter table public.tienda_pasarela add column if not exists notify_on_new_order boolean not null default true;
alter table public.tienda_pasarela add column if not exists notify_on_payment boolean not null default true;
alter table public.tienda_pasarela add column if not exists notify_emails jsonb;
alter table public.tienda_pasarela add column if not exists notify_whatsapp_agente_id integer;
alter table public.tienda_pasarela add column if not exists notify_whatsapp_numero text;

-- 2) Fix checkout de tienda: pagos debe admitir el tipo 'tienda'
alter table public.pagos drop constraint if exists pagos_tipo_check;
alter table public.pagos add constraint pagos_tipo_check check (tipo in ('venta', 'tokens', 'plan', 'tienda'));

-- RLS: desactivada por defecto (el backend usa la service role).
-- alter table public.tienda_pasarela enable row level security;
