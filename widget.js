(() => {
  const script = document.currentScript || Array.from(document.scripts).find(s => s.src && s.src.includes('widget.js'));
  const agenteId = script?.getAttribute('data-id') || script?.dataset?.id;
  if (!agenteId) return console.error('[AUVRO Widget] Falta data-id.');

  const baseUrl = (() => {
    try { return new URL(script.src).origin; } catch (_) { return 'https://jeisondigital.netlify.app'; }
  })();

  const storageKey = `auvro_widget_session_${agenteId}`;
  let externalUserId = localStorage.getItem(storageKey);
  if (!externalUserId) {
    externalUserId = crypto?.randomUUID ? crypto.randomUUID() : 'w_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    localStorage.setItem(storageKey, externalUserId);
  }

  let sending = false;
  let pollTimer = null;
  let lastSignature = '';
  let localMessages = [];

  const css = `
    .auvro-widget-root{position:fixed;right:22px;bottom:22px;z-index:2147483000;font-family:Arial,sans-serif}
    .auvro-launcher{width:58px;height:58px;border-radius:50%;border:none;background:#0ea5e9;color:white;box-shadow:0 14px 35px rgba(14,165,233,.35);cursor:pointer;font-size:24px}
    .auvro-panel{width:360px;max-width:calc(100vw - 28px);height:520px;max-height:calc(100vh - 100px);border-radius:18px;overflow:hidden;box-shadow:0 22px 70px rgba(15,23,42,.25);background:#fff;border:1px solid #dbe7f0;display:none;flex-direction:column}
    .auvro-panel.open{display:flex}
    .auvro-header{background:#0f172a;color:white;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}
    .auvro-title{font-weight:800;font-size:14px}
    .auvro-status{font-size:11px;opacity:.72;margin-top:2px}
    .auvro-close{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);color:white;border-radius:10px;width:32px;height:32px;cursor:pointer}
    .auvro-messages{flex:1;padding:14px;background:#eef4f8;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
    .auvro-bubble{max-width:82%;width:max-content;padding:8px 10px;border-radius:12px;font-size:13px;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 2px rgba(15,23,42,.08)}
    .auvro-bubble.user{align-self:flex-end;background:#d9fdd3;border-bottom-right-radius:4px}
    .auvro-bubble.bot{align-self:flex-start;background:#fff;border-bottom-left-radius:4px}
    .auvro-bubble.system{align-self:center;background:#e0f2fe;color:#0369a1;font-size:12px;max-width:92%;text-align:center;box-shadow:none}
    .auvro-meta{font-size:10px;opacity:.55;margin-top:4px;text-align:right}
    .auvro-input-wrap{padding:10px;background:#fff;border-top:1px solid #e2e8f0;display:flex;gap:8px;align-items:flex-end}
    .auvro-input{flex:1;border:1px solid #cbd5e1;border-radius:14px;padding:10px 12px;min-height:40px;max-height:92px;resize:none;outline:none;font-size:13px}
    .auvro-send{width:42px;height:42px;border-radius:50%;border:none;background:#0ea5e9;color:white;cursor:pointer}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'auvro-widget-root';
  root.innerHTML = `
    <div class="auvro-panel">
      <div class="auvro-header">
        <div><div class="auvro-title">Asistente IA</div><div class="auvro-status">En línea</div></div>
        <button class="auvro-close">×</button>
      </div>
      <div class="auvro-messages"></div>
      <div class="auvro-input-wrap">
        <textarea class="auvro-input" rows="1" placeholder="Escribe un mensaje..."></textarea>
        <button class="auvro-send">➤</button>
      </div>
    </div>
    <button class="auvro-launcher">💬</button>
  `;
  document.body.appendChild(root);

  const panel = root.querySelector('.auvro-panel');
  const launcher = root.querySelector('.auvro-launcher');
  const closeBtn = root.querySelector('.auvro-close');
  const messagesEl = root.querySelector('.auvro-messages');
  const input = root.querySelector('.auvro-input');
  const sendBtn = root.querySelector('.auvro-send');
  const statusEl = root.querySelector('.auvro-status');

  function hora(value) {
    try { return new Date(value || Date.now()).toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit' }); } catch (_) { return ''; }
  }

  function render(messages) {
    messagesEl.innerHTML = '';
    if (!messages.length) {
      const w = document.createElement('div');
      w.className = 'auvro-bubble system';
      w.textContent = 'Hola 👋 ¿En qué puedo ayudarte?';
      messagesEl.appendChild(w);
    }
    for (const m of messages) {
      const div = document.createElement('div');
      div.className = `auvro-bubble ${m.role}`;
      div.textContent = m.role === 'bot' && m.origen === 'humano' ? 'Asesor: ' + m.text : m.text;
      if (m.role !== 'system') {
        const meta = document.createElement('div');
        meta.className = 'auvro-meta';
        meta.textContent = hora(m.time);
        div.appendChild(meta);
      }
      messagesEl.appendChild(div);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function cargarMensajes() {
    try {
      const res = await fetch(`${baseUrl}/.netlify/functions/web-chat-messages`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ agente_id: agenteId, external_user_id: externalUserId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return console.warn('[AUVRO Widget] web-chat-messages:', data.error || res.status);

      const serverMessages = (data.messages || []).map(m => ({
        id: String(m.id),
        role: m.role === 'user' ? 'user' : 'bot',
        text: String(m.content || ''),
        time: m.created_at,
        origen: m.origen || m.metadata?.origen || (m.role === 'user' ? 'cliente' : 'ia')
      }));

      const signature = serverMessages.map(m => m.id).join('|');
      if (signature && signature !== lastSignature) {
        lastSignature = signature;
        localMessages = serverMessages;
        render(localMessages);
      }

      statusEl.textContent = data.conversation?.modo_humano || data.conversation?.estado === 'modo_humano'
        ? 'Asesor humano activo'
        : 'En línea';
    } catch (e) {
      console.warn('[AUVRO Widget] No se pudo cargar mensajes:', e);
    }
  }

  function iniciarPolling() {
    if (pollTimer) return;
    cargarMensajes();
    pollTimer = setInterval(cargarMensajes, 2500);
  }

  async function enviar() {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    input.value = '';

    localMessages.push({ id:'local_' + Date.now(), role:'user', text, time:new Date().toISOString(), origen:'cliente' });
    render(localMessages);

    try {
      const res = await fetch(`${baseUrl}/.netlify/functions/chat`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ prompt: text, agente_id: agenteId, canal: 'web', external_user_id: externalUserId })
      });
      const data = await res.json().catch(() => ({}));

      if (data.skipped === true || data.respuesta === null) {
        localMessages.push({ id:'system_' + Date.now(), role:'system', text:'Tu mensaje fue recibido. Un asesor humano continuará la conversación.', time:new Date().toISOString() });
        render(localMessages);
        await cargarMensajes();
        return;
      }

      if (data.respuesta) {
        localMessages.push({ id:'bot_' + Date.now(), role:'bot', text:String(data.respuesta), time:new Date().toISOString(), origen:'ia' });
        render(localMessages);
        await cargarMensajes();
        return;
      }

      if (data.error) {
        localMessages.push({ id:'error_' + Date.now(), role:'system', text:String(data.error), time:new Date().toISOString() });
        render(localMessages);
        return;
      }

      localMessages.push({ id:'ok_' + Date.now(), role:'system', text:'Tu mensaje fue recibido.', time:new Date().toISOString() });
      render(localMessages);
      await cargarMensajes();
    } catch (e) {
      localMessages.push({ id:'error_' + Date.now(), role:'system', text:'No pude enviar el mensaje. Intenta de nuevo.', time:new Date().toISOString() });
      render(localMessages);
    } finally {
      sending = false;
      sendBtn.disabled = false;
      iniciarPolling();
    }
  }

  launcher.onclick = () => { panel.classList.add('open'); launcher.style.display = 'none'; iniciarPolling(); };
  closeBtn.onclick = () => { panel.classList.remove('open'); launcher.style.display = 'block'; };
  sendBtn.onclick = enviar;
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } });
  render(localMessages);
})();
