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
      return 'https://auvro.netlify.app';
    }
  })();

  const DEFAULTS = {
    primary: '#2563eb',
    bgPanel: '#ffffff',
    bgHeader: '#0f172a',
    bgInput: '#f1f5f9',
    bgInputWrap: '#ffffff',
    colorText: '#0f172a',
    colorTextSecondary: '#64748b',
    bubbleUserBg: '#2563eb',
    bubbleBotBg: '#f1f5f9',
    bubbleHumanBg: '#ecfdf5',
    font: 'Inter, Arial, sans-serif',
    borderRadius: '14px',
    name: 'Asistente IA',
    greeting: 'Hola 👋 ¿En qué puedo ayudarte?',
    position: 'right',
    autoOpen: 0
  };

  function loadConfig() {
    let config = {};
    try {
      if (window.AUVRO_CONFIG && typeof window.AUVRO_CONFIG === 'object') {
        config = { ...window.AUVRO_CONFIG };
      }
    } catch (_) {}
    try {
      const raw = script?.getAttribute('data-theme');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          config = { ...config, ...parsed };
        }
      }
    } catch (_) {}
    try {
      const nombre = script?.getAttribute('data-name');
      if (nombre) config.name = nombre;
      const saludo = script?.getAttribute('data-greeting');
      if (saludo) config.greeting = saludo;
      const pos = script?.getAttribute('data-position');
      if (pos) config.position = pos;
      const auto = script?.getAttribute('data-autopen');
      if (auto !== null && auto !== undefined && auto !== '') config.autoOpen = parseInt(auto, 10) || 0;
    } catch (_) {}
    return { ...DEFAULTS, ...config };
  }

  function applyTheme(cfg) {
    const vars = {
      '--auvro-primary': cfg.primary,
      '--auvro-bg-panel': cfg.bgPanel,
      '--auvro-bg-header': cfg.bgHeader,
      '--auvro-bg-input': cfg.bgInput,
      '--auvro-bg-input-wrap': cfg.bgInputWrap,
      '--auvro-color-text': cfg.colorText,
      '--auvro-color-text-secondary': cfg.colorTextSecondary,
      '--auvro-bubble-user-bg': cfg.bubbleUserBg,
      '--auvro-bubble-bot-bg': cfg.bubbleBotBg,
      '--auvro-bubble-human-bg': cfg.bubbleHumanBg,
      '--auvro-font': cfg.font,
      '--auvro-border-radius': cfg.borderRadius
    };
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) {
      root.style.setProperty(k, v);
    }
  }

  const themeConfig = loadConfig();
  applyTheme(themeConfig);

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
  let lastErrorKey = '';
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
      font-family:var(--auvro-font);
      color:var(--auvro-color-text);
    }

    .auvro-launcher{
      width:60px;
      height:60px;
      border-radius:50%;
      border:1px solid color-mix(in srgb, var(--auvro-primary) 42%, transparent);
      background:var(--auvro-primary);
      color:white;
      box-shadow:0 8px 24px color-mix(in srgb, var(--auvro-primary) 26%, transparent);
      cursor:pointer;
      font-size:25px;
      display:flex;
      align-items:center;
      justify-content:center;
      transition:transform .18s ease, box-shadow .18s ease;
    }

    .auvro-launcher:hover{
      transform:translateY(-2px) scale(1.03);
      box-shadow:0 12px 32px color-mix(in srgb, var(--auvro-primary) 32%, transparent);
    }

    .auvro-panel{
      width:380px;
      max-width:calc(100vw - 28px);
      height:560px;
      max-height:calc(100vh - 98px);
      border-radius:var(--auvro-border-radius);
      overflow:hidden;
      box-shadow:0 20px 60px rgba(15,23,42,.18);
      background:var(--auvro-bg-panel);
      border:1px solid color-mix(in srgb, var(--auvro-primary) 14%, transparent);
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
      background:var(--auvro-bg-header);
      color:white;
      padding:14px 15px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      border-bottom:1px solid color-mix(in srgb, var(--auvro-primary) 18%, transparent);
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
      background:color-mix(in srgb, var(--auvro-primary) 12%, transparent);
      border:1px solid color-mix(in srgb, var(--auvro-primary) 42%, transparent);
      display:flex;
      align-items:center;
      justify-content:center;
      color:var(--auvro-primary);
      flex:0 0 auto;
      box-shadow:0 0 0 4px color-mix(in srgb, var(--auvro-primary) 8%, transparent);
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
      color:rgba(255,255,255,.78);
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
      background:var(--auvro-bg-panel);
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
      color:var(--auvro-color-text-secondary);
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
      box-shadow:0 1px 3px rgba(16,24,40,.08);
      position:relative;
    }

    .auvro-bubble.user{
      align-self:flex-end;
      background:var(--auvro-bubble-user-bg);
      border:1px solid color-mix(in srgb, var(--auvro-bubble-user-bg) 60%, white);
      color:#ffffff;
      border-bottom-right-radius:4px;
    }

    .auvro-bubble.bot{
      align-self:flex-start;
      background:var(--auvro-bubble-bot-bg);
      border:1px solid rgba(148,163,184,.18);
      color:var(--auvro-color-text);
      border-bottom-left-radius:4px;
    }

    .auvro-bubble.human{
      align-self:flex-start;
      background:var(--auvro-bubble-human-bg);
      border:1px solid color-mix(in srgb, var(--auvro-bubble-human-bg) 65%, #059669);
      color:#0f172a;
      border-bottom-left-radius:4px;
    }

    .auvro-bubble.system{
      align-self:center;
      background:color-mix(in srgb, var(--auvro-primary) 10%, transparent);
      border:1px solid color-mix(in srgb, var(--auvro-primary) 22%, transparent);
      color:color-mix(in srgb, var(--auvro-primary) 60%, white);
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
      color:#64748b;
      opacity:.86;
      margin-bottom:3px;
    }

    .auvro-bubble.user .auvro-label{
      color:rgba(255,255,255,.9);
    }

    .auvro-bubble.human .auvro-label{
      color:#059669;
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
      background:var(--auvro-bubble-bot-bg);
      border:1px solid rgba(148,163,184,.18);
      color:var(--auvro-color-text-secondary);
      border-radius:11px;
      border-bottom-left-radius:4px;
      padding:8px 10px;
      display:flex;
      align-items:center;
      gap:5px;
      width:max-content;
      box-shadow:0 1px 3px rgba(16,24,40,.08);
    }

    .auvro-typing span{
      width:6px;
      height:6px;
      border-radius:50%;
      background:var(--auvro-primary);
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
      background:var(--auvro-bg-input-wrap);
      border-top:1px solid color-mix(in srgb, var(--auvro-primary) 18%, transparent);
      display:flex;
      gap:8px;
      align-items:flex-end;
    }

    .auvro-input{
      flex:1;
      border:1px solid #cbd5e1;
      background:var(--auvro-bg-input);
      color:var(--auvro-color-text);
      border-radius:10px;
      padding:11px 12px;
      min-height:42px;
      max-height:96px;
      resize:none;
      outline:none;
      font:13px var(--auvro-font);
      line-height:1.35;
      scrollbar-width:thin;
    }

    .auvro-input::placeholder{
      color:#64748b;
    }

    .auvro-input:focus{
      border-color:var(--auvro-primary);
      box-shadow:0 0 0 3px color-mix(in srgb, var(--auvro-primary) 10%, transparent);
    }

    .auvro-send{
      width:43px;
      height:43px;
      border-radius:50%;
      border:none;
      background:var(--auvro-primary);
      color:white;
      cursor:pointer;
      font-size:16px;
      display:flex;
      align-items:center;
      justify-content:center;
      flex:0 0 auto;
      transition:all .16s ease;
      box-shadow:0 6px 18px color-mix(in srgb, var(--auvro-primary) 22%, transparent);
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
      background:var(--auvro-bg-input-wrap);
    }

    .auvro-attach-btn{
      width:36px;
      height:36px;
      border-radius:50%;
      border:none;
      background:transparent;
      color:var(--auvro-color-text-secondary);
      cursor:pointer;
      font-size:15px;
      display:flex;
      align-items:center;
      justify-content:center;
      flex:0 0 auto;
      transition:all .16s ease;
    }

    .auvro-attach-btn:hover{
      color:var(--auvro-primary);
      transform:scale(1.1);
    }

    .auvro-image-preview{
      padding:6px 10px;
      background:var(--auvro-bg-input-wrap);
      border-top:1px solid rgba(148,163,184,.12);
      display:none;
      align-items:center;
      gap:8px;
    }

    .auvro-image-preview.visible{
      display:flex;
    }

    .auvro-image-preview img{
      width:48px;
      height:48px;
      object-fit:cover;
      border-radius:8px;
      border:1px solid rgba(148,163,184,.2);
    }

    .auvro-image-preview .auvro-image-name{
      flex:1;
      font-size:11px;
      color:var(--auvro-color-text-secondary);
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }

    .auvro-image-preview .auvro-image-remove{
      background:none;
      border:none;
      color:var(--auvro-color-text-secondary);
      cursor:pointer;
      font-size:14px;
      padding:2px;
      transition:color .16s;
    }

    .auvro-image-preview .auvro-image-remove:hover{
      color:#f87171;
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
            <div class="auvro-title">${themeConfig.name}</div>
            <div class="auvro-status"><span class="auvro-status-dot"></span><span class="auvro-status-text">En línea</span></div>
          </div>
        </div>
        <button class="auvro-close" type="button" aria-label="Cerrar">×</button>
      </div>
      <div class="auvro-messages"></div>
      <div class="auvro-image-preview" id="auvro-image-preview">
        <img id="auvro-image-thumb" src="" alt="Preview">
        <span class="auvro-image-name" id="auvro-image-name"></span>
        <button class="auvro-image-remove" id="auvro-image-remove" type="button" aria-label="Quitar imagen">×</button>
      </div>
      <div class="auvro-input-wrap">
        <input type="file" id="auvro-file-input" accept="image/*" style="display:none">
        <button class="auvro-attach-btn" type="button" aria-label="Adjuntar imagen" id="auvro-attach-btn">📎</button>
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
  const fileInput = root.querySelector('#auvro-file-input');
  const attachBtn = root.querySelector('#auvro-attach-btn');
  const imagePreview = root.querySelector('#auvro-image-preview');
  const imageThumb = root.querySelector('#auvro-image-thumb');
  const imageName = root.querySelector('#auvro-image-name');
  const imageRemove = root.querySelector('#auvro-image-remove');

  let pendingImage = null;

  attachBtn.onclick = () => fileInput.click();

  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      fileInput.value = '';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      fileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingImage = { dataUrl: reader.result, name: file.name };
      imageThumb.src = reader.result;
      imageName.textContent = file.name;
      imagePreview.classList.add('visible');
    };
    reader.readAsDataURL(file);
  };

  imageRemove.onclick = () => {
    pendingImage = null;
    fileInput.value = '';
    imagePreview.classList.remove('visible');
  };

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
    } else {
      detenerPolling();
    }
  }

  function setStatus(text, human = false) {
    statusText.textContent = text;
    statusDot.style.background = human ? '#22d3a5' : '#38bdf8';
    statusDot.style.boxShadow = human
      ? '0 0 0 3px rgba(34,211,165,.12)'
      : '0 0 0 3px rgba(56,189,248,.12)';
  }

  function agregarBurbuja(tipo, texto) {
    const div = document.createElement('div');
    div.className = `auvro-bubble ${tipo}`;
    const text = document.createElement('span');
    text.className = 'auvro-text';
    text.textContent = texto;
    div.appendChild(text);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
      w.textContent = themeConfig.greeting;
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

      if (m.image) {
        const imgBadge = document.createElement('span');
        imgBadge.textContent = ' 📷';
        imgBadge.style.fontSize = '11px';
        div.appendChild(imgBadge);
      }

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
        const msg = data.error || (data.respuesta || `Error del servidor (${res.status})`);
        if (msg !== lastErrorKey) {
          lastErrorKey = msg;
          agregarBurbuja('system', msg);
        }
        setStatus('Sin conexión');
        return;
      }

      lastErrorKey = '';

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

  function detenerPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function enviar() {
    const text = input.value.trim();
    const hasImage = !!pendingImage;
    if ((!text && !hasImage) || sending) return;

    sending = true;
    sendBtn.disabled = true;

    const displayText = text || (hasImage ? '📷 Imagen' : '');
    const imageToSend = pendingImage?.dataUrl || null;

    pendingImage = null;
    fileInput.value = '';
    imagePreview.classList.remove('visible');

    input.value = '';
    autoResizeInput();

    localMessages.push({
      id: 'local_' + Date.now(),
      role: 'user',
      text: displayText,
      time: new Date().toISOString(),
      origen: 'cliente',
      ...(hasImage ? { image: true } : {})
    });

    render(localMessages);
    addTyping();

    try {
      const payload = {
        prompt: text || 'Describe esta imagen',
        agente_id: agenteId,
        canal: 'web',
        external_user_id: externalUserId
      };
      if (imageToSend) payload.image_url = imageToSend;

      const res = await fetch(`${baseUrl}/.netlify/functions/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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

      if (res.ok && data.respuesta) {
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

      // Errores HTTP: 400/403/404/500 de chat.js vienen con { respuesta } o { error }.
      if (!res.ok) {
        const mensaje = data.respuesta || data.error || `Error del servidor (${res.status})`;
        localMessages.push({
          id: 'error_' + Date.now(),
          role: 'system',
          text: String(mensaje),
          time: new Date().toISOString()
        });
        render(localMessages);
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

  if (themeConfig.position === 'left') {
    root.style.right = 'auto';
    root.style.left = '22px';
  }

  if (themeConfig.autoOpen > 0) {
    setTimeout(() => {
      if (!isOpen) setOpen(true);
    }, themeConfig.autoOpen);
  }

  render(localMessages);
})();
