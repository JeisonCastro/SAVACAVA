const crypto = require('crypto');
const { supabase } = require('./supabase-admin');
const { fechaVencimiento } = require('./suscripciones');

const headers = { "Content-Type": "application/json" };

function getByPath(obj, path) {
    return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function verificarFirma(payload, headerChecksum, secretOverride) {
    const secret = secretOverride || process.env.WOMPI_EVENTS_SECRET;
    if (!secret) return false;

    const sig = payload.signature;
    if (!sig || !Array.isArray(sig.properties) || sig.properties.length === 0) return false;

    const cadena =
        sig.properties
            .map(p => {
                const v = getByPath(payload.data, p);
                return v === null || v === undefined ? '' : String(v);
            })
            .join('') +
        String(payload.timestamp) +
        secret;

    const checksum = crypto.createHash('sha256').update(cadena).digest('hex');
    const esperada = String(sig.checksum || headerChecksum || '');

    if (!esperada) return false;
    try {
        return crypto.timingSafeEqual(
            Buffer.from(checksum, 'hex'),
            Buffer.from(esperada, 'hex')
        );
    } catch (_) {
        return false;
    }
}

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

        let payload;
        try {
            payload = JSON.parse(event.body || '{}');
        } catch (_) {
            return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'JSON inválido' }) };
        }

        const headerChecksum = event.headers['x-event-checksum'] || '';

        if (payload.event !== 'transaction.updated') {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: true }) };
        }

        const transaction = payload.data?.transaction;
        if (!transaction) {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: true }) };
        }

        // Buscar el intento de pago por su payment_link_id: necesario para saber
        // con qué secret verificar (plataforma vs vendedor en ventas CRM).
        const { data: pago } = await supabase
            .from('pagos')
            .select('*')
            .eq('payment_link_id', transaction.payment_link_id)
            .single();

        if (!pago) {
            console.warn('Intento de pago no encontrado para link:', transaction.payment_link_id);
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: 'sin_intento' }) };
        }

        // Para ventas CRM la firma usa el events secret DEL AGENTE (pasarela del vendedor).
        // Para pagos de tienda usa el events secret DEL CLIENTE (tienda_pasarela del sitio).
        let secret = process.env.WOMPI_EVENTS_SECRET;
        if (pago.tipo === 'venta') {
            const { data: lead } = pago.lead_id
                ? await supabase.from('crm_leads').select('agente_id').eq('id', pago.lead_id).maybeSingle()
                : { data: null };
            if (lead?.agente_id) {
                const { data: config } = await supabase
                    .from('crm_config_agente')
                    .select('wompi_events_secret')
                    .eq('agente_id', lead.agente_id)
                    .maybeSingle();
                if (config?.wompi_events_secret) secret = config.wompi_events_secret;
            }
        } else if (pago.tipo === 'tienda' && pago.orden_id) {
            const { data: orden } = await supabase
                .from('tienda_ordenes')
                .select('proyecto_id')
                .eq('id', pago.orden_id)
                .maybeSingle();
            if (orden?.proyecto_id) {
                const { data: pasarela } = await supabase
                    .from('tienda_pasarela')
                    .select('wompi_events_secret')
                    .eq('proyecto_id', orden.proyecto_id)
                    .maybeSingle();
                if (pasarela?.wompi_events_secret) secret = pasarela.wompi_events_secret;
            }
        }

        const firmoConSecret = verificarFirma(payload, headerChecksum, secret);
        if (!firmoConSecret) {
            console.warn('Webhook Wompi con firma inválida');
            return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Firma inválida' }) };
        }

        if (transaction.status !== 'APPROVED') {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignorado: true, status: transaction.status }) };
        }

        if (pago.estado === 'aprobado') {
            return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ya: true }) };
        }

        if (Number(pago.monto_cents) !== Number(transaction.amount_in_cents)) {
            console.warn('Monto no coincide:', pago.monto_cents, transaction.amount_in_cents);
            return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Monto no coincide' }) };
        }

        if (pago.tipo === 'tokens') {
            const { data: perfil } = await supabase
                .from('perfiles')
                .select('token_balance')
                .eq('id', pago.user_id)
                .single();
            const nuevo = (perfil?.token_balance || 0) + (pago.tokens || 0);
            const { error } = await supabase
                .from('perfiles')
                .update({ token_balance: nuevo })
                .eq('id', pago.user_id);
            if (error) throw new Error('Error acreditando tokens: ' + error.message);
        } else if (pago.tipo === 'plan') {
            const { error } = await supabase
                .from('perfiles')
                .update({
                    plan_id: pago.plan_id,
                    plan_inicio: new Date().toISOString(),
                    plan_vencimiento: fechaVencimiento()
                })
                .eq('id', pago.user_id);
            if (error) throw new Error('Error asignando plan: ' + error.message);
        } else if (pago.tipo === 'venta') {
            if (pago.lead_id) {
                const { error: leadErr } = await supabase.rpc('cerrar_lead_venta', {
                    p_lead_id: pago.lead_id,
                    p_valor_cents: pago.monto_cents
                });
                if (leadErr) throw new Error('Error cerrando lead: ' + leadErr.message);
            }
        } else if (pago.tipo === 'tienda') {
            // Compra en una tienda de Web Factory: marcar la orden como pagada,
            // descontar stock y notificar (in-app al dueño + email best-effort).
            if (pago.orden_id) {
                const { data: orden } = await supabase
                    .from('tienda_ordenes')
                    .select('*')
                    .eq('id', pago.orden_id)
                    .maybeSingle();

                if (orden) {
                    const { error: ordErr } = await supabase
                        .from('tienda_ordenes')
                        .update({ estado: 'pagada', estado_pago: 'pagado', transaction_id: transaction.id, updated_at: new Date().toISOString() })
                        .eq('id', orden.id);
                    if (ordErr) throw new Error('Error marcando orden pagada: ' + ordErr.message);

                    // Descontar stock (variación para productos variables; producto para simples)
                    const { data: lineas } = await supabase
                        .from('tienda_orden_items')
                        .select('producto_id, cantidad, variacion_id')
                        .eq('orden_id', orden.id);
                    for (const l of lineas || []) {
                        if (l.variacion_id) {
                            const { data: varRow } = await supabase
                                .from('tienda_variaciones')
                                .select('stock')
                                .eq('id', l.variacion_id)
                                .maybeSingle();
                            if (varRow && varRow.stock !== null) {
                                await supabase
                                    .from('tienda_variaciones')
                                    .update({ stock: Math.max(0, varRow.stock - l.cantidad) })
                                    .eq('id', l.variacion_id)
                                    .select();
                            }
                        } else if (l.producto_id) {
                            const { data: prod } = await supabase
                                .from('tienda_productos')
                                .select('tipo, stock')
                                .eq('id', l.producto_id)
                                .maybeSingle();
                            if (prod && (prod.tipo === 'simple' || prod.tipo === 'fisico') && prod.stock !== null) {
                                await supabase
                                    .from('tienda_productos')
                                    .update({ stock: Math.max(0, prod.stock - l.cantidad), updated_at: new Date().toISOString() })
                                    .eq('id', l.producto_id)
                                    .select();
                            }
                        }
                    }

                    // Actualizar cliente (pedidos y total)
                    if (orden.cliente_id) {
                        const { data: cli } = await supabase
                            .from('tienda_clientes')
                            .select('pedidos, total_cents')
                            .eq('id', orden.cliente_id)
                            .maybeSingle();
                        if (cli) {
                            await supabase
                                .from('tienda_clientes')
                                .update({
                                    pedidos: (cli.pedidos || 0) + 1,
                                    total_cents: (Number(cli.total_cents) || 0) + orden.total_cents,
                                    updated_at: new Date().toISOString()
                                })
                                .eq('id', orden.cliente_id)
                                .select();
                        }
                    }

                    // Notificaciones (best-effort: dependen de conexiones del dueño)
                    try {
                        const { data: proyecto } = await supabase
                            .from('web_projects')
                            .select('created_by, nombre')
                            .eq('id', orden.proyecto_id)
                            .maybeSingle();
                        if (proyecto?.created_by) {
                            const { registrarNotificacion, sendEmail } = require('./notifications');
                            await registrarNotificacion({
                                userId: proyecto.created_by,
                                eventType: 'tienda_venta',
                                channel: 'app',
                                recipient: proyecto.created_by,
                                subject: `Venta en ${proyecto.nombre}: ${Math.round(transaction.amount_in_cents / 100).toLocaleString('es-CO')} COP (ref ${transaction.id})`,
                                status: 'sent'
                            });
                            if (orden.cliente_email) {
                                sendEmail({
                                    userId: proyecto.created_by,
                                    to: orden.cliente_email,
                                    subject: `Confirmación de compra en ${proyecto.nombre}`,
                                    text: `¡Gracias por tu compra en ${proyecto.nombre}!\nReferencia: ${transaction.id}\nTotal: ${Math.round(transaction.amount_in_cents / 100).toLocaleString('es-CO')} COP\n\nTu pedido ya fue procesado.`
                                }).catch(err => console.error('tienda post-pago email err:', err.message));
                            }

                            // Aviso al dueño de la tienda: pago confirmado (correo/WhatsApp según config)
                            try {
                                const { data: cfg } = await supabase
                                    .from('tienda_pasarela')
                                    .select('*')
                                    .eq('proyecto_id', orden.proyecto_id)
                                    .maybeSingle();
                                if (cfg?.notify_on_payment) {
                                    const { notificarTienda } = require('./notifications');
                                    const montoStr = '$' + (Math.round(transaction.amount_in_cents) / 100).toLocaleString('es-CO');
                                    const detalle = (lineas || []).map(l => `• ${l.nombre} x${l.cantidad} — $${((l.precio_cents * l.cantidad) / 100).toLocaleString('es-CO')}`).join('\n');
                                    await notificarTienda({
                                        proyectoId: orden.proyecto_id,
                                        createdBy: proyecto.created_by,
                                        config: cfg,
                                        subject: `Pago confirmado en ${proyecto.nombre}: ${montoStr}`,
                                        text: `Pago confirmado ✅\nTienda: ${proyecto.nombre}\n\n${detalle || '—'}\n\nMonto: ${montoStr}\nReferencia: ${transaction.id}\nCliente: ${orden.cliente_nombre || ''}${orden.cliente_email ? ' · ' + orden.cliente_email : ''}`
                                    });
                                }
                            } catch (cfgErr) {
                                console.error('Error avisando pago de tienda:', cfgErr.message);
                            }
                        }
                    } catch (notifErr) {
                        console.error('Error notificando venta de tienda:', notifErr.message);
                    }
                }
            }
        }

        const { error: upError } = await supabase
            .from('pagos')
            .update({
                estado: 'aprobado',
                transaction_id: transaction.id,
                updated_at: new Date().toISOString()
            })
            .eq('id', pago.id);
        if (upError) throw new Error('Error actualizando pago: ' + upError.message);
        // Si es venta CRM, notificar y actualizar conversación
        try {
            if (pago.tipo === 'venta') {
                // traer lead con info adicional
                const { data: lead } = await supabase.from('crm_leads').select('id, user_id, nombre, email, telefono, conversacion_id, agente_id, external_user_id').eq('id', pago.lead_id).maybeSingle();
                if (lead) {
                    const { sendEmail, sendWhatsAppText } = require('./notifications');
                    // Notificar por email a destinatarios del agente si está configurado
                    const { data: cfg } = await supabase.from('crm_config_agente').select('*').eq('agente_id', lead.agente_id).maybeSingle();
                    const recipients = (cfg?.notify_on_payment && Array.isArray(cfg.notify_recipients) && cfg.notify_recipients.length) ? cfg.notify_recipients.slice() : [];
                    if (lead.email) recipients.push(lead.email);
                    const subject = `Pago recibido: ${pago.concepto} - ${Math.round(pago.monto_cents/100).toLocaleString('es-CO')} COP`;
                    const text = `Pago confirmado. Referencia: ${transaction.id}\nMonto: ${Math.round(transaction.amount_in_cents/100).toLocaleString('es-CO')} COP\nCliente: ${lead.nombre || ''}`;
                    for (const to of recipients.filter(Boolean)) {
                        sendEmail({ userId: lead.user_id, agenteId: lead.agente_id, leadId: lead.id, conversationId: lead.conversacion_id, eventType: 'post_pago', to, subject, text }).catch(err => console.error('post-pago email err:', err));
                    }

                    // Insertar mensaje en la conversación (assistant)
                    try {
                        if (lead.conversacion_id) {
                            await supabase.from('mensajes_conversacion').insert({ conversacion_id: lead.conversacion_id, agente_id: lead.agente_id, role: 'assistant', content: `Pago recibido ✅\nReferencia: ${transaction.id}\nMonto: ${Math.round(transaction.amount_in_cents/100).toLocaleString('es-CO')} COP`, origen: 'sistema', metadata: { pago_id: pago.id, transaction_id: transaction.id } });
                        }
                    } catch (mErr) { console.error('Error insertando msg conv:', mErr.message); }

                    // Enviar WhatsApp de confirmación al cliente si hay número
                    try {
                        const phone = lead.external_user_id || lead.telefono;
                        if (phone) {
                            await sendWhatsAppText({ agentId: lead.agente_id, toPhone: phone, text: `Pago recibido ✅\nReferencia: ${transaction.id}\nTotal: $${Math.round(transaction.amount_in_cents/100).toLocaleString('es-CO')} COP\nGracias por tu compra.` });
                        }
                    } catch (waErr) { console.error('Error sending wa post-pago:', waErr.message); }
                }
            }
        } catch (notifErr) {
            console.error('Error notifying post-pago:', notifErr.message);
        }

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, acreditado: true }) };
    } catch (err) {
        console.error('Error en pago-webhook:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Error interno' }) };
    }
};
