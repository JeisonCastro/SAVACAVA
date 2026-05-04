(() => {
  const script = document.currentScript || Array.from(document.scripts).find(s => s.src && s.src.includes('widget.js'));
  const agenteId = script?.getAttribute('data-id') || script?.dataset?.id;

  if (!agenteId) {
    console.error('[AUVRO Widget] Falta data-id.');
    return;
  }

  const baseUrl = (() => {
    try {
      return new URL(script.src).origin;
    } catch (_) {
      return 'https://jeisondigital.netlify.app';
    }
  })();

  const storageKey = `auvro_widget_session_${agenteId}`;
  const openKey = `auvro_widget_open_${agenteId}`;

  let externalUserId = localStorage.getItem(storageKey);
  if (!externalUserId) {
    externalUserId = crypto?.randomUUID
      ? crypto.randomUUID()
      : 'w_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    localStorage.setItem(storageKey, externalUserId);
  }

  let sending = false;
  let pollTimer = null;
  let lastSignature = '';
  let localMessages = [];
  let isOpen = localStorage.getItem(openKey) === '1';

  const css = `
    .auvro-widget-root,
    .auvro-widget-root *{
      box-sizing:border-box;
    }

    .auvro-widget-root{
      position:fixed;
      right:22px;
      bottom:22px;
      z-index:2147483000;
      font-family:Inter,Arial,sans-serif;
      color:#e5edf7;
    }

    .auvro-launcher{
      width:60px;
      height:60px;
      border-radius:50%;
      border:1px solid rgba(14,165,233,.42);
      background:linear-gradient(135deg,#0ea5e9,#22d3ee);
      color:white;
      box-shadow:0 18px 50px rgba(14,165,233,.36);
      cursor:pointer;
      font-size:25px;
      display:flex;
      align-items:center;
      justify-content:center;
      transition:transform .18s ease, box-shadow .18s ease;
    }

    .auvro-launcher:hover{
      transform:translateY(-2px) scale(1.03);
      box-shadow:0 22px 60px rgba(14,165,233,.44);
    }

    .auvro-panel{
      width:380px;
      max-width:calc(100vw - 28px);
      height:560px;
      max-height:calc(100vh - 98px);
      border-radius:20px;
      overflow:hidden;
      box-shadow:0 28px 85px rgba(0,0,0,.46);
      background:#07111d;
      border:1px solid rgba(56,189,248,.22);
      display:none;
      flex-direction:column;
      backdrop-filter:blur(14px);
    }

    .auvro-panel.open{
      display:flex;
      animation:auvroPop .18s ease-out;
    }

    @keyframes auvroPop{
      from{opacity:.4;transform:translateY(12px) scale(.98)}
      to{opacity:1;transform:translateY(0) scale(1)}
    }

    .auvro-header{
      background:linear-gradient(135deg,#0f172a,#111827 72%,#082f49);
      color:white;
      padding:14px 15px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      border-bottom:1px solid rgba(56,189,248,.18);
    }

    .auvro-header-left{
      display:flex;
      align-items:center;
      gap:10px;
      min-width:0;
    }

    .auvro-avatar{
      width:38px;
      height:38px;
      border-radius:50%;
      background:rgba(14,165,233,.12);
      border:1px solid rgba(14,165,233,.42);
      display:flex;
      align-items:center;
      justify-content:center;
      color:#38bdf8;
      flex:0 0 auto;
      box-shadow:0 0 0 4px rgba(14,165,233,.08);
    }

    .auvro-title{
      font-weight:800;
      font-size:14px;
      line-height:1.15;
      letter-spacing:.01em;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      max-width:210px;
    }

    .auvro-status{
      font-size:11px;
      color:#8fb8d9;
      margin-top:3px;
      display:flex;
      align-items:center;
      gap:5px;
    }

    .auvro-status-dot{
      width:7px;
      height:7px;
      border-radius:50%;
      background:#22d3a5;
      box-shadow:0 0 0 3px rgba(34,211,165,.12);
      flex:0 0 auto;
    }

    .auvro-close{
      background:rgba(255,255,255,.08);
      border:1px solid rgba(255,255,255,.16);
      color:white;
      border-radius:12px;
      width:34px;
      height:34px;
      cursor:pointer;
      font-size:16px;
      transition:all .16s ease;
    }

    .auvro-close:hover{
      background:rgba(255,255,255,.14);
      transform:rotate(90deg);
    }

    .auvro-messages{
      flex:1;
      padding:14px;
      background:
        radial-gradient(circle at 14px 14px, rgba(148,163,184,.08) 1.4px, transparent 1.4px),
        linear-gradient(180deg,#08131f,#0b1623);
      background-size:28px 28px, auto;
      overflow-y:auto;
      overflow-x:hidden;
      display:flex;
      flex-direction:column;
      gap:7px;
      scroll-behavior:smooth;
    }

    .auvro-messages::-webkit-scrollbar{
      width:7px;
    }

    .auvro-messages::-webkit-scrollbar-thumb{
      background:#1e3a52;
      border-radius:99px;
    }

    .auvro-date-chip{
      align-self:center;
      font-size:10px;
      color:#8fb8d9;
      background:rgba(15,23,42,.82);
      border:1px solid rgba(148,163,184,.16);
      padding:4px 9px;
      border-radius:999px;
      margin:4px 0;
    }

    .auvro-bubble{
      max-width:82%;
      width:max-content;
      min-width:42px;
      padding:7px 9px 5px;
      border-radius:11px;
      font-size:13px;
      line-height:1.35;
      white-space:pre-wrap;
      overflow-wrap:anywhere;
      box-shadow:0 2px 10px rgba(0,0,0,.17);
      position:relative;
    }

    .auvro-bubble.user{
      align-self:flex-end;
      background:#0f766e;
      border:1px solid rgba(45,212,191,.28);
      color:#ecfeff;
      border-bottom-right-radius:4px;
    }

    .auvro-bubble.bot{
      align-self:flex-start;
      background:#111827;
      border:1px solid rgba(148,163,184,.18);
      color:#e5edf7;
      border-bottom-left-radius:4px;
    }

    .auvro-bubble.human{
      align-self:flex-start;
      background:#083f3a;
      border:1px solid rgba(34,211,165,.32);
      color:#eafff8;
      border-bottom-left-radius:4px;
    }

    .auvro-bubble.system{
      align-self:center;
      background:rgba(14,165,233,.10);
      border:1px solid rgba(14,165,233,.22);
      color:#93d9ff;
      font-size:12px;
      max-width:92%;
      text-align:center;
      box-shadow:none;
      border-radius:12px;
      padding:7px 10px;
    }

    .auvro-label{
      display:block;
      font-size:10px;
      font-weight:700;
      color:#93c5fd;
      opacity:.86;
      margin-bottom:3px;
    }

    .auvro-bubble.user .auvro-label{
      color:#ccfbf1;
    }

    .auvro-bubble.human .auvro-label{
      color:#86efac;
    }

    .auvro-text{
      display:block;
      color:inherit;
    }

    .auvro-meta{
      font-size:9px;
      opacity:.58;
      margin-top:3px;
      text-align:right;
      line-height:1;
    }

    .auvro-typing{
      align-self:flex-start;
      background:#111827;
      border:1px solid rgba(148,163,184,.18);
      color:#8fb8d9;
      border-radius:11px;
      border-bottom-left-radius:4px;
      padding:8px 10px;
      display:flex;
      align-items:center;
      gap:5px;
      width:max-content;
      box-shadow:0 2px 10px rgba(0,0,0,.17);
    }

    .auvro-typing span{
      width:6px;
      height:6px;
      border-radius:50%;
      background:#38bdf8;
      opacity:.35;
      animation:auvroTyping 1s infinite;
    }

    .auvro-typing span:nth-child(2){animation-delay:.15s}
    .auvro-typing span:nth-child(3){animation-delay:.3s}

    @keyframes auvroTyping{
      0%,100%{transform:translateY(0);opacity:.3}
      50%{transform:translateY(-4px);opacity:1}
    }

    .auvro-input-wrap{
      padding:10px;
      background:#0f172a;
      border-top:1px solid rgba(56,189,248,.18);
      display:flex;
      gap:8px;
      align-items:flex-end;
    }

    .auvro-input{
      flex:1;
      border:1px solid rgba(148,163,184,.24);
      background:#020617;
      color:#e5edf7;
      border-radius:15px;
      padding:11px 12px;
      min-height:42px;
      max-height:96px;
      resize:none;
      outline:none;
      font:13px Inter,Arial,sans-serif;
      line-height:1.35;
      scrollbar-width:thin;
    }

    .auvro-input::placeholder{
      color:#64748b;
    }

    .auvro-input:focus{
      border-color:#38bdf8;
      box-shadow:0 0 0 3px rgba(14,165,233,.10);
    }

    .auvro-send{
      width:43px;
      height:43px;
      border-radius:50%;
      border:none;
      background:linear-gradient(135deg,#0ea5e9,#22d3ee);
      color:white;
      cursor:pointer;
      font-size:16px;
      display:flex;
      align-items:center;
      justify-content:center;
      flex:0 0 auto;
      transition:all .16s ease;
      box-shadow:0 10px 28px rgba(14,165,233,.25);
    }

    .auvro-send:hover{
      transform:translateY(-1px);
    }

    .auvro-send:disabled{
      opacity:.55;
      cursor:not-allowed;
      transform:none;
    }

    .auvro-footer-note{
      font-size:10px;
      color:#64748b;
      text-align:center;
      padding:0 10px 8px;
      background:#0f172a;
    }

    @media(max-width:480px){
      .auvro-widget-root{
        right:10px;
        bottom:10px;
      }

      .auvro-panel{
        width:calc(100vw - 20px);
        height:calc(100vh - 84px);
        max-height:calc(100vh - 84px);
        border-radius:18px;
      }

      .auvro-launcher{
        width:56px;
        height:56px;
      }
    }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'auvro-widget-root';
  root.innerHTML = `
    <div class="auvro-panel ${isOpen ? 'open' : ''}">
      <div class="auvro-header">
        <div class="auvro-header-left">
          <div class="auvro-avatar">🤖</div>
          <div style="min-width:0">
            <div class="auvro-title">Asistente IA</div>
            <div class="auvro-status"><span class="auvro-status-dot"></span><span class="auvro-status-text">En línea</span></div>
          </div>
        </div>
        <button class="auvro-close" type="button" aria-label="Cerrar">×</button>
      </div>
      <div class="auvro-messages"></div>
      <div class="auvro-input-wrap">
        <textarea class="auvro-input" rows="1" placeholder="Escribe un mensaje..."></textarea>
        <button class="auvro-send" type="button" aria-label="Enviar">➤</button>
      </div>
      <div class="auvro-footer-note">AUVRO · asistente con IA</div>
    </div>
    <button class="auvro-launcher" type="button" aria-label="Abrir chat">💬</button>
  `;

  document.body.appendChild(root);

  const panel = root.querySelector('.auvro-panel');
  const launcher = root.querySelector('.auvro-launcher');
  const closeBtn = root.querySelector('.auvro-close');
  const messagesEl = root.querySelector('.auvro-messages');
  const input = root.querySelector('.auvro-input');
  const sendBtn = root.querySelector('.auvro-send');
  const statusText = root.querySelector('.auvro-status-text');
  const statusDot = root.querySelector('.auvro-status-dot');

  function hora(value) {
    try {
      return new Date(value || Date.now()).toLocaleTimeString('es-CO', {
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_) {
      return '';
    }
  }

  function dia(value) {
    try {
      return new Date(value || Date.now()).toLocaleDateString('es-CO', {
        day: '2-digit',
        month: 'short'
      });
    } catch (_) {
      return '';
    }
  }

  function setOpen(value) {
    isOpen = value;
    localStorage.setItem(openKey, value ? '1' : '0');
    panel.classList.toggle('open', value);
    launcher.style.display = value ? 'none' : 'flex';

    if (value) {
      iniciarPolling();
      setTimeout(() => input.focus(), 120);
    }
  }

  function setStatus(text, human = false) {
    statusText.textContent = text;
    statusDot.style.background = human ? '#22d3a5' : '#38bdf8';
    statusDot.style.boxShadow = human
      ? '0 0 0 3px rgba(34,211,165,.12)'
      : '0 0 0 3px rgba(56,189,248,.12)';
  }

  function autoResizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
  }

  function normalizarServerMessage(m) {
    const origen = m.origen || m.metadata?.origen || (m.role === 'user' ? 'cliente' : 'ia');
    let role = 'bot';

    if (m.role === 'user') role = 'user';
    else if (origen === 'humano') role = 'human';
    else role = 'bot';

    return {
      id: String(m.id),
      role,
      text: String(m.content || ''),
      time: m.created_at,
      origen
    };
  }

  function addTyping() {
    removeTyping();
    const typing = document.createElement('div');
    typing.className = 'auvro-typing';
    typing.id = 'auvro-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(typing);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeTyping() {
    const t = root.querySelector('#auvro-typing');
    if (t) t.remove();
  }

  function render(messages) {
    messagesEl.innerHTML = '';

    if (!messages.length) {
      const w = document.createElement('div');
      w.className = 'auvro-bubble system';
      w.textContent = 'Hola 👋 ¿En qué puedo ayudarte?';
      messagesEl.appendChild(w);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    let ultimoDia = '';

    for (const m of messages) {
      const d = dia(m.time);
      if (d && d !== ultimoDia) {
        ultimoDia = d;
        const chip = document.createElement('div');
        chip.className = 'auvro-date-chip';
        chip.textContent = d;
        messagesEl.appendChild(chip);
      }

      const div = document.createElement('div');
      div.className = `auvro-bubble ${m.role}`;

      const label = document.createElement('span');
      label.className = 'auvro-label';

      if (m.role === 'user') label.textContent = 'Tú';
      else if (m.role === 'human') label.textContent = 'Asesor';
      else if (m.role === 'system') label.textContent = '';
      else label.textContent = 'IA';

      if (label.textContent) div.appendChild(label);

      const text = document.createElement('span');
      text.className = 'auvro-text';
      text.textContent = m.text;
      div.appendChild(text);

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agente_id: agenteId, external_user_id: externalUserId })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) {
        console.warn('[AUVRO Widget] web-chat-messages:', data.error || res.status);
        return;
      }

      const serverMessages = (data.messages || []).map(normalizarServerMessage);
      const signature = serverMessages.map(m => m.id).join('|');

      if (signature && signature !== lastSignature) {
        lastSignature = signature;
        localMessages = serverMessages;
        render(localMessages);
      }

      const humanoActivo = data.conversation?.modo_humano || data.conversation?.estado === 'modo_humano';
      setStatus(humanoActivo ? 'Asesor humano activo' : 'En línea', humanoActivo);

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
    autoResizeInput();

    localMessages.push({
      id: 'local_' + Date.now(),
      role: 'user',
      text,
      time: new Date().toISOString(),
      origen: 'cliente'
    });

    render(localMessages);
    addTyping();

    try {
      const res = await fetch(`${baseUrl}/.netlify/functions/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          agente_id: agenteId,
          canal: 'web',
          external_user_id: externalUserId
        })
      });

      const data = await res.json().catch(() => ({}));
      removeTyping();

      if (data.skipped === true || data.modo_humano === true) {
        localMessages.push({
          id: 'system_' + Date.now(),
          role: 'system',
          text: data.respuesta || 'Tu mensaje fue recibido. Un asesor humano continuará la conversación.',
          time: new Date().toISOString()
        });
        render(localMessages);
        await cargarMensajes();
        return;
      }

      if (data.respuesta) {
        localMessages.push({
          id: 'bot_' + Date.now(),
          role: 'bot',
          text: String(data.respuesta),
          time: new Date().toISOString(),
          origen: 'ia'
        });
        render(localMessages);
        await cargarMensajes();
        return;
      }

      if (data.error) {
        localMessages.push({
          id: 'error_' + Date.now(),
          role: 'system',
          text: String(data.error),
          time: new Date().toISOString()
        });
        render(localMessages);
        return;
      }

      localMessages.push({
        id: 'ok_' + Date.now(),
        role: 'system',
        text: 'Tu mensaje fue recibido.',
        time: new Date().toISOString()
      });
      render(localMessages);
      await cargarMensajes();

    } catch (e) {
      removeTyping();
      localMessages.push({
        id: 'error_' + Date.now(),
        role: 'system',
        text: 'No pude enviar el mensaje. Intenta de nuevo.',
        time: new Date().toISOString()
      });
      render(localMessages);
    } finally {
      sending = false;
      sendBtn.disabled = false;
      iniciarPolling();
    }
  }

  launcher.onclick = () => setOpen(true);
  closeBtn.onclick = () => setOpen(false);
  sendBtn.onclick = enviar;

  input.addEventListener('input', autoResizeInput);

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  });

  launcher.style.display = isOpen ? 'none' : 'flex';
  if (isOpen) iniciarPolling();

  render(localMessages);
})();
