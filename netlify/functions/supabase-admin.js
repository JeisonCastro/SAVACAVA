// supabase-admin.js — Cliente Supabase compartido con polyfill WebSocket
// Resuelve el error "Node.js detected but native WebSocket not found" en Node.js < 22

if (typeof globalThis.WebSocket === 'undefined') {
    try {
        globalThis.WebSocket = require('ws');
    } catch (_) {}
}

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
