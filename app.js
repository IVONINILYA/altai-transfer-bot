const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const database = require('./database');
const auth = require('./auth');
const deploy = require('./deploy');
const payment = require('./payment');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOTHOST_TOKEN = process.env.BOTHOST_TOKEN || '';
const GITHUB_SECRET = process.env.GITHUB_SECRET || '';

// ── Content-Type map ────────────────────────────────────────────────────────
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

// ── CORS headers ────────────────────────────────────────────────────────────
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── JSON body parser ────────────────────────────────────────────────────────
function parseJsonBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const data = body ? JSON.parse(body) : {};
      callback(null, data);
    } catch (err) {
      callback(err, null);
    }
  });
  req.on('error', (err) => {
    callback(err, null);
  });
}

// ── Static file serving ─────────────────────────────────────────────────────
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

// ── Route handlers ──────────────────────────────────────────────────────────

function handleGetRoutes(req, res) {
  try {
    const routes = database.getAllRoutes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(routes));
  } catch (err) {
    console.error('[API] getAllRoutes error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleGetDrivers(req, res) {
  try {
    const drivers = database.getAllDrivers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(drivers));
  } catch (err) {
    console.error('[API] getAllDrivers error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleCreateOrder(req, res) {
  parseJsonBody(req, (err, data) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      // Validate initData
      const initData = data.initData || '';
      const validation = auth.validateInitData(initData, BOT_TOKEN);

      if (!validation.valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid initData' }));
        return;
      }

      // Extract user info
      let userId = '';
      let userName = '';
      const user = auth.getUserFromInitData(initData);
      if (user) {
        userId = user.id;
        userName = [user.first_name, user.last_name].filter(Boolean).join(' ');
      }

      // Validate required fields
      if (!data.route_id || !data.driver_id || !data.date || !data.price) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: route_id, driver_id, date, price' }));
        return;
      }

      const order = database.createOrder({
        user_id: userId,
        user_name: userName || null,
        user_phone: data.user_phone || null,
        route_id: data.route_id,
        driver_id: data.driver_id,
        date: data.date,
        time: data.time || null,
        passengers: data.passengers || 1,
        price: data.price,
        comment: data.comment || null,
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(order));
    } catch (err) {
      console.error('[API] createOrder error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

function handleGetUserOrders(req, res, queryParams) {
  try {
    const initData = queryParams.get('initData') || '';
    const validation = auth.validateInitData(initData, BOT_TOKEN);

    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid initData' }));
      return;
    }

    const user = auth.getUserFromInitData(initData);
    const userId = user ? user.id : '';

    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: user not found' }));
      return;
    }

    const orders = database.getOrdersByUserId(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(orders));
  } catch (err) {
    console.error('[API] getUserOrders error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleGetOrderById(req, res, id) {
  try {
    const order = database.getOrderById(id);
    if (!order) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Order not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(order));
  } catch (err) {
    console.error('[API] getOrderById error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    timestamp: new Date().toISOString(),
    payment: payment.getInfo(),
  }));
}

// ── Payment endpoints ───────────────────────────────────────────────────────

function handleCreatePayment(req, res) {
  parseJsonBody(req, (err, data) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      const orderId = data.order_id;
      const amount = data.amount;
      const description = data.description || '';

      if (!orderId || !amount || amount <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid fields: order_id, amount (must be > 0)' }));
        return;
      }

      // Build return URL from request headers or use default
      const host = req.headers.host || 'localhost:3000';
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const returnUrl = data.return_url || `${protocol}://${host}/payment-test.html`;

      payment.createPayment(orderId, amount, description, returnUrl)
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            payment_url: result.payment_url,
            payment_id: result.id,
            status: result.status,
            paid: result.paid,
            test: result.test || false,
          }));
        })
        .catch((err) => {
          console.error('[API] createPayment error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to create payment: ' + err.message }));
        });
    } catch (err) {
      console.error('[API] handleCreatePayment error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

function handlePaymentWebhook(req, res) {
  parseJsonBody(req, (err, body) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      // Always return 200 to ЮKassa, even if processing fails
      // ЮKassa will retry if we don't return 200
      const result = payment.handleWebhook(body);

      if (result.handled) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true, payment_id: result.paymentId }));
      } else {
        // Still return 200 to prevent retries for unprocessable webhooks
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true, handled: false }));
      }
    } catch (err) {
      console.error('[API] webhook error:', err.message);
      // Always return 200 to ЮKassa
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true, error: err.message }));
    }
  });
}

function handleGetPaymentStatus(req, res, paymentId) {
  try {
    if (!paymentId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payment ID is required' }));
      return;
    }

    payment.checkPayment(paymentId)
      .then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: result.status,
          paid: result.paid,
          id: result.id,
          amount: result.amount,
          test: result.test || false,
        }));
      })
      .catch((err) => {
        console.error('[API] checkPayment error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to check payment: ' + err.message }));
      });
  } catch (err) {
    console.error('[API] handleGetPaymentStatus error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleGetTestCards(req, res) {
  try {
    const cards = payment.getTestCardInfo();
    const info = payment.getInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mode: info.mode,
      cards: cards,
    }));
  } catch (err) {
    console.error('[API] getTestCards error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

// ── Driver endpoints ────────────────────────────────────────────────────────

function handleGetDriverOrders(req, res, queryParams) {
  try {
    const driverId = queryParams.get('driver_id');
    const status = queryParams.get('status');

    if (!driverId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: driver_id' }));
      return;
    }

    let orders = database.getDriverOrders(driverId);

    if (status) {
      const validStatuses = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
      if (!validStatuses.includes(status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }));
        return;
      }
      orders = orders.filter(o => o.status === status);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(orders));
  } catch (err) {
    console.error('[API] getDriverOrders error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handleUpdateOrderStatus(req, res, orderId) {
  parseJsonBody(req, (err, data) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      const status = data.status;
      const validStatuses = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];

      if (!status || !validStatuses.includes(status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid or missing status. Must be one of: ${validStatuses.join(', ')}` }));
        return;
      }

      const order = database.updateOrderStatus(orderId, status);
      if (!order) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Order not found' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(order));
    } catch (err) {
      console.error('[API] updateOrderStatus error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

function handleGetDriverCalendar(req, res, queryParams) {
  try {
    const driverId = queryParams.get('driver_id');
    const month = queryParams.get('month');

    if (!driverId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: driver_id' }));
      return;
    }

    if (!month) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: month (YYYY-MM)' }));
      return;
    }

    const calendar = database.getDriverCalendar(driverId, month);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(calendar));
  } catch (err) {
    console.error('[API] getDriverCalendar error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

function handlePostDriverCalendar(req, res) {
  parseJsonBody(req, (err, data) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      const driverId = data.driver_id;
      const date = data.date;

      if (!driverId || !date) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: driver_id, date' }));
        return;
      }

      const result = database.markDriverBusy(driverId, date, data.note);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[API] postDriverCalendar error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

function handleDeleteDriverCalendar(req, res) {
  parseJsonBody(req, (err, data) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      const driverId = data.driver_id;
      const date = data.date;

      if (!driverId || !date) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: driver_id, date' }));
        return;
      }

      const result = database.markDriverFree(driverId, date);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[API] deleteDriverCalendar error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

function handleRegisterDriver(req, res) {
  parseJsonBody(req, (err, data) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      if (!data.name || !data.phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: name, phone' }));
        return;
      }

      const result = database.registerDriver({
        name: data.name,
        phone: data.phone,
        car: data.car || null,
        year: data.year || null,
        color: data.color || null,
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        driver_id: result.driver_id,
        name: result.name,
        message: 'Ожидайте подтверждения',
      }));
    } catch (err) {
      console.error('[API] registerDriver error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

// ── Main server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Set CORS headers for all responses
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

    // ── API Routes ──
    if (pathname === '/api/routes' && req.method === 'GET') {
      handleGetRoutes(req, res);
      return;
    }

    if (pathname === '/api/drivers' && req.method === 'GET') {
      handleGetDrivers(req, res);
      return;
    }

    if (pathname === '/api/orders' && req.method === 'POST') {
      handleCreateOrder(req, res);
      return;
    }

    if (pathname === '/api/orders' && req.method === 'GET') {
      handleGetUserOrders(req, res, url.searchParams);
      return;
    }

    if (pathname.startsWith('/api/orders/') && req.method === 'GET') {
      const id = pathname.split('/')[3];
      handleGetOrderById(req, res, id);
      return;
    }

    // Driver endpoints
    if (pathname === '/api/driver/orders' && req.method === 'GET') {
      handleGetDriverOrders(req, res, url.searchParams);
      return;
    }

    if (pathname.startsWith('/api/driver/orders/') && req.method === 'POST' && pathname.endsWith('/status')) {
      const parts = pathname.split('/');
      const orderId = parts[4];
      handleUpdateOrderStatus(req, res, orderId);
      return;
    }

    if (pathname === '/api/driver/calendar' && req.method === 'GET') {
      handleGetDriverCalendar(req, res, url.searchParams);
      return;
    }

    if (pathname === '/api/driver/calendar' && req.method === 'POST') {
      handlePostDriverCalendar(req, res);
      return;
    }

    if (pathname === '/api/driver/calendar' && req.method === 'DELETE') {
      handleDeleteDriverCalendar(req, res);
      return;
    }

    if (pathname === '/api/drivers/register' && req.method === 'POST') {
      handleRegisterDriver(req, res);
      return;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      handleHealth(req, res);
      return;
    }

    // Payment endpoints
    if (pathname === '/api/payments/create' && req.method === 'POST') {
      handleCreatePayment(req, res);
      return;
    }

    if (pathname === '/api/payments/webhook' && req.method === 'POST') {
      handlePaymentWebhook(req, res);
      return;
    }

    if (pathname === '/api/payments/test-cards' && req.method === 'GET') {
      handleGetTestCards(req, res);
      return;
    }

    if (pathname.startsWith('/api/payments/') && pathname.endsWith('/status') && req.method === 'GET') {
      const parts = pathname.split('/');
      const paymentId = parts[3];
      handleGetPaymentStatus(req, res, paymentId);
      return;
    }

    if (pathname === '/api/payments/simulate' && req.method === 'POST') {
      parseJsonBody(req, (err, data) => {
        if (!err && data && data.payment_id) {
          try {
            const result = payment.simulateMockPayment(data.payment_id, data.success !== false);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payment_id required' }));
        }
      });
      return;
    }

    if (pathname === '/deploy' && req.method === 'POST') {
      deploy.handleDeploy(req, res);
      return;
    }

    // ── Static Files ──
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

    // Try to serve any other file from public/
    if (pathname.startsWith('/')) {
      serveStaticFile(res, pathname.slice(1));
      return;
    }

    // 404 fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err) {
    console.error('[Server] Error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// ── Startup ─────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     🏔️  Алтай Трансфер — Mini App       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Server running on port ${String(PORT).padEnd(24)}║`);
  console.log(`║  Database: ${String(process.env.DATABASE_PATH || './data/altai.db').padEnd(33)}║`);
  console.log(`║  Auth: ${String(BOT_TOKEN ? 'Telegram HMAC-SHA256' : 'dev mode (no token)').padEnd(37)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /api/routes                    — List all routes');
  console.log('  GET  /api/drivers                   — List active drivers');
  console.log('  POST /api/drivers/register          — Register new driver (name, phone, car, year, color)');
  console.log('  POST /api/orders                    — Create order (auth required)');
  console.log('  GET  /api/orders                    — List user orders (auth required)');
  console.log('  GET  /api/orders/:id                — Get order by ID');
  console.log('  GET  /api/driver/orders             — List driver orders (?driver_id=..&status=..)');
  console.log('  POST /api/driver/orders/:id/status  — Update order status');
  console.log('  GET  /api/driver/calendar           — Driver calendar (?driver_id=..&month=YYYY-MM)');
  console.log('  POST /api/driver/calendar           — Mark day as busy (driver_id, date, note?)');
  console.log('  DELETE /api/driver/calendar         — Remove busy mark (driver_id, date)');
  console.log('  POST /api/payments/create           — Create payment (order_id, amount, description)');
  console.log('  POST /api/payments/webhook          — ЮKassa webhook notification');
  console.log('  GET  /api/payments/:id/status       — Check payment status');
  console.log('  POST /api/payments/simulate         — Simulate mock payment (mock mode only)');
  console.log('  GET  /api/payments/test-cards       — Get test card data');
  console.log('  GET  /api/health                    — Health check');
  console.log('  POST /deploy                        — Deploy webhook');
  console.log('  GET  /                              — Static files (public/)');
  console.log('');
});
