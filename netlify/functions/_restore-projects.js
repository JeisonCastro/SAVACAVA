// _restore-projects.js — Función temporal para restaurar web_projects eliminados.
// POST con body: { projects: [...] }
const { supabase } = require('./supabase-admin');

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };

        const { projects } = JSON.parse(event.body || '{}');
        if (!projects || !Array.isArray(projects) || projects.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing projects array' }) };
        }

        const results = [];
        for (const p of projects) {
            const { data, error } = await supabase
                .from('web_projects')
                .insert(p)
                .select()
                .single();
            if (error) {
                results.push({ slug: p.slug, error: error.message });
            } else {
                results.push({ slug: p.slug, id: data.id, ok: true });
            }
        }

        return { statusCode: 200, body: JSON.stringify(results) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
