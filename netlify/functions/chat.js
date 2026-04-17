<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Entrar | Jeison Digital AI</title>
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: white; }
        .login-card { background: #1e293b; padding: 2.5rem; border-radius: 16px; box-shadow: 0 15px 35px rgba(0,0,0,0.6); width: 100%; max-width: 380px; text-align: center; border: 1px solid #334155; }
        h2 { margin-bottom: 0.5rem; color: #f8fafc; }
        p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 1.5rem; }
        input { width: 100%; padding: 12px; margin: 8px 0; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; outline: none; }
        button { width: 100%; padding: 12px; margin-top: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; transition: all 0.3s ease; font-size: 1rem; }
        .btn-log { background: #3b82f6; color: white; }
        .btn-reg { background: transparent; color: #10b981; border: 1px solid #10b981; margin-top: 8px; }
        button:hover { opacity: 0.8; transform: translateY(-1px); }
    </style>
</head>
<body>

    <div class="login-card">
        <h2>Fábrica de Agentes</h2>
        <p>Inicia sesión para gestionar tus tokens</p>
        
        <input type="email" id="email" placeholder="Correo electrónico">
        <input type="password" id="password" placeholder="Contraseña">
        
        <button class="btn-log" onclick="entrar()">Iniciar Sesión</button>
        <button class="btn-reg" onclick="registrar()">Crear Cuenta</button>
    </div>

    <script>
        // Simulamos la lógica de tu chat.js pero para el navegador
        const CONFIG = {
            URL: "https://zsxkfqnalkfvwjrzuqip.supabase.co".trim(),
            ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzeGtmcW5hbGtmdndqcnp1cWlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDgyODMsImV4cCI6MjA5MjAyNDI4M30.R4j23l3IHEL966VupeR-Sx_KtDQzB8NzfJtEVDGewGs".trim() // <--- PEGA AQUÍ LA QUE EMPIEZA POR eyJ
        };

        // Inicialización idéntica a tu backend
        const _supabase = supabase.createClient(CONFIG.URL, CONFIG.ANON_KEY);

        async function registrar() {
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            
            if (!email || !password) return alert("Completa los campos");

            const { data, error } = await _supabase.auth.signUp({ email, password });
            
            if (error) alert("Error: " + error.message);
            else alert("¡Cuenta creada! Revisa tu correo o intenta iniciar sesión.");
        }

        async function entrar() {
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;

            if (!email || !password) return alert("Completa los campos");

            const { data, error } = await _supabase.auth.signInWithPassword({ email, password });

            if (error) {
                alert("Error: " + error.message);
            } else {
                // Al loguearte con éxito, redirige al dashboard
                window.location.href = "dashboard.html";
            }
        }
    </script>
</body>
</html>
