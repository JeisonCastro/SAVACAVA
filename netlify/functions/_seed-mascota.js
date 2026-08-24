const { supabase } = require('./supabase-admin');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };

    try {
        const body = JSON.parse(event.body || '{}');
        if (body.secret !== 'auvro-seed-2026') return { statusCode: 403, body: JSON.stringify({ error: 'Unauthorized' }) };

        const { data: existing } = await supabase.from('web_projects').select('id, github_owner, github_repo').eq('slug', 'mascotraoficial').maybeSingle();
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'No existe el proyecto' }) };

        const updates = {};
        if (!existing.github_owner) updates.github_owner = 'JeisonCastro';
        if (!existing.github_repo) updates.github_repo = 'mascotraoficial';
        updates.default_branch = 'main';

        if (Object.keys(updates).length > 1) {
            const { error } = await supabase.from('web_projects').update(updates).eq('id', existing.id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
        }

        return { statusCode: 200, body: JSON.stringify({ ok: true, id: existing.id, updates }) };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
