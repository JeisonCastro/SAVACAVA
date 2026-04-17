(function() {
    // 1. Obtener el ID del agente desde el script tag
    const scriptTag = document.currentScript;
    const agenteId = scriptTag.getAttribute('data-id');

    // 2. Crear los estilos mínimos
    const style = document.createElement('style');
    style.innerHTML = `
        #jt-widget-container { position: fixed; bottom: 20px; right: 20px; z-index: 99999; font-family: sans-serif; }
        #jt-chat-button { width: 60px; height: 60px; background: #0ea5e9; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 15px rgba(0,0,0,0.3); border: none; color: white; font-size: 24px; }
        #jt-chat-window { display: none; width: 350px; height: 450px; background: #161e2a; border: 1px solid #1e2d40; border-radius: 15px; flex-direction: column; overflow: hidden; margin-bottom: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        .jt-header { background: #0d1117; padding: 15px; color: white; font-weight: bold; border-bottom: 1px solid #1e2d40; }
        .jt-messages { flex: 1; padding: 15px; overflow-y: auto; color: #e8f0f8; font-size: 14px; display: flex; flex-direction: column; gap: 8px; }
        .jt-input-area { padding: 10px; border-top: 1px solid #1e2d40; display: flex; gap: 5px; }
        .jt-input { flex: 1; background: #06090f; border: 1px solid #253648; color: white; padding: 8px; border-radius: 5px; outline: none; }
        .jt-send { background: #0ea5e9; border: none; color: white; padding: 8px 12px; border-radius: 5px; cursor: pointer; }
        .msg-user { align-self: flex-end; background: #0ea5e9; padding: 8px; border-radius: 8px; max-width: 80%; }
        .msg-bot { align-self: flex-start; background: #1e2d40; padding: 8px; border-radius: 8px; max-width: 80%; }
    `;
    document.head.appendChild(style);

    // 3. Crear estructura HTML
    const container = document.createElement('div');
    container.id = 'jt-widget-container';
    container.innerHTML = `
        <div id="jt-chat-window">
            <div class="jt-header">Asistente Virtual</div>
            <div id="jt-messages" class="jt-messages"></div>
            <div class="jt-input-area">
                <input type="text" id="jt-input" class="jt-input" placeholder="Escribe aquí...">
                <button id="jt-send" class="jt-send">></button>
            </div>
        </div>
        <button id="jt-chat-button">💬</button>
    `;
    document.body.appendChild(container);

    // 4. Lógica de Interacción
    const chatBtn = document.getElementById('jt-chat-button');
    const chatWindow = document.getElementById('jt-chat-window');
    const input = document.getElementById('jt-input');
    const sendBtn = document.getElementById('jt-send');
    const messages = document.getElementById('jt-messages');

    chatBtn.onclick = () => {
        chatWindow.style.display = chatWindow.style.display === 'flex' ? 'none' : 'flex';
    };

    async function sendMessage() {
        const text = input.value.trim();
        if(!text) return;

        appendMsg(text, 'user');
        input.value = '';

        try {
            // USAMOS TU MISMA FUNCIÓN DE NETLIFY
            const res = await fetch('https://TU-DOMINIO.netlify.app/.netlify/functions/chat', {
                method: 'POST',
                body: JSON.stringify({ prompt: text, agente_id: agenteId })
            });
            const data = await res.json();
            appendMsg(data.respuesta, 'bot');
        } catch (e) {
            appendMsg("Error de conexión.", 'bot');
        }
    }

    function appendMsg(txt, type) {
        const div = document.createElement('div');
        div.className = type === 'user' ? 'msg-user' : 'msg-bot';
        div.innerText = txt;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    }

    sendBtn.onclick = sendMessage;
    input.onkeypress = (e) => { if(e.key === 'Enter') sendMessage(); };
})();
