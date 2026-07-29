-- ═══════════════════════════════════════════════════════════════
--  PostgreSQL init — Алтай Трансфер
--  Таблицы: users, drivers, routes, orders, payments, sessions
--  Запускается автоматически при первом старте контейнера
-- ═══════════════════════════════════════════════════════════════

-- ── Extensions ─────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users — данные пользователей из Telegram ───────────────────
CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    telegram_id     BIGINT NOT NULL UNIQUE,
    username        VARCHAR(255),
    first_name      VARCHAR(255),
    last_name       VARCHAR(255),
    photo_url       TEXT,
    phone           VARCHAR(20),
    language_code   VARCHAR(10) DEFAULT 'ru',
    is_bot          BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);

-- ── Drivers — водители трансферов ──────────────────────────────
CREATE TABLE IF NOT EXISTS drivers (
    id              VARCHAR(32) PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    phone           VARCHAR(20),
    car             VARCHAR(255),
    year            INTEGER,
    color           VARCHAR(50),
    rating          DECIMAL(2,1) DEFAULT 5.0,
    orders_count    INTEGER DEFAULT 0,
    photo_url       TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    telegram_id     BIGINT,
    bio             TEXT,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers(is_active);

-- ── Routes — маршруты трансферов ───────────────────────────────
CREATE TABLE IF NOT EXISTS routes (
    id              VARCHAR(32) PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    from_location   VARCHAR(255) NOT NULL,
    to_location     VARCHAR(255) NOT NULL,
    distance        INTEGER,        -- километры
    duration        VARCHAR(50),    -- текст "2 часа"
    price           INTEGER NOT NULL, -- базовая цена
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_routes_price ON routes(price);

-- ── Orders — заказы ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(telegram_id),
    user_name       VARCHAR(255),
    user_phone      VARCHAR(20),
    route_id        VARCHAR(32) NOT NULL REFERENCES routes(id),
    driver_id       VARCHAR(32) NOT NULL REFERENCES drivers(id),
    date            DATE NOT NULL,
    time            TIME,
    passengers      INTEGER DEFAULT 1,
    price           INTEGER NOT NULL,
    status          VARCHAR(20) DEFAULT 'PENDING',
    comment         TEXT,
    payment_status  VARCHAR(20) DEFAULT 'PENDING',  -- PENDING, PAID, REFUNDED, FAILED
    payment_id      VARCHAR(255),  -- ID платежа в ЮKassa
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT chk_status CHECK (status IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED')),
    CONSTRAINT chk_payment_status CHECK (payment_status IN ('PENDING', 'PAID', 'REFUNDED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(date);
CREATE INDEX IF NOT EXISTS idx_orders_driver_date ON orders(driver_id, date);

-- ── Order Status History — история изменений статусов ──────────
CREATE TABLE IF NOT EXISTS order_status_history (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    old_status      VARCHAR(20),
    new_status      VARCHAR(20) NOT NULL,
    changed_by      BIGINT,  -- telegram_id кто изменил
    reason          TEXT,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_status_history_order ON order_status_history(order_id);

-- ── Payments — платежи ЮKassa ──────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    yookassa_id     VARCHAR(255) NOT NULL UNIQUE,
    amount          DECIMAL(10,2) NOT NULL,
    currency        VARCHAR(3) DEFAULT 'RUB',
    status          VARCHAR(20) DEFAULT 'pending',
    payment_method  VARCHAR(50),
    paid_at         TIMESTAMPTZ,
    description     TEXT,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT chk_payment_status CHECK (status IN ('pending', 'waiting_for_capture', 'succeeded', 'canceled', 'refunded'))
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_yookassa ON payments(yookassa_id);

-- ── Sessions — сессии пользователей (Redis fallback) ───────────
CREATE TABLE IF NOT EXISTS sessions (
    id              VARCHAR(255) PRIMARY KEY,
    telegram_id     BIGINT NOT NULL,
    data            JSONB DEFAULT '{}',
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_telegram ON sessions(telegram_id);

-- ── API Keys — ключи для доступа с Bothost ─────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    key_hash        VARCHAR(255) NOT NULL UNIQUE,
    is_active       BOOLEAN DEFAULT TRUE,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════
--  SEED DATA — начальные данные (14 маршрутов + 3 водителя)
-- ═══════════════════════════════════════════════════════════════

-- Seed routes
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r1',  'Аэропорт → Горно-Алтайск',         'Аэропорт Горно-Алтайск', 'Горно-Алтайск',         5,   '15 мин',    500)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r2',  'Аэропорт → Манжерок',               'Аэропорт Горно-Алтайск', 'Манжерок',              50,  '45 мин',    1500)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r3',  'Аэропорт → Онгудай',                'Аэропорт Горно-Алтайск', 'Онгудай',               90,  '1.5 часа',  2700)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r4',  'Аэропорт → Чемал',                  'Аэропорт Горно-Алтайск', 'Чемал',                 120, '2 часа',    3600)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r5',  'Аэропорт → Усть-Кан',               'Аэропорт Горно-Алтайск', 'Усть-Кан',              140, '2 часа',    4200)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r6',  'Аэропорт → Усть-Кокса',             'Аэропорт Горно-Алтайск', 'Усть-Кокса',            180, '2.5 часа',  4500)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r7',  'Аэропорт → Кош-Агач',               'Аэропорт Горно-Алтайск', 'Кош-Агач',              200, '3 часа',    5000)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r8',  'Аэропорт → Акташ',                  'Аэропорт Горно-Алтайск', 'Акташ',                 220, '3.5 часа',  5500)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r9',  'Аэропорт → Улаган',                 'Аэропорт Горно-Алтайск', 'Улаган',                250, '4 часа',    6000)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r10', 'Аэропорт → Джазатор (Беляши)',      'Аэропорт Горно-Алтайск', 'Джазатор (Беляши)',     280, '4.5 часа',  6500)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r11', 'Аэропорт → Телецкое озеро',         'Аэропорт Горно-Алтайск', 'Телецкое озеро',        300, '5 часов',   7000)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r12', 'Горно-Алтайск → Телецкое озеро',    'Горно-Алтайск',          'Телецкое озеро',        290, '4.5 часа',  6500)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r13', 'Манжерок → Чемал',                  'Манжерок',               'Чемал',                 70,  '1 час',     2100)
ON CONFLICT (id) DO NOTHING;
INSERT INTO routes (id, name, from_location, to_location, distance, duration, price) VALUES
    ('r14', 'Чемал → Телецкое озеро',            'Чемал',                  'Телецкое озеро',        160, '3 часа',    3800)
ON CONFLICT (id) DO NOTHING;

-- Seed drivers
INSERT INTO drivers (id, name, phone, car, year, color, rating, orders_count, photo_url, is_active) VALUES
    ('d1', 'Алексей Петров',  '+79031234567', 'Hyundai Solaris', 2021, 'Белый',       4.8, 124, '/driver-alexey.jpg', TRUE)
ON CONFLICT (id) DO NOTHING;
INSERT INTO drivers (id, name, phone, car, year, color, rating, orders_count, photo_url, is_active) VALUES
    ('d2', 'Иван Сидоров',    '+79032345678', 'Kia Rio',         2022, 'Серебристый', 4.9, 89,  '/driver-ivan.jpg',   TRUE)
ON CONFLICT (id) DO NOTHING;
INSERT INTO drivers (id, name, phone, car, year, color, rating, orders_count, photo_url, is_active) VALUES
    ('d3', 'Мария Иванова',   '+79033456789', 'Skoda Rapid',     2020, 'Чёрный',      5.0, 203, '/driver-maria.jpg',  TRUE)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
--  FUNCTIONS & TRIGGERS
-- ═══════════════════════════════════════════════════════════════

-- Автоматическое обновление updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS tr_users_updated ON users;
CREATE TRIGGER tr_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS tr_drivers_updated ON drivers;
CREATE TRIGGER tr_drivers_updated BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS tr_orders_updated ON orders;
CREATE TRIGGER tr_orders_updated BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS tr_payments_updated ON payments;
CREATE TRIGGER tr_payments_updated BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Триггер: логирование изменения статуса заказа
CREATE OR REPLACE FUNCTION log_order_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, reason)
        VALUES (NEW.id, OLD.status, NEW.status, NULL, TG_ARGV[0]);
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS tr_order_status_log ON orders;
CREATE TRIGGER tr_order_status_log
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION log_order_status_change();

-- ═══════════════════════════════════════════════════════════════
--  VIEWS
-- ═══════════════════════════════════════════════════════════════

-- Сводка по заказам с деталями
CREATE OR REPLACE VIEW v_orders_detail AS
SELECT 
    o.id,
    o.user_id,
    o.user_name,
    o.user_phone,
    o.route_id,
    r.name AS route_name,
    r.from_location,
    r.to_location,
    o.driver_id,
    d.name AS driver_name,
    d.car AS driver_car,
    d.phone AS driver_phone,
    o.date,
    o.time,
    o.passengers,
    o.price,
    o.status,
    o.comment,
    o.payment_status,
    o.created_at,
    o.updated_at
FROM orders o
JOIN routes r ON o.route_id = r.id
JOIN drivers d ON o.driver_id = d.id;

-- Статистика водителя
CREATE OR REPLACE VIEW v_driver_stats AS
SELECT 
    d.id AS driver_id,
    d.name AS driver_name,
    COUNT(o.id) AS total_orders,
    COUNT(*) FILTER (WHERE o.status = 'COMPLETED') AS completed_orders,
    COUNT(*) FILTER (WHERE o.status = 'PENDING') AS pending_orders,
    COALESCE(SUM(o.price) FILTER (WHERE o.status = 'COMPLETED'), 0) AS total_earnings
FROM drivers d
LEFT JOIN orders o ON d.id = o.driver_id
WHERE d.is_active = TRUE
GROUP BY d.id, d.name;

-- Популярные маршруты
CREATE OR REPLACE VIEW v_popular_routes AS
SELECT 
    r.id,
    r.name,
    r.from_location,
    r.to_location,
    COUNT(o.id) AS order_count,
    COALESCE(SUM(o.price), 0) AS total_revenue
FROM routes r
LEFT JOIN orders o ON r.id = o.route_id
WHERE r.is_active = TRUE
GROUP BY r.id, r.name, r.from_location, r.to_location
ORDER BY order_count DESC;

-- Cleanup old sessions (cron job should call this)
CREATE OR REPLACE FUNCTION cleanup_old_sessions()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
