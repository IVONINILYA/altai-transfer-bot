const fs = require('fs');
const path = require('path');

const DATABASE_PATH = process.env.DATABASE_PATH || './data/altai.db';

// ── Database Engine Selection ──────────────────────────────────────────────
// Try better-sqlite3 first (production on bothost), fall back to in-memory (dev)

let db = null;
let useSQLite = false;

// In-memory storage fallback
const memoryDB = {
  routes: [],
  drivers: [],
  orders: [],
  orderIdCounter: 1,
  payments: [],
  driverCalendar: [],
  driverIdCounter: 9, // d1-d8 are seeded
};

try {
  const Database = require('better-sqlite3');
  const dbDir = path.dirname(DATABASE_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new Database(DATABASE_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  useSQLite = true;
  console.log('[DB] Using better-sqlite3 at ' + DATABASE_PATH);
} catch (err) {
  console.warn('[DB] better-sqlite3 not available, using in-memory storage (dev mode)');
  console.warn('[DB] Install for production: npm install better-sqlite3');
  useSQLite = false;
}

// Kilometrage from Chuya Highway (km from Novosibirsk, airport at km 459)
// Price = distance × 30 RUB/km, min 500 RUB
const KM_TO_AIRPORT = 459;
const PRICE_PER_KM = 30;
function makeRoute(id, name, from, to, kmFromNsk, extraKm, duration) {
  var dist = kmFromNsk - KM_TO_AIRPORT + (extraKm || 0);
  if (dist < 0) dist = Math.abs(dist); // local routes
  return {
    id: id, name: name,
    from_location: from, to_location: to,
    distance: Math.round(dist),
    duration: duration,
    price: Math.max(500, Math.round(dist * PRICE_PER_KM / 50) * 50) // round to 50
  };
}

const SEED_ROUTES = [
  // From airport (Chuya Highway km 459)
  makeRoute('r1',  'Аэропорт → Горно-Алтайск',     'Аэропорт Горно-Алтайск', 'Горно-Алтайск',     464,  0,  '15 мин'),
  makeRoute('r2',  'Аэропорт → Манжерок',           'Аэропорт Горно-Алтайск', 'Манжерок',          485,  0,  '30 мин'),
  makeRoute('r3',  'Аэропорт → Чемал',              'Аэропорт Горно-Алтайск', 'Чемал',             511,  30, '1.5 часа'),
  makeRoute('r4',  'Аэропорт → Онгудай',            'Аэропорт Горно-Алтайск', 'Онгудай',           652,  0,  '3 часа'),
  makeRoute('r5',  'Аэропорт → Усть-Кан',           'Аэропорт Горно-Алтайск', 'Усть-Кан',          630,  15, '3 часа'),
  makeRoute('r6',  'Аэропорт → Усть-Кокса',         'Аэропорт Горно-Алтайск', 'Усть-Кокса',        630,  35, '3.5 часа'),
  makeRoute('r7',  'Аэропорт → Акташ',              'Аэропорт Горно-Алтайск', 'Акташ',             788,  0,  '5 часов'),
  makeRoute('r8',  'Аэропорт → Кош-Агач',           'Аэропорт Горно-Алтайск', 'Кош-Агач',          893,  0,  '6 часов'),
  makeRoute('r9',  'Аэропорт → Улаган',             'Аэропорт Горно-Алтайск', 'Улаган',            788,  50, '5.5 часов'),
  makeRoute('r10', 'Аэропорт → Джазатор (Беляши)',  'Аэропорт Горно-Алтайск', 'Джазатор (Беляши)', 893,  140,'8 часов'),
  makeRoute('r11', 'Аэропорт → Телецкое озеро',     'Аэропорт Горно-Алтайск', 'Телецкое озеро',    511,  180,'5.5 часов'),
  // Between locations
  makeRoute('r12', 'Горно-Алтайск → Манжерок',      'Горно-Алтайск',          'Манжерок',          485,  -464,'20 мин'),
  makeRoute('r13', 'Горно-Алтайск → Чемал',         'Горно-Алтайск',          'Чемал',             511,  -434,'1.5 часа'),
  makeRoute('r14', 'Манжерок → Чемал',              'Манжерок',               'Чемал',             511,  -455,'1 час'),
  makeRoute('r15', 'Чемал → Телецкое озеро',        'Чемал',                  'Телецкое озеро',    511,  150, '3.5 часа'),
  makeRoute('r16', 'Кош-Агач → Джазатор',           'Кош-Агач',               'Джазатор',          893,  140, '3 часа (грунт)'),
  makeRoute('r17', 'Онгудай → Акташ',               'Онгудай',                'Акташ',             788,  -652,'3 часа'),
];

const SEED_DRIVERS = [
  { id: 'd1', name: 'Алексей Петров', phone: '+79031234567', car: 'Hyundai Solaris', year: 2021, color: 'Белый', rating: 4.8, orders_count: 124, photo_url: '/driver-alexey.jpg' },
  { id: 'd2', name: 'Иван Сидоров', phone: '+79032345678', car: 'Kia Rio', year: 2022, color: 'Серебристый', rating: 4.9, orders_count: 89, photo_url: '/driver-ivan.jpg' },
  { id: 'd3', name: 'Мария Иванова', phone: '+79033456789', car: 'Skoda Rapid', year: 2020, color: 'Чёрный', rating: 5.0, orders_count: 203, photo_url: '/driver-maria.jpg' },
  { id: 'd4', name: 'Нурбол Каирбеков', phone: '+79034567890', car: 'Toyota Camry', year: 2020, color: 'Серебристый', rating: 4.7, orders_count: 67, photo_url: '/driver-nurbol.jpg' },
  { id: 'd5', name: 'Ольга Петрова', phone: '+79035678901', car: 'Volkswagen Polo', year: 2022, color: 'Белый', rating: 4.9, orders_count: 112, photo_url: '/driver-olga.jpg' },
  { id: 'd6', name: 'Сергей Алтынбеков', phone: '+79036789012', car: 'UAZ Patriot', year: 2021, color: 'Зелёный', rating: 4.6, orders_count: 89, photo_url: '/driver-sergey.jpg' },
  { id: 'd7', name: 'Дмитрий Соколов', phone: '+79037890123', car: 'Skoda Octavia', year: 2023, color: 'Синий', rating: 5.0, orders_count: 45, photo_url: '/driver-dmitry.jpg' },
  { id: 'd8', name: 'Галина Морозова', phone: '+79038901234', car: 'Kia Rio X', year: 2022, color: 'Красный', rating: 4.8, orders_count: 78, photo_url: '/driver-galina.jpg' },
];

function init() {
  if (useSQLite) {
    // Routes table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        from_location TEXT NOT NULL,
        to_location TEXT NOT NULL,
        distance INTEGER,
        duration TEXT,
        price INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Drivers table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        car TEXT,
        year INTEGER,
        color TEXT,
        rating REAL DEFAULT 5.0,
        orders_count INTEGER DEFAULT 0,
        photo_url TEXT,
        is_active INTEGER DEFAULT 1,
        status TEXT DEFAULT 'ACTIVE',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Driver calendar table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS driver_calendar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id TEXT NOT NULL,
        date TEXT NOT NULL,
        is_busy INTEGER DEFAULT 1,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(driver_id, date)
      )
    `).run();

    // Orders table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        user_name TEXT,
        user_phone TEXT,
        route_id TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT,
        passengers INTEGER DEFAULT 1,
        price INTEGER NOT NULL,
        status TEXT DEFAULT 'PENDING',
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (route_id) REFERENCES routes(id),
        FOREIGN KEY (driver_id) REFERENCES drivers(id)
      )
    `).run();

    // Payments table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        status TEXT DEFAULT 'pending',
        paid INTEGER DEFAULT 0,
        amount_value TEXT,
        amount_currency TEXT DEFAULT 'RUB',
        description TEXT,
        payment_url TEXT,
        test INTEGER DEFAULT 1,
        event TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  }

  seed();
}

function seed() {
  if (useSQLite) {
    const routeCount = db.prepare('SELECT COUNT(*) as count FROM routes').get();
    if (routeCount.count === 0) {
      const insert = db.prepare(`
        INSERT INTO routes (id, name, from_location, to_location, distance, duration, price)
        VALUES (@id, @name, @from_location, @to_location, @distance, @duration, @price)
      `);
      for (const route of SEED_ROUTES) {
        insert.run(route);
      }
      console.log('[DB] Seeded 5 routes');
    }

    const driverCount = db.prepare('SELECT COUNT(*) as count FROM drivers').get();
    if (driverCount.count === 0) {
      const insert = db.prepare(`
        INSERT INTO drivers (id, name, phone, car, year, color, rating, orders_count, photo_url, status, is_active)
        VALUES (@id, @name, @phone, @car, @year, @color, @rating, @orders_count, @photo_url, 'ACTIVE', 1)
      `);
      for (const driver of SEED_DRIVERS) {
        insert.run(driver);
      }
      console.log('[DB] Seeded 8 drivers');
    }
  } else {
    // In-memory seed
    if (memoryDB.routes.length === 0) {
      memoryDB.routes = SEED_ROUTES.map(r => ({ ...r, created_at: new Date().toISOString() }));
      console.log('[DB] Seeded 5 routes (memory)');
    }
    if (memoryDB.drivers.length === 0) {
      memoryDB.drivers = SEED_DRIVERS.map(d => ({ ...d, is_active: 1, status: 'ACTIVE', created_at: new Date().toISOString() }));
      console.log('[DB] Seeded 8 drivers (memory)');
    }
  }
}

function getAllRoutes() {
  if (useSQLite) {
    return db.prepare('SELECT * FROM routes ORDER BY price ASC').all();
  }
  return [...memoryDB.routes].sort((a, b) => a.price - b.price);
}

function getAllDrivers() {
  if (useSQLite) {
    return db.prepare("SELECT * FROM drivers WHERE is_active = 1 AND status = 'ACTIVE' ORDER BY rating DESC").all();
  }
  return memoryDB.drivers.filter(d => d.is_active === 1 && d.status === 'ACTIVE').sort((a, b) => b.rating - a.rating);
}

function createOrder(orderData) {
  if (useSQLite) {
    const result = db.prepare(`
      INSERT INTO orders (user_id, user_name, user_phone, route_id, driver_id, date, time, passengers, price, status, comment)
      VALUES (@user_id, @user_name, @user_phone, @route_id, @driver_id, @date, @time, @passengers, @price, @status, @comment)
    `).run({
      user_id: orderData.user_id || '',
      user_name: orderData.user_name || null,
      user_phone: orderData.user_phone || null,
      route_id: orderData.route_id,
      driver_id: orderData.driver_id,
      date: orderData.date,
      time: orderData.time || null,
      passengers: orderData.passengers || 1,
      price: orderData.price,
      status: orderData.status || 'PENDING',
      comment: orderData.comment || null,
    });
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  }

  // In-memory
  const route = memoryDB.routes.find(r => r.id === orderData.route_id);
  const driver = memoryDB.drivers.find(d => d.id === orderData.driver_id);
  const order = {
    id: memoryDB.orderIdCounter++,
    user_id: orderData.user_id || '',
    user_name: orderData.user_name || null,
    user_phone: orderData.user_phone || null,
    route_id: orderData.route_id,
    driver_id: orderData.driver_id,
    date: orderData.date,
    time: orderData.time || null,
    passengers: orderData.passengers || 1,
    price: orderData.price,
    status: 'PENDING',
    comment: orderData.comment || null,
    created_at: new Date().toISOString(),
    route_name: route ? route.name : null,
    from_location: route ? route.from_location : null,
    to_location: route ? route.to_location : null,
    driver_name: driver ? driver.name : null,
    car: driver ? driver.car : null,
    driver_phone: driver ? driver.phone : null,
  };
  memoryDB.orders.push(order);
  return order;
}

function getOrdersByUserId(userId) {
  if (useSQLite) {
    return db.prepare(`
      SELECT o.*,
             r.name as route_name, r.from_location, r.to_location,
             d.name as driver_name, d.car, d.phone as driver_phone
      FROM orders o
      JOIN routes r ON o.route_id = r.id
      JOIN drivers d ON o.driver_id = d.id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
    `).all(userId);
  }
  return memoryDB.orders
    .filter(o => o.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getOrderById(id) {
  const numId = parseInt(id, 10);
  if (useSQLite) {
    return db.prepare(`
      SELECT o.*,
             r.name as route_name, r.from_location, r.to_location,
             d.name as driver_name, d.car, d.phone as driver_phone
      FROM orders o
      JOIN routes r ON o.route_id = r.id
      JOIN drivers d ON o.driver_id = d.id
      WHERE o.id = ?
    `).get(numId) || null;
  }
  return memoryDB.orders.find(o => o.id === numId) || null;
}

function getDriverOrders(driverId) {
  if (useSQLite) {
    return db.prepare(`
      SELECT o.*, r.name as route_name, r.from_location, r.to_location, o.user_name, o.user_phone
      FROM orders o
      JOIN routes r ON o.route_id = r.id
      WHERE o.driver_id = ?
      ORDER BY o.date DESC, o.time DESC
    `).all(driverId);
  }
  // In-memory fallback
  return memoryDB.orders
    .filter(o => o.driver_id === driverId)
    .map(o => {
      const route = memoryDB.routes.find(r => r.id === o.route_id);
      return {
        ...o,
        route_name: route ? route.name : null,
        from_location: route ? route.from_location : null,
        to_location: route ? route.to_location : null,
      };
    })
    .sort((a, b) => {
      const dateCmp = (b.date || '').localeCompare(a.date || '');
      if (dateCmp !== 0) return dateCmp;
      return (b.time || '').localeCompare(a.time || '');
    });
}

function updateOrderStatus(orderId, status) {
  const validStatuses = ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
  }

  if (useSQLite) {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
    return getOrderById(orderId);
  }

  // In-memory fallback
  const order = memoryDB.orders.find(o => o.id === parseInt(orderId, 10));
  if (!order) return null;
  order.status = status;
  return order;
}

function getDriverOrdersByDate(driverId, date) {
  if (useSQLite) {
    return db.prepare(`
      SELECT o.*, r.name as route_name, r.from_location, r.to_location, o.user_name, o.user_phone
      FROM orders o
      JOIN routes r ON o.route_id = r.id
      WHERE o.driver_id = ? AND o.date = ?
      ORDER BY o.time ASC
    `).all(driverId, date);
  }
  // In-memory fallback
  return memoryDB.orders
    .filter(o => o.driver_id === driverId && o.date === date)
    .map(o => {
      const route = memoryDB.routes.find(r => r.id === o.route_id);
      return {
        ...o,
        route_name: route ? route.name : null,
        from_location: route ? route.from_location : null,
        to_location: route ? route.to_location : null,
      };
    })
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

// ── Payments ─────────────────────────────────────────────────────────────────

function savePayment(paymentData) {
  if (!paymentData || !paymentData.id) {
    throw new Error('Payment data with id is required');
  }

  if (useSQLite) {
    const exists = db.prepare('SELECT 1 FROM payments WHERE id = ?').get(paymentData.id);
    if (exists) {
      db.prepare(`
        UPDATE payments
        SET order_id = ?, status = ?, paid = ?, amount_value = ?,
            amount_currency = ?, description = ?, payment_url = ?,
            test = ?, event = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        paymentData.order_id || null,
        paymentData.status || 'pending',
        paymentData.paid ? 1 : 0,
        paymentData.amount ? paymentData.amount.value : null,
        paymentData.amount ? paymentData.amount.currency : 'RUB',
        paymentData.description || null,
        paymentData.payment_url || paymentData.confirmation ? paymentData.confirmation.confirmation_url : null,
        paymentData.test ? 1 : 0,
        paymentData.event || null,
        paymentData.id
      );
    } else {
      db.prepare(`
        INSERT INTO payments (id, order_id, status, paid, amount_value, amount_currency,
                              description, payment_url, test, event)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        paymentData.id,
        paymentData.order_id || null,
        paymentData.status || 'pending',
        paymentData.paid ? 1 : 0,
        paymentData.amount ? paymentData.amount.value : null,
        paymentData.amount ? paymentData.amount.currency : 'RUB',
        paymentData.description || null,
        paymentData.payment_url || (paymentData.confirmation ? paymentData.confirmation.confirmation_url : null),
        paymentData.test ? 1 : 0,
        paymentData.event || null
      );
    }
    return paymentData.id;
  }

  // In-memory fallback
  const existingIndex = memoryDB.payments.findIndex(p => p.id === paymentData.id);
  const record = {
    id: paymentData.id,
    order_id: paymentData.order_id || null,
    status: paymentData.status || 'pending',
    paid: paymentData.paid ? true : false,
    amount_value: paymentData.amount ? paymentData.amount.value : null,
    amount_currency: paymentData.amount ? paymentData.amount.currency : 'RUB',
    description: paymentData.description || null,
    payment_url: paymentData.payment_url || (paymentData.confirmation ? paymentData.confirmation.confirmation_url : null),
    test: paymentData.test ? true : false,
    event: paymentData.event || null,
    created_at: paymentData.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    record.created_at = memoryDB.payments[existingIndex].created_at;
    memoryDB.payments[existingIndex] = record;
  } else {
    memoryDB.payments.push(record);
  }
  return paymentData.id;
}

function getPaymentById(paymentId) {
  if (!paymentId) return null;

  if (useSQLite) {
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) || null;
  }
  return memoryDB.payments.find(p => p.id === paymentId) || null;
}

function getPaymentByOrderId(orderId) {
  if (!orderId) return null;

  if (useSQLite) {
    return db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(String(orderId)) || null;
  }
  return memoryDB.payments
    .filter(p => p.order_id === String(orderId))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
}

// ── Driver Calendar CRUD ─────────────────────────────────────────────────────

function markDriverBusy(driverId, date, note) {
  if (!driverId || !date) {
    throw new Error('driverId and date are required');
  }

  if (useSQLite) {
    const stmt = db.prepare(`
      INSERT INTO driver_calendar (driver_id, date, is_busy, note)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(driver_id, date) DO UPDATE SET
        is_busy = 1,
        note = excluded.note,
        created_at = CURRENT_TIMESTAMP
    `);
    stmt.run(driverId, date, note || null);
    return { driver_id: driverId, date, is_busy: 1, note: note || null };
  }

  // In-memory fallback
  const existing = memoryDB.driverCalendar.find(
    c => c.driver_id === driverId && c.date === date
  );
  if (existing) {
    existing.is_busy = 1;
    existing.note = note || null;
    existing.created_at = new Date().toISOString();
  } else {
    memoryDB.driverCalendar.push({
      id: memoryDB.driverCalendar.length + 1,
      driver_id: driverId,
      date,
      is_busy: 1,
      note: note || null,
      created_at: new Date().toISOString(),
    });
  }
  return { driver_id: driverId, date, is_busy: 1, note: note || null };
}

function markDriverFree(driverId, date) {
  if (!driverId || !date) {
    throw new Error('driverId and date are required');
  }

  if (useSQLite) {
    db.prepare('DELETE FROM driver_calendar WHERE driver_id = ? AND date = ?').run(driverId, date);
    return { driver_id: driverId, date, is_busy: 0 };
  }

  // In-memory fallback
  const idx = memoryDB.driverCalendar.findIndex(
    c => c.driver_id === driverId && c.date === date
  );
  if (idx >= 0) {
    memoryDB.driverCalendar.splice(idx, 1);
  }
  return { driver_id: driverId, date, is_busy: 0 };
}

function getDriverCalendar(driverId, month) {
  if (!driverId || !month) {
    throw new Error('driverId and month are required');
  }

  if (useSQLite) {
    return db.prepare(`
      SELECT * FROM driver_calendar
      WHERE driver_id = ? AND date LIKE ?
      ORDER BY date ASC
    `).all(driverId, `${month}%`);
  }

  // In-memory fallback
  return memoryDB.driverCalendar
    .filter(c => c.driver_id === driverId && c.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function isDriverBusy(driverId, date) {
  if (!driverId || !date) {
    return false;
  }

  if (useSQLite) {
    const row = db.prepare('SELECT 1 FROM driver_calendar WHERE driver_id = ? AND date = ?').get(driverId, date);
    return !!row;
  }

  // In-memory fallback
  return memoryDB.driverCalendar.some(
    c => c.driver_id === driverId && c.date === date
  );
}

// ── Driver Registration ──────────────────────────────────────────────────────

function registerDriver(driverData) {
  if (!driverData || !driverData.name || !driverData.phone) {
    throw new Error('Name and phone are required');
  }

  const driverId = 'd' + (memoryDB.driverIdCounter++);

  const driver = {
    id: driverId,
    name: driverData.name,
    phone: driverData.phone,
    car: driverData.car || null,
    year: driverData.year || null,
    color: driverData.color || null,
    rating: 5.0,
    orders_count: 0,
    photo_url: null,
    is_active: 0,
    status: 'PENDING',
    created_at: new Date().toISOString(),
  };

  if (useSQLite) {
    db.prepare(`
      INSERT INTO drivers (id, name, phone, car, year, color, rating, orders_count, photo_url, is_active, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'PENDING')
    `).run(
      driver.id,
      driver.name,
      driver.phone,
      driver.car,
      driver.year,
      driver.color,
      driver.rating,
      driver.orders_count,
      driver.photo_url
    );
  } else {
    memoryDB.drivers.push({ ...driver });
  }

  return { driver_id: driverId, name: driverData.name, status: 'PENDING' };
}

// Auto-init on import
init();

module.exports = {
  init,
  seed,
  getAllRoutes,
  getAllDrivers,
  createOrder,
  getOrdersByUserId,
  getOrderById,
  getDriverOrders,
  updateOrderStatus,
  getDriverOrdersByDate,
  savePayment,
  getPaymentById,
  getPaymentByOrderId,
  markDriverBusy,
  markDriverFree,
  getDriverCalendar,
  isDriverBusy,
  registerDriver,
};
