/**
 * =========================================================
 *  ЮKassa (YooKassa) Payment Module — Test Mode + Mock Mode
 *  Алтай Трансфер — Telegram Mini App
 * =========================================================
 *
 *  Modes:
 *    • Mock  — when YOOKASSA_SHOP_ID is empty → local simulation
 *    • Test  — when YOOKASSA_TEST=true → ЮKassa test environment
 *    • Live  — production keys → real payments
 *
 *  Built-in modules only: https, crypto
 * =========================================================
 */

const https = require('https');
const crypto = require('crypto');
const database = require('./database');

// ── Config from env ──────────────────────────────────────────────────────────
const YOOKASSA_SHOP_ID     = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY  = process.env.YOOKASSA_SECRET_KEY || '';
const IS_TEST_MODE         = process.env.YOOKASSA_TEST === 'true' || !YOOKASSA_SHOP_ID;
const API_HOST             = 'api.yookassa.ru';
const API_PATH             = '/v3/payments';

// ── Logging helper ───────────────────────────────────────────────────────────
function log(label, ...args) {
  const prefix = IS_TEST_MODE ? '[Payment|TEST]' : '[Payment|LIVE]';
  console.log(prefix, label, ...args);
}

function logError(label, err) {
  console.error('[Payment]', label, err && err.message ? err.message : err);
}

// ── Basic Auth header ────────────────────────────────────────────────────────
function getAuthHeader() {
  const credentials = `${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`;
  return 'Basic ' + Buffer.from(credentials).toString('base64');
}

// ── Generate UUID v4 (no external deps) ──────────────────────────────────────
function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = crypto.randomBytes(1)[0] % 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
}

// ── HTTPS request helper (Promise wrapper) ───────────────────────────────────
function makeRequest(method, path, bodyObject = null) {
  return new Promise((resolve, reject) => {
    const postData = bodyObject ? JSON.stringify(bodyObject) : null;

    const options = {
      hostname: API_HOST,
      port: 443,
      path: path,
      method: method,
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json',
        'Idempotence-Key': generateUUID(),
      },
    };

    if (postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          const statusCode = response.statusCode;
          const parsed = data ? JSON.parse(data) : {};
          if (statusCode >= 200 && statusCode < 300) {
            resolve({ statusCode, data: parsed });
          } else {
            reject(new Error(`ЮKassa API error ${statusCode}: ${parsed.description || parsed.message || JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });

    request.on('error', (err) => {
      reject(new Error(`Request failed: ${err.message}`));
    });

    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Request timeout (30s)'));
    });

    if (postData) {
      request.write(postData);
    }
    request.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  MOCK MODE — Local simulation (no external API calls)
// ══════════════════════════════════════════════════════════════════════════════

const mockPayments = new Map(); // in-memory storage for mock payments

function createMockPayment(orderId, amount, description, returnUrl) {
  const paymentId = 'mock-' + generateUUID().slice(0, 12);
  const confirmationToken = 'mock-token-' + generateUUID().slice(0, 8);

  // Build mock payment URL that redirects back after "payment"
  const mockUrl = new URL(returnUrl);
  mockUrl.searchParams.set('mock_payment', paymentId);
  mockUrl.searchParams.set('mock_token', confirmationToken);

  const payment = {
    id: paymentId,
    status: 'pending',
    amount: { value: String(Number(amount).toFixed(2)), currency: 'RUB' },
    description: description || `Заказ #${orderId}`,
    order_id: orderId,
    created_at: new Date().toISOString(),
    confirmation: {
      type: 'redirect',
      confirmation_url: mockUrl.toString(),
    },
    paid: false,
    test: true,
    refundable: false,
    metadata: { order_id: String(orderId) },
  };

  mockPayments.set(paymentId, payment);
  database.savePayment(payment);

  log('MOCK createPayment:', { paymentId, orderId, amount, status: 'pending' });

  return {
    id: payment.id,
    status: payment.status,
    paid: payment.paid,
    payment_url: payment.confirmation.confirmation_url,
    amount: payment.amount,
    created_at: payment.created_at,
    test: true,
  };
}

function getMockPayment(paymentId) {
  // Check in-memory first, then DB
  let payment = mockPayments.get(paymentId);
  if (!payment) {
    payment = database.getPaymentById(paymentId);
  }
  return payment || null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a payment through ЮKassa or in mock mode.
 *
 * @param {string} orderId      — Internal order ID
 * @param {number} amount       — Amount in rubles (e.g. 1500)
 * @param {string} description  — Payment description
 * @param {string} returnUrl    — URL to redirect after payment
 * @returns {Promise<object>}   — { id, status, paid, payment_url, amount, created_at, test }
 */
async function createPayment(orderId, amount, description, returnUrl) {
  if (!orderId || !amount || amount <= 0) {
    throw new Error('Invalid parameters: orderId and positive amount are required');
  }

  // ── Mock Mode ──────────────────────────────────────────────────────────────
  if (IS_TEST_MODE && !YOOKASSA_SHOP_ID) {
    log('Using MOCK mode (no YOOKASSA_SHOP_ID set)');
    return createMockPayment(orderId, amount, description, returnUrl);
  }

  // ── Real ЮKassa API ────────────────────────────────────────────────────────
  log('Creating payment via ЮKassa API...', { orderId, amount, test: IS_TEST_MODE });

  const payload = {
    amount: {
      value: String(Number(amount).toFixed(2)),
      currency: 'RUB',
    },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: returnUrl,
    },
    description: description || `Заказ #${orderId} — Алтай Трансфер`,
    metadata: {
      order_id: String(orderId),
    },
    test: IS_TEST_MODE, // Enable test mode on ЮKassa side
  };

  try {
    const { data } = await makeRequest('POST', API_PATH, payload);

    const result = {
      id: data.id,
      status: data.status,
      paid: data.paid || false,
      payment_url: data.confirmation && data.confirmation.confirmation_url,
      amount: data.amount,
      created_at: data.created_at,
      test: IS_TEST_MODE,
    };

    // Persist payment info
    database.savePayment({
      id: result.id,
      order_id: orderId,
      status: result.status,
      paid: result.paid,
      amount: result.amount,
      description: payload.description,
      created_at: result.created_at,
      test: result.test,
      payment_url: result.payment_url,
    });

    log('Payment created:', { id: result.id, status: result.status, url: result.payment_url });
    return result;
  } catch (err) {
    logError('createPayment failed:', err);
    throw err;
  }
}

/**
 * Check payment status by ID.
 *
 * @param {string} paymentId — ЮKassa payment ID
 * @returns {Promise<object>} — { id, status, paid, amount, created_at }
 */
async function checkPayment(paymentId) {
  if (!paymentId) {
    throw new Error('paymentId is required');
  }

  // ── Mock Mode ──────────────────────────────────────────────────────────────
  if (IS_TEST_MODE && !YOOKASSA_SHOP_ID) {
    const payment = getMockPayment(paymentId);
    if (!payment) {
      throw new Error('Payment not found');
    }
    return {
      id: payment.id,
      status: payment.status,
      paid: payment.paid,
      amount: payment.amount,
      created_at: payment.created_at,
      test: true,
    };
  }

  // ── Real ЮKassa API ────────────────────────────────────────────────────────
  try {
    const { data } = await makeRequest('GET', `${API_PATH}/${paymentId}`);

    // Update local record
    database.savePayment({
      id: data.id,
      order_id: data.metadata && data.metadata.order_id,
      status: data.status,
      paid: data.paid || false,
      amount: data.amount,
      description: data.description,
      created_at: data.created_at,
      test: IS_TEST_MODE,
    });

    return {
      id: data.id,
      status: data.status,
      paid: data.paid || false,
      amount: data.amount,
      created_at: data.created_at,
      test: IS_TEST_MODE,
    };
  } catch (err) {
    logError('checkPayment failed:', err);
    throw err;
  }
}

/**
 * Handle ЮKassa webhook notification.
 *
 * @param {object} body — Webhook payload from ЮKassa
 * @returns {object}    — { success: boolean, paymentId, orderId, status, handled }
 */
function handleWebhook(body) {
  try {
    if (!body || typeof body !== 'object') {
      logError('Webhook: invalid body', new Error('Body is not an object'));
      return { success: false, handled: false };
    }

    const event = body.event;      // e.g. "payment.succeeded", "payment.canceled", "payment.waiting_for_capture"
    const object = body.object;    // Payment object

    if (!object || !object.id) {
      log('Webhook: no payment object, ignoring');
      return { success: false, handled: false };
    }

    const paymentId = object.id;
    const status = object.status;  // "pending", "waiting_for_capture", "succeeded", "canceled"
    const paid = object.paid || false;
    const orderId = object.metadata && object.metadata.order_id;

    log('Webhook received:', { event, paymentId, status, orderId, paid });

    // Persist payment update
    database.savePayment({
      id: paymentId,
      order_id: orderId,
      status: status,
      paid: paid,
      amount: object.amount,
      description: object.description,
      created_at: object.created_at,
      test: IS_TEST_MODE,
      event: event,
    });

    // Update order status based on payment status
    if (orderId) {
      try {
        if (status === 'succeeded') {
          database.updateOrderStatus(orderId, 'CONFIRMED');
          log('Order confirmed:', { orderId, paymentId });
        } else if (status === 'canceled') {
          database.updateOrderStatus(orderId, 'CANCELLED');
          log('Order cancelled:', { orderId, paymentId });
        }
      } catch (err) {
        logError('Failed to update order status:', err);
      }
    }

    return {
      success: true,
      handled: true,
      paymentId: paymentId,
      orderId: orderId,
      status: status,
      paid: paid,
      event: event,
    };
  } catch (err) {
    logError('Webhook handler error:', err);
    return { success: false, handled: false };
  }
}

/**
 * Get test card information for UI display.
 * @returns {Array<object>} — List of test cards with scenarios
 */
function getTestCardInfo() {
  return [
    {
      name: 'Успешный платёж',
      number: '5555 5555 5555 4477',
      expiry: '12/30',
      cvv: '123',
      code3ds: '12345678',
      result: 'Платёж успешно выполнен',
      color: '#28a745',
    },
    {
      name: 'Успешный платёж (3DS)',
      number: '5555 5555 5555 4477',
      expiry: 'Любая дата в будущем',
      cvv: '123',
      code3ds: '12345678',
      result: 'Платёж с 3D Secure подтверждением',
      color: '#17a2b8',
    },
    {
      name: 'Отказ в платеже',
      number: '5555 5555 5555 4444',
      expiry: 'Любая дата в будущем',
      cvv: '123',
      code3ds: null,
      result: 'Платёж отклонён банком',
      color: '#dc3545',
    },
    {
      name: 'Недостаточно средств',
      number: '4000 0000 0000 0077',
      expiry: 'Любая дата в будущем',
      cvv: '123',
      code3ds: null,
      result: 'Ошибка: недостаточно средств',
      color: '#fd7e14',
    },
  ];
}

/**
 * Simulate mock payment completion (for test page).
 * @param {string} paymentId — Mock payment ID
 * @param {boolean} success  — Whether payment should succeed
 */
function simulateMockPayment(paymentId, success) {
  const payment = mockPayments.get(paymentId);
  if (!payment) {
    throw new Error('Mock payment not found');
  }

  payment.status = success ? 'succeeded' : 'canceled';
  payment.paid = success;
  payment.paid_at = new Date().toISOString();

  mockPayments.set(paymentId, payment);
  database.savePayment(payment);

  // Update order status
  if (payment.order_id) {
    try {
      database.updateOrderStatus(payment.order_id, success ? 'CONFIRMED' : 'CANCELLED');
    } catch (err) {
      logError('Failed to update order on mock simulation:', err);
    }
  }

  log('MOCK payment simulated:', { paymentId, status: payment.status, paid: payment.paid });
  return {
    id: payment.id,
    status: payment.status,
    paid: payment.paid,
  };
}

/**
 * Get module info / health check.
 */
function getInfo() {
  return {
    mode: IS_TEST_MODE ? (YOOKASSA_SHOP_ID ? 'test' : 'mock') : 'live',
    shopId: YOOKASSA_SHOP_ID ? `${YOOKASSA_SHOP_ID.slice(0, 4)}****` : 'not set',
    hasSecretKey: !!YOOKASSA_SECRET_KEY,
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  createPayment,
  checkPayment,
  handleWebhook,
  getTestCardInfo,
  simulateMockPayment,
  getInfo,
  IS_TEST_MODE,
};
