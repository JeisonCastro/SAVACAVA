const nodemailer = require('nodemailer');
// Use global fetch where available
const { supabase } = require('./supabase-admin');

async function sendEmail({ to, subject, text, html, agentConfig = null }) {
  // Prefer platform SMTP configured via ENV. Agent-level SMTP may be added later.
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass) {
    console.warn('SMTP not configured in env. Skipping email send to', to);
    return { ok: false, error: 'smtp_not_configured' };
  }

  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });

  try {
    const info = await transporter.sendMail({ from, to, subject, text, html });
    return { ok: true, info };
  } catch (err) {
    console.error('Error sending email:', err.message);
    return { ok: false, error: err.message };
  }
}

async function sendWhatsAppText({ agentId, toPhone, text }) {
  try {
    const { data: conn } = await supabase
      .from('whatsapp_connections')
      .select('*')
      .eq('agente_id', agentId)
      .eq('activo', true)
      .limit(1)
      .maybeSingle();

    if (!conn || !conn.access_token || !conn.phone_number_id) {
      console.warn('No whatsapp connection for agent', agentId);
      return { ok: false, error: 'no_whatsapp_connection' };
    }

    const res = await fetch(`https://graph.facebook.com/v19.0/${conn.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone.replace(/[^0-9]/g, ''), type: 'text', text: { body: text.slice(0, 4096) } })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body };
    return { ok: true, body };
  } catch (err) {
    console.error('Error sending WhatsApp:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail, sendWhatsAppText };
