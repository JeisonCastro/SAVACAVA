
const { createClient } = require('@supabase/supabase-js');

// Usamos SERVICE_ROLE para que el backend pueda leer sin restricciones de RLS
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};

exports.handler = async (event) => {

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    try {
        // 1. Verificar token JWT del usuario (seguridad: no confiamos en el frontend)
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado.' }) };

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token inválido.' }) };

        const { nombre_agente, prompt_sistema } = JSON.parse(event.body);
        if (!nombre_agente || !prompt_sistema) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan campos requeridos.' }) };
        }

        // 2. Obtener perfil + plan del usuario en una sola consulta
        const { data: perfil, error: perfilError } = await supabase
            .from('perfiles')
            .select('plan_id, planes(nombre, limite_agentes)')
            .eq('id', user.id)
            .single();

        if (perfilError || !perfil) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Perfil no encontrado.' }) };
        }

        const limiteAgentes = perfil.planes?.limite_agentes ?? 1;
        const nombrePlan = perfil.planes?.nombre ?? 'Free';

        // 3. Contar agentes actuales del usuario
        const { count, error: countError } = await supabase
            .from('agentes_ia')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id);

        if (countError) throw new Error('Error al contar agentes: ' + countError.message);

        // 4. Validar límite del plan — REGLA DE NEGOCIO EN BACKEND
        if (count >= limiteAgentes) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                    error: `Has alcanzado el límite de tu plan ${nombrePlan} (${limiteAgentes} agente${limiteAgentes > 1 ? 's' : ''}). Mejora tu suscripción para crear más agentes.`,
                    codigo: 'LIMITE_PLAN_ALCANZADO',
                    limite: limiteAgentes,
                    actual: count,
                    whatsapp: 'https://wa.me/573115364647?text=' + encodeURIComponent(`Hola Jeison, quiero mejorar mi plan. Actualmente tengo el plan ${nombrePlan} y quiero crear más agentes.`)
                })
            };
        }

        // 5. Crear el agente (solo si pasó la validación)
        const { data: nuevoAgente, error: insertError } = await supabase
            .from('agentes_ia')
            .insert([{
                nombre_agente,
                prompt_sistema,
                user_id: user.id
            }])
            .select()
            .single();

        if (insertError) throw new Error('Error al crear agente: ' + insertError.message);

        return {
            statusCode: 201,
            headers,
            body: JSON.stringify({
                mensaje: `Agente "${nombre_agente}" creado correctamente.`,
                agente: nuevoAgente,
                agentes_restantes: limiteAgentes - (count + 1)
            })
        };

    } catch (err) {
        console.error('Error en crear-agente:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Error interno del servidor.' })
        };
    }
};
