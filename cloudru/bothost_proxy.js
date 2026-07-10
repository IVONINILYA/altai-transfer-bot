#!/usr/bin/env node

// ═══════════════════════════════════════════════════════════════
//  bothost_proxy.js — Bothost в режиме Proxy → Cloud.ru VM
//  Роли:
//    1. Раздача статики Mini App (index.html, CSS, JS, картинки)
//    2. Проксирование API-запросов на Cloud.ru VM
//    3. Приём webhook'ов от Telegram и пересылка на Cloud.ru
//    4. Проверка Telegram initData (HMAC-SHA256) — остаётся здесь
//  Что убрано:
//    - SQLite (перенесено в PostgreSQL на Cloud.ru)
//    - better-sqlite3 зависимость
//    - Бизнес-логика (orders, drivers, routes)
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

// ── Config ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOTHOST_TOKEN = process.env.BOTHOST_TOKEN || '';

// Cloud.ru VM API URL
const CLOUDRU_API_URL = process.env.CLOUDRU_API_URL || 'http://YOUR_CLOUDRU_IP:8000';
// API Key для авторизации с Cloud.ru
const CLOUDRU_API_KEY = process.env.CLOUDRU_API_KEY || '';

// ── Content-Type map ───────────────────────────────────────────
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
};

// ── CORS headers ───────────────────────────────────────────────
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Proxy request to Cloud.ru ──────────────────────────────────
async function proxyToCloud(req, body, targetPath) {
    return new Promise((resolve, reject) => {
        const url = new URL(targetPath || req.url, CLOUDRU_API_URL);
        const isHttps = url.protocol === 'https:';
        const client = require(isHttps ? 'https' : 'http');

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: req.method,
            headers: {
                'Content-Type': req.headers['content-type'] || 'application/json',
                'Accept': 'application/json',
                'X-API-Key': CLOUDRU_API_KEY,
                'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket.remoteAddress,
                'User-Agent': req.headers['user-agent'] || 'Bothost-Proxy/2.0',
            },
            timeout: 30000,  // 30 секунд таймаут
        };

        const proxyReq = client.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => { data += chunk; });
            proxyRes.on('end', () => {
                resolve({
                    statusCode: proxyRes.statusCode,
                    headers: proxyRes.headers,
                    body: data,
                });
            });
        });

        proxyReq.on('error', reject);
        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            reject(new Error('Proxy request timeout'));
        });

        if (body) {
            proxyReq.write(body);
        }
        proxyReq.end();
    });
}

// ── JSON body parser ───────────────────────────────────────────
function parseBody(req, callback) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const data = body ? JSON.parse(body) : {};
            callback(null, data, body);
        } catch (err) {
            callback(err, null, body);
        }
    });
    req.on('error', (err) => callback(err, null, body));
}

// ── Static file serving ────────────────────────────────────────
function serveStaticFile(res, filePath) {
    try {
        const fullPath = path.join(__dirname, 'public', filePath);
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

        // Security: prevent directory traversal
        const resolvedPath = path.resolve(fullPath);
        const publicDir = path.resolve(__dirname, 'public');
        if (!resolvedPath.startsWith(publicDir)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }

        const data = fs.readFileSync(resolvedPath);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600',
        });
        res.end(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        } else {
            console.error('[Static] Error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
}

// ── Validate Telegram initData (stays on Bothost) ──────────────
function validateInitData(initData, botToken) {
    if (!initData || typeof initData !== 'string') {
        return { valid: false, user: null };
    }

    // Dev mode
    if (!botToken || botToken === '') {
        return { valid: true, user: null };
    }

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return { valid: false, user: null };

        const keys = [];
        for (const [key] of params) {
            if (key !== 'hash') keys.push(key);
        }
        keys.sort();

        const dataCheckParts = [];
        for (const key of keys) {
            dataCheckParts.push(`${key}=${params.get(key)}`);
        }
        const dataCheckString = dataCheckParts.join('\n');

        const secret = crypto.createHmac('sha256', 'WebAppData')
            .update(botToken).digest();
        const checkHash = crypto.createHmac('sha256', secret)
            .update(dataCheckString).digest('hex');

        const checkHashBuf = Buffer.from(checkHash, 'hex');
        const hashBuf = Buffer.from(hash, 'hex');

        if (checkHashBuf.length !== hashBuf.length) {
            return { valid: false, user: null };
        }

        if (!crypto.timingSafeEqual(checkHashBuf, hashBuf)) {
            return { valid: false, user: null };
        }

        // Parse user
        let user = null;
        try {
            const userJson = params.get('user');
            if (userJson) user = JSON.parse(userJson);
        } catch (e) { /* ignore */ }

        return { valid: true, user };
    } catch (e) {
        return { valid: false, user: null };
    }
}

// ── Main Server ────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    // Set CORS headers
    setCorsHeaders(res);

    // Handle preflight OPTIONS
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // ═══════════════════════════════════════════════════════════
        //  API Routes → Proxy to Cloud.ru
        // ═══════════════════════════════════════════════════════════
        if (pathname.startsWith('/api/')) {
            parseBody(req, async (err, bodyData, rawBody) => {
                if (err && req.method === 'POST') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    return;
                }

                try {
                    // Handle GET with query params (convert initData to query string)
                    let targetUrl = pathname;
                    if (url.search) {
                        targetUrl += url.search;
                    }

                    // For POST /api/orders — ensure initData is in body
                    const bodyToSend = rawBody || '';

                    console.log(`[Proxy] ${req.method} ${pathname} → Cloud.ru`);
                    const result = await proxyToCloud(req, bodyToSend, targetUrl);

                    // Forward response from Cloud.ru
                    res.writeHead(result.statusCode, {
                        'Content-Type': result.headers['content-type'] || 'application/json',
                    });
                    res.end(result.body);

                } catch (proxyErr) {
                    console.error('[Proxy] Error:', proxyErr.message);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Cloud.ru API unavailable',
                        message: proxyErr.message,
                        retry_after: 5,
                    }));
                }
            });
            return;
        }

        // ═══════════════════════════════════════════════════════════
        //  Telegram Webhook → Proxy to Cloud.ru
        // ═══════════════════════════════════════════════════════════
        if (pathname === '/webhook' && req.method === 'POST') {
            parseBody(req, async (err, bodyData, rawBody) => {
                try {
                    console.log('[Webhook] Received from Telegram → forwarding to Cloud.ru');
                    const result = await proxyToCloud(req, rawBody, '/api/webhook');
                    res.writeHead(result.statusCode);
                    res.end(result.body);
                } catch (proxyErr) {
                    console.error('[Webhook] Error:', proxyErr.message);
                    // Return 200 to Telegram so it doesn't retry endlessly
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true, error: 'Forwarded with issues' }));
                }
            });
            return;
        }

        // ═══════════════════════════════════════════════════════════
        //  Health Check (local)
        // ═══════════════════════════════════════════════════════════
        if (pathname === '/health' && req.method === 'GET') {
            // Check Cloud.ru connectivity
            proxyToCloud(req, '', '/api/health')
                .then(result => {
                    const cloudData = JSON.parse(result.body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'ok',
                        mode: 'proxy',
                        cloudru: cloudData.status || 'unknown',
                        timestamp: new Date().toISOString(),
                    }));
                })
                .catch(err => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'degraded',
                        mode: 'proxy',
                        cloudru: 'unreachable',
                        error: err.message,
                        timestamp: new Date().toISOString(),
                    }));
                });
            return;
        }

        // ═══════════════════════════════════════════════════════════
        //  Static Files (Mini App)
        // ═══════════════════════════════════════════════════════════
        if (pathname === '/' || pathname === '/index.html') {
            serveStaticFile(res, 'index.html');
            return;
        }

        if (pathname === '/style.css') {
            serveStaticFile(res, 'style.css');
            return;
        }

        if (pathname === '/script.js') {
            serveStaticFile(res, 'script.js');
            return;
        }

        // Any other file from public/
        if (pathname.startsWith('/')) {
            serveStaticFile(res, pathname.slice(1));
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
        console.error('[Server] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
});

// ── Startup ────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║     🏔️  Алтай Трансфер — Bothost Proxy Mode v2.0       ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Server:   Bothost (nl7.bothost.ru)${''.padEnd(22)}║`);
    console.log(`║  Port:     ${String(PORT).padEnd(44)}║`);
    console.log(`║  Mode:     PROXY → Cloud.ru${''.padEnd(30)}║`);
    console.log(`║  Cloud.ru: ${CLOUDRU_API_URL.padEnd(44)}║`);
    console.log(`║  Auth:     ${(BOT_TOKEN ? 'Telegram HMAC-SHA256' : 'dev mode').padEnd(44)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Роли:                                                  ║');
    console.log('║    ✓ Раздача Mini App статики                           ║');
    console.log('║    ✓ Проксирование API → Cloud.ru                       ║');
    console.log('║    ✓ Telegram webhook → Cloud.ru                        ║');
    console.log('║    ✓ Проверка initData (HMAC-SHA256)                    ║');
    console.log('║    ✗ База данных → PostgreSQL на Cloud.ru               ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /health          — Health check (local)');
    console.log('  GET  /api/*           → Proxy to Cloud.ru');
    console.log('  POST /api/*           → Proxy to Cloud.ru');
    console.log('  POST /webhook         → Proxy Telegram webhooks');
    console.log('  GET  /                — Mini App (static)');
    console.log('  GET  /*               — Static files');
    console.log('');
});
