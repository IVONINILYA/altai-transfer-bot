#!/usr/bin/env node

// ═══════════════════════════════════════════════════════════════
//  migrate.js — Миграция данных из SQLite (Bothost) → PostgreSQL (Cloud.ru)
//  Запуск: node migrate.js
//  Требует: DATABASE_PATH (SQLite), DATABASE_URL (PostgreSQL)
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────────
const SQLITE_PATH = process.env.DATABASE_PATH || './data/altai.db';
const PG_URL = process.env.DATABASE_URL; // postgresql://user:pass@host:port/db

if (!PG_URL) {
    console.error('[ERROR] DATABASE_URL не задан. Пример:');
    console.error('  export DATABASE_URL="postgresql://altai_user:password@cloud.ru_vm_ip:5432/altai_transfer"');
    process.exit(1);
}

// ── Parse PostgreSQL URL ───────────────────────────────────────
function parsePgUrl(url) {
    try {
        const parsed = new URL(url);
        return {
            host: parsed.hostname,
            port: parsed.port || 5432,
            database: parsed.pathname.slice(1),
            user: parsed.username,
            password: decodeURIComponent(parsed.password),
        };
    } catch (e) {
        console.error('[ERROR] Неверный формат DATABASE_URL:', e.message);
        process.exit(1);
    }
}

// ── Main ───────────────────────────────────────────────────────
async function migrate() {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║     🔄 Миграция: SQLite → PostgreSQL                    ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  SQLite:  ${SQLITE_PATH.padEnd(45)}║`);
    console.log(`║  PostgreSQL: ${PG_URL.replace(/:.*@/, ':***@').padEnd(42)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    // 1. Connect to SQLite
    console.log('[1/6] Подключение к SQLite...');
    let Database;
    try {
        Database = require('better-sqlite3');
    } catch (e) {
        console.error('[ERROR] better-sqlite3 не установлен. Установите:');
        console.error('  npm install better-sqlite3');
        process.exit(1);
    }

    if (!fs.existsSync(SQLITE_PATH)) {
        console.error(`[ERROR] SQLite файл не найден: ${SQLITE_PATH}`);
        console.error('  Убедитесь, что вы запускаете скрипт на Bothost сервере.');
        process.exit(1);
    }

    const sqlite = new Database(SQLITE_PATH);
    console.log('      ✅ SQLite подключен');

    // 2. Connect to PostgreSQL
    console.log('[2/6] Подключение к PostgreSQL...');
    const pgConfig = parsePgUrl(PG_URL);
    
    let pg;
    try {
        const { Client } = require('pg');
        pg = new Client({
            host: pgConfig.host,
            port: pgConfig.port,
            database: pgConfig.database,
            user: pgConfig.user,
            password: pgConfig.password,
            connectionTimeoutMillis: 10000,
        });
        await pg.connect();
        console.log('      ✅ PostgreSQL подключен');
    } catch (e) {
        console.error('[ERROR] Не удалось подключиться к PostgreSQL:', e.message);
        console.error('  Проверьте:');
        console.error('    1. Запущен ли PostgreSQL контейнер: docker compose ps');
        console.error('    2. Открыт ли порт 5432 (через SSH tunnel)');
        console.error('    3. Корректны ли логин/пароль');
        process.exit(1);
    }

    // 3. Verify schema exists
    console.log('[3/6] Проверка схемы PostgreSQL...');
    try {
        const tableCheck = await pg.query("SELECT to_regclass('public.routes')");
        if (tableCheck.rows[0].to_regclass === null) {
            console.error('[ERROR] Таблицы не найдены. Запустите init.sql сначала:');
            console.error('  cat init.sql | docker exec -i altai_postgres psql -U altai_user -d altai_transfer');
            process.exit(1);
        }
        console.log('      ✅ Схема проверена');
    } catch (e) {
        console.error('[ERROR] Ошибка проверки схемы:', e.message);
        process.exit(1);
    }

    // 4. Migrate Routes
    console.log('[4/6] Миграция маршрутов...');
    const routes = sqlite.prepare('SELECT * FROM routes').all();
    let routesMigrated = 0;
    for (const r of routes) {
        try {
            await pg.query(
                `INSERT INTO routes (id, name, from_location, to_location, distance, duration, price, is_active, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
                 ON CONFLICT (id) DO NOTHING`,
                [r.id, r.name, r.from_location, r.to_location, r.distance, r.duration, r.price, r.created_at]
            );
            routesMigrated++;
        } catch (e) {
            console.warn(`      ⚠️  Маршрут ${r.id} пропущен: ${e.message}`);
        }
    }
    console.log(`      ✅ Маршрутов перенесено: ${routesMigrated}/${routes.length}`);

    // 5. Migrate Drivers
    console.log('[5/6] Миграция водителей...');
    const drivers = sqlite.prepare('SELECT * FROM drivers').all();
    let driversMigrated = 0;
    for (const d of drivers) {
        try {
            await pg.query(
                `INSERT INTO drivers (id, name, phone, car, year, color, rating, orders_count, photo_url, is_active, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (id) DO NOTHING`,
                [d.id, d.name, d.phone, d.car, d.year, d.color, d.rating, d.orders_count, d.photo_url, d.is_active === 1, d.created_at]
            );
            driversMigrated++;
        } catch (e) {
            console.warn(`      ⚠️  Водитель ${d.id} пропущен: ${e.message}`);
        }
    }
    console.log(`      ✅ Водителей перенесено: ${driversMigrated}/${drivers.length}`);

    // 6. Migrate Orders (most important!)
    console.log('[6/6] Миграция заказов...');
    const orders = sqlite.prepare('SELECT * FROM orders').all();
    let ordersMigrated = 0;
    let ordersFailed = 0;
    
    for (const o of orders) {
        try {
            // Insert user if not exists
            if (o.user_id) {
                await pg.query(
                    `INSERT INTO users (telegram_id, first_name, created_at)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)
                     ON CONFLICT (telegram_id) DO NOTHING`,
                    [parseInt(o.user_id) || 0, o.user_name]
                );
            }

            // Insert order
            const result = await pg.query(
                `INSERT INTO orders (
                    user_id, user_name, user_phone, route_id, driver_id,
                    date, time, passengers, price, status, comment, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING id`,
                [
                    o.user_id ? String(o.user_id) : '0',
                    o.user_name,
                    o.user_phone,
                    o.route_id,
                    o.driver_id,
                    o.date,
                    o.time,
                    o.passengers || 1,
                    o.price,
                    o.status || 'PENDING',
                    o.comment,
                    o.created_at,
                ]
            );
            ordersMigrated++;
        } catch (e) {
            ordersFailed++;
            if (ordersFailed <= 5) {
                console.warn(`      ⚠️  Заказ #${o.id} пропущен: ${e.message}`);
            }
        }
    }
    console.log(`      ✅ Заказов перенесено: ${ordersMigrated}/${orders.length}`);
    if (ordersFailed > 0) {
        console.log(`      ⚠️  Пропущено с ошибками: ${ordersFailed}`);
    }

    // ── Summary ──────────────────────────────────────────────────
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║                 📊 Результат миграции                     ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Маршруты:   ${String(routesMigrated).padStart(5)} / ${String(routes.length).padEnd(25)}║`);
    console.log(`║  Водители:   ${String(driversMigrated).padStart(5)} / ${String(drivers.length).padEnd(25)}║`);
    console.log(`║  Заказы:     ${String(ordersMigrated).padStart(5)} / ${String(orders.length).padEnd(25)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  ✅ Миграция завершена!                                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Следующий шаг: Переключите Bothost на proxy-режим');
    console.log('  (см. bothost_proxy.js в плане миграции)');

    // Cleanup
    sqlite.close();
    await pg.end();
}

// ── Run ────────────────────────────────────────────────────────
migrate().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});
