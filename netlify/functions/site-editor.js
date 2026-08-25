// site-editor.js — Editor AI conversacional de contenido web
// Flujo: analyze (propuesta) → execute (aplicar) → undo (revertir)
// Lee /docs del repositorio para contexto del proyecto.
// Usa perfiles.token_balance (mismo sistema que chat.js).

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};

const ROLES_EDICION = ['admin_sitio', 'editor_sitio'];
const ROLES_LECTURA = ['admin_sitio', 'editor_sitio', 'visor_sitio'];

const GH_HEADERS = { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' };

// ── Zonas protegidas (NO editar sin confirmación explícita) ──
const ZONAS_PROTEGIDAS = [
    'supabase', 'auth', 'login', 'signup', 'password', 'token',
    'payment', 'pago', 'wompi', 'checkout', 'carrito', 'cart',
    'api_key', 'apikey', 'secret', 'private_key',
    'service-worker', 'sw.js', 'manifest.json'
];

// ── Nivel de riesgo ──
function evaluarRiesgo(instruction, html) {
    const instLower = instruction.toLowerCase();
    const riesgosAlto = ['borrar', 'eliminar', 'quitar', 'reset', 'reiniciar', 'reemplazar todo', 'nuevo html', 'rebuild'];
    const riesgosMedio = ['cambiar', 'modificar', 'actualizar', 'mover', 'reordenar', 'agregar sección'];
    const protegido = ZONAS_PROTEGIDAS.some(z => instLower.includes(z));

    if (riesgosAlto.some(r => instLower.includes(r)) || protegido) return 'alto';
    if (riesgosMedio.some(r => instLower.includes(r))) return 'medio';
    return 'bajo';
}

async function getUser(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw new Error('Token no enviado');
    const token = authHeader.replace('Bearer ', '');
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) throw new Error('No autenticado');
    return userData.user;
}

async function verificarAcceso(userId, proyectoId, requiereEdicion) {
    const { data: perfil } = await supabase.from('perfiles').select('is_admin').eq('id', userId).maybeSingle();
    if (perfil?.is_admin) return { ok: true, rol: 'admin', isOwner: true };

    const { data: proyecto } = await supabase
        .from('web_projects').select('id, created_by').eq('id', proyectoId).maybeSingle();
    if (!proyecto) return { ok: false, error: 'Proyecto no encontrado' };
    if (proyecto.created_by === userId) return { ok: true, rol: 'owner', isOwner: true };

    const { data: permiso } = await supabase
        .from('tienda_permisos').select('rol')
        .eq('proyecto_id', proyectoId).eq('user_id', userId).maybeSingle();
    if (!permiso) return { ok: false, error: 'No tienes acceso a este sitio' };

    if (requiereEdicion && !ROLES_EDICION.includes(permiso.rol))
        return { ok: false, error: 'Tu rol (' + permiso.rol + ') no permite edición' };
    if (!ROLES_LECTURA.includes(permiso.rol))
        return { ok: false, error: 'Tu rol no permite ver este sitio' };

    return { ok: true, rol: permiso.rol, isOwner: false };
}

async function llamarIA(mensajes, maxTokens = 4000) {
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const fallbackKey = process.env.FALLBACK_API_KEY || process.env.OPENIA_KEY;

    if (deepseekKey) {
        try {
            const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'deepseek-v4-flash', messages: mensajes, temperature: 0.2, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
                signal: AbortSignal.timeout(45000)
            });
            const data = await res.json();
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
        } catch (e) { console.warn('DeepSeek falló:', e.message); }
    }

    if (fallbackKey) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${fallbackKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: mensajes, temperature: 0.3, max_tokens: maxTokens }),
            signal: AbortSignal.timeout(60000)
        });
        const data = await res.json();
        if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
    }

    throw new Error('No hay proveedor de IA disponible');
}

// ── GitHub helpers ──

async function ghReadFile(owner, repo, branch, path) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: GH_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha };
}

async function ghListDir(owner, repo, branch, path) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: GH_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter(f => f.type === 'file');
}

async function ghGetLastCommit(owner, repo, branch) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&per_page=1`, { headers: GH_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[0]?.sha || null;
}

async function ghRevertToCommit(owner, repo, branch, targetSha, commitMessage) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, { headers: GH_HEADERS });
    if (!res.ok) throw new Error('No se pudo leer la ref del branch');
    const refData = await res.json();

    const updateRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: targetSha, force: false })
    });
    if (!updateRes.ok) {
        const errData = await updateRes.json();
        throw new Error('Error al revertir: ' + (errData.message || updateRes.statusText));
    }
    return true;
}

// ── Docs reading ──

async function leerDocsProyecto(owner, repo, branch) {
    const files = await ghListDir(owner, repo, branch, 'docs');
    const mdFiles = files.filter(f => f.name.endsWith('.md'));
    if (!mdFiles.length) return { archivos: [], contenido: '' };

    const partes = [];
    const nombres = [];
    for (const f of mdFiles) {
        const file = await ghReadFile(owner, repo, branch, `docs/${f.name}`);
        if (file) {
            nombres.push(f.name);
            partes.push(`--- ${f.name} ---\n${file.content}`);
        }
    }
    return { archivos: nombres, contenido: partes.join('\n\n') };
}

// ── Site parsing ──

function parseSiteSections(html) {
    const sections = [];
    const regex = /<(section|header|footer|main|article)[^>]*(?:\sid=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
        const tag = m[1].toLowerCase();
        const id = m[2] || `${tag}-${sections.length}`;
        const content = m[3].trim();
        const titleMatch = content.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i);
        const title = titleMatch ? titleMatch[1].trim() : id.replace(/-/g, ' ');
        sections.push({ id, title, tag, preview: content.substring(0, 300) + (content.length > 300 ? '...' : '') });
    }
    if (!sections.length) {
        sections.push({ id: 'contenido', title: 'Contenido principal', tag: 'div', preview: html.substring(0, 600) + (html.length > 600 ? '...' : '') });
    }
    return sections;
}

function validarHTML(html) {
    if (!html || html.length < 100) return false;
    const lower = html.toLowerCase();
    return lower.includes('<head') && lower.includes('<body') && lower.includes('</html>');
}

function separarArchivos(raw) {
    let cleaned = raw.replace(/^```html?\s*/i, '').replace(/\s*```$/i, '').trim();
    const doctypeIdx = cleaned.indexOf('<!DOCTYPE');
    const htmlIdx = cleaned.indexOf('<html');
    const startIdx = doctypeIdx !== -1 ? doctypeIdx : (htmlIdx !== -1 ? htmlIdx : 0);
    let html = cleaned.substring(startIdx).trim();
    const htmlEnd = html.lastIndexOf('</html>');
    if (htmlEnd !== -1) html = html.substring(0, htmlEnd + 7);
    let css = null;
    const cssBlock = raw.match(/```css\s*([\s\S]*?)```/i);
    if (cssBlock) css = cssBlock[1].trim();
    return { html, css };
}

function extractContext(html, instruction) {
    const instrLower = instruction.toLowerCase();
    const words = instrLower.split(/\s+/).filter(w => w.length > 3);
    const lines = html.split('\n');
    const relevant = [];

    for (const word of words) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(word)) {
                const start = Math.max(0, i - 8);
                const end = Math.min(lines.length, i + 9);
                const section = lines.slice(start, end).join('\n');
                if (!relevant.some(s => s.includes(section.substring(0, 100)))) {
                    relevant.push('...línea ' + (i + 1) + '...\n' + section);
                }
            }
        }
    }

    return relevant.length > 0
        ? relevant.join('\n\n---\n\n')
        : html.substring(0, 5000);
}

function aplicarSearchReplace(originalHtml, replacements) {
    let html = originalHtml;
    let applied = 0;
    for (const r of replacements) {
        if (html.includes(r.search)) {
            html = html.split(r.search).join(r.replace);
            applied++;
        }
    }
    return { html, applied };
}

function parseSearchReplace(raw) {
    const pattern = /SEARCH:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*?)(?=\n\nSEARCH:|$)/gi;
    const replacements = [];
    let match;
    while ((match = pattern.exec(raw)) !== null) {
        const search = match[1].trim();
        const replace = match[2].trim();
        if (search && search.length >= 3) {
            replacements.push({ search, replace });
        }
    }
    return replacements;
}

// ── Handler ──

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        const user = await getUser(event);
        const body = JSON.parse(event.body || '{}');
        const { action, proyecto_id } = body;

        if (!proyecto_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta proyecto_id' }) };

        // ── CHECK_TOKENS ──
        if (action === 'check_tokens') {
            const acceso = await verificarAcceso(user.id, proyecto_id, false);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };
            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();
            const tokens = perfil?.token_balance || 0;
            return { statusCode: 200, body: JSON.stringify({ ok: true, tokens, puede_editar: tokens > 0 }) };
        }

        // ── GET_CONTENT ──
        if (action === 'get_content') {
            const acceso = await verificarAcceso(user.id, proyecto_id, false);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { data: proyecto } = await supabase.from('web_projects').select('*').eq('id', proyecto_id).maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };

            const owner = proyecto.github_owner || 'JeisonCastro';
            const repo = proyecto.github_repo || proyecto.slug;
            const branch = proyecto.default_branch || 'main';

            const indexFile = await ghReadFile(owner, repo, branch, 'index.html');
            if (!indexFile) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer index.html del repositorio' }) };

            const sections = parseSiteSections(indexFile.content);
            const docs = await leerDocsProyecto(owner, repo, branch);
            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();
            const lastCommit = await ghGetLastCommit(owner, repo, branch);

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    sections,
                    sha: indexFile.sha,
                    last_commit_sha: lastCommit,
                    full_html_length: indexFile.content.length,
                    tokens: perfil?.token_balance || 0,
                    site_url: proyecto.netlify_url,
                    github_owner: owner,
                    github_repo: repo,
                    branch,
                    docs_archivos: docs.archivos,
                    docs_contenido: docs.contenido
                })
            };
        }

        // ── ANALYZE (conversacional: analiza → propone → espera aprobación) ──
        if (action === 'analyze') {
            const acceso = await verificarAcceso(user.id, proyecto_id, false);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { instruction } = body;
            if (!instruction) return { statusCode: 400, body: JSON.stringify({ error: 'Falta instruction' }) };

            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();
            const tokens = perfil?.token_balance || 0;
            if (tokens <= 0) return { statusCode: 402, body: JSON.stringify({ error: 'Sin tokens disponibles. Recarga tokens para continuar.' }) };

            const { data: proyecto } = await supabase.from('web_projects').select('*').eq('id', proyecto_id).maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };

            const owner = proyecto.github_owner || 'JeisonCastro';
            const repo = proyecto.github_repo || proyecto.slug;
            const branch = proyecto.default_branch || 'main';

            const indexFile = await ghReadFile(owner, repo, branch, 'index.html');
            if (!indexFile) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer index.html' }) };

            const cssFile = await ghReadFile(owner, repo, branch, 'styles.css');
            const docs = await leerDocsProyecto(owner, repo, branch);
            const contextHtml = extractContext(indexFile.content, instruction);
            const riesgo = evaluarRiesgo(instruction, indexFile.content);

            const docsSection = docs.contenido ? `\n\nDOCUMENTACIÓN DEL PROYECTO:\n${docs.contenido}\n` : '';

            const systemPrompt = `Eres un asistente de desarrollo web conversacional. Analizas lo que el usuario quiere cambiar en su sitio y propones una solución.

REGLAS:
1. Responde como un humano: cálido, claro, directo.
2. Primero analiza qué se pide, luego propone una solución concreta.
3. Si hay riesgo alto (ej: borrar contenido, zona protegida), advierte antes de proponer.
4. Si la instrucción es ambigua, pide clarificación antes de proponer cambios.
5. Siempres incluye SEARCH/REPLACE para los cambios que propones.
6. Para cambios simples (teléfono, texto, color), da SEARCH/REPLACE directo.
7. Para cambios complejos (nueva sección, reestructurar), explica qué harás y da SEARCH/REPLACE.

FORMATO DE RESPUESTA (JSON estricto, sin markdown):
{
  "respuesta": "Tu análisis conversacional. Explica qué encontraste, qué propones, y por qué.",
  "riesgo": "bajo|medio|alto",
  "cambios": [
    {"search": "texto exacto a buscar", "replace": "texto de reemplazo"}
  ],
  "resumen_cambios": "Descripción breve de los cambios propuestos",
  "pregunta_clarificacion": null
}

Si necesitas que el usuario aclare algo, responde con pregunta_clarificacion y cambios vacío.
Siempre responde en español.`;

            const userPrompt = `INSTRUCCIÓN DEL USUARIO: ${instruction}

CONTEXTO RELEVANTE DEL HTML (extracto):
${contextHtml}

${docsSection}

Analiza y responde con el JSON:`;

            let rawResponse;
            try {
                rawResponse = await llamarIA([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ], 4000);
            } catch (e) {
                return { statusCode: 502, body: JSON.stringify({ error: 'Error del proveedor de IA: ' + e.message }) };
            }

            // Limpiar markdown si la IA lo incluye
            rawResponse = rawResponse.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

            let parsed;
            try {
                parsed = JSON.parse(rawResponse);
            } catch (e) {
                // Si no es JSON válido, intentar extraer SEARCH/REPLACE del texto libre
                const replacements = parseSearchReplace(rawResponse);
                parsed = {
                    respuesta: rawResponse.replace(/SEARCH:[\s\S]*$/, '').trim() || 'He analizado tu solicitud.',
                    riesgo: evaluarRiesgo(instruction, indexFile.content),
                    cambios: replacements,
                    resumen_cambios: replacements.length > 0 ? `${replacements.length} cambio(s) propuesto(s)` : 'Sin cambios automáticos',
                    pregunta_clarificacion: null
                };
            }

            // Validar que los SEARCH/REPLACE coinciden con el HTML actual
            if (parsed.cambios && parsed.cambios.length > 0) {
                const { applied } = aplicarSearchReplace(indexFile.content, parsed.cambios);
                if (applied === 0 && parsed.cambios.length > 0) {
                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            ok: true,
                            respuesta: 'Encontré tu solicitud pero los textos exactos no coinciden con el HTML actual. ¿Podrías ser más específico sobre qué texto quieres cambiar? Puedes copiar el texto tal como aparece en el sitio.',
                            riesgo: 'bajo',
                            cambios: [],
                            resumen_cambios: '',
                            pregunta_clarificacion: '¿Puedes copiar el texto exacto que quieres modificar?',
                            tokens_remaining: tokens
                        })
                    };
                }
            }

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    respuesta: parsed.respuesta || 'Analicé tu solicitud.',
                    riesgo: parsed.riesgo || riesgo,
                    cambios: parsed.cambios || [],
                    resumen_cambios: parsed.resumen_cambios || '',
                    pregunta_clarificacion: parsed.pregunta_clarificacion || null,
                    tokens_remaining: tokens,
                    preview_url: proyecto.netlify_url
                })
            };
        }

        // ── EXECUTE (aplicar cambios aprobados) ──
        if (action === 'execute') {
            const acceso = await verificarAcceso(user.id, proyecto_id, true);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { instruction, cambios, previous_sha } = body;
            if (!cambios || !Array.isArray(cambios) || cambios.length === 0)
                return { statusCode: 400, body: JSON.stringify({ error: 'Falta cambios (array de SEARCH/REPLACE)' }) };

            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();
            const tokens = perfil?.token_balance || 0;
            if (tokens <= 0) return { statusCode: 402, body: JSON.stringify({ error: 'Sin tokens disponibles.' }) };

            const { data: proyecto } = await supabase.from('web_projects').select('*').eq('id', proyecto_id).maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };

            const owner = proyecto.github_owner || 'JeisonCastro';
            const repo = proyecto.github_repo || proyecto.slug;
            const branch = proyecto.default_branch || 'main';

            // Re-leer para obtener SHA actualizado
            const indexFile = await ghReadFile(owner, repo, branch, 'index.html');
            if (!indexFile) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer index.html' }) };

            const cssFile = await ghReadFile(owner, repo, branch, 'styles.css');

            // Aplicar SEARCH/REPLACE
            const { html: newHtml, applied } = aplicarSearchReplace(indexFile.content, cambios);
            if (applied === 0) {
                return { statusCode: 422, body: JSON.stringify({ error: 'Ningún SEARCH/REPLACE coincide con el HTML actual. Los cambios pueden haber sido modificados.' }) };
            }

            if (!validarHTML(newHtml)) {
                return { statusCode: 500, body: JSON.stringify({ error: 'El resultado no es HTML válido.' }) };
            }

            // Obtener SHA previo para undo
            const shaBefore = previous_sha || await ghGetLastCommit(owner, repo, branch);

            // Commit
            const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/index.html`, {
                method: 'PUT',
                headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `edit: ${(instruction || 'cambio aprobado').substring(0, 80)}`,
                    content: Buffer.from(newHtml).toString('base64'),
                    sha: indexFile.sha,
                    branch
                })
            });
            if (!commitRes.ok) {
                const errData = await commitRes.json();
                return { statusCode: 502, body: JSON.stringify({ error: 'Error al guardar en GitHub: ' + (errData.message || commitRes.statusText) }) };
            }

            const commitData = await commitRes.json();
            const newCommitSha = commitData.commit?.sha || null;

            // Deduct tokens (solo execute cobra tokens, analyze es gratis)
            const tokensUsed = Math.ceil((applied * 50 + newHtml.length) / 4) + 10;
            const tokensRestantes = Math.max(0, tokens - tokensUsed);

            await supabase.from('perfiles').update({ token_balance: tokensRestantes }).eq('id', user.id);
            await supabase.from('edit_token_log').insert({
                proyecto_id, user_id: user.id, tokens_used: tokensUsed,
                description: (instruction || 'cambio aprobado').substring(0, 200)
            });

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    tokens_used: tokensUsed,
                    tokens_remaining: tokensRestantes,
                    applied: applied,
                    preview_url: proyecto.netlify_url,
                    commit_sha: newCommitSha,
                    previous_sha: shaBefore,
                    message: `Cambios aplicados (${applied} búsqueda/reemplazo). ${tokensUsed} tokens. Sitio actualizándose...`
                })
            };
        }

        // ── UNDO (revertir al commit anterior) ──
        if (action === 'undo') {
            const acceso = await verificarAcceso(user.id, proyecto_id, true);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { previous_sha } = body;
            if (!previous_sha) return { statusCode: 400, body: JSON.stringify({ error: 'Falta previous_sha para revertir' }) };

            const { data: proyecto } = await supabase.from('web_projects').select('*').eq('id', proyecto_id).maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };

            const owner = proyecto.github_owner || 'JeisonCastro';
            const repo = proyecto.github_repo || proyecto.slug;
            const branch = proyecto.default_branch || 'main';

            try {
                await ghRevertToCommit(owner, repo, branch, previous_sha, 'Revert: deshacer edición');
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        ok: true,
                        preview_url: proyecto.netlify_url,
                        message: 'Cambios revertidos. El sitio se está restaurando...'
                    })
                };
            } catch (e) {
                return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo revertir: ' + e.message }) };
            }
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida: ' + action }) };

    } catch (err) {
        console.error('site-editor error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
    }
};
