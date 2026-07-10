# Аудит безопасности "Алтай Трансфер"

**Дата аудита:** 2025-07-11
**Версия приложения:** 1.0.0 (Mini App v7)
**Аудитор:** Эксперт по информационной безопасности
**Объём кода проанализирован:** 2 backend (Node.js pure HTTP + FastAPI Python), 1 frontend (vanilla JS), 2 прокси (bothost), Docker-инфраструктура

---

## Содержание

1. [Текущая модель угроз (Threat Model)](#1-текущая-модель-угроз-threat-model)
2. [Анализ каждого компонента](#2-анализ-каждого-компонента)
3. [Найденные уязвимости](#3-найденные-уязвимости)
4. [Рекомендации (по приоритету)](#4-рекомендации-по-приоритету)
5. [Чеклист безопасности](#5-чеклист-безопасности)
6. [Соответствие стандартам](#6-соответствие-стандартам)
7. [Приложения](#7-приложения)

---

## 1. Текущая модель угроз (Threat Model)

### 1.1 Потенциальные атакующие

| Категория | Мотивация | Возможности |
|---|---|---|
| **Script Kiddies** | Дефейс, "приколы", бесплатные поездки | Публичные инструменты, брутфорс |
| **Конкуренты/мошенники** | Массовый фейковый дроп заказов, финансовый ущерб | Средние технические навыки, автоматизация |
| **Атакующий с доступом к утечке** | Использование утёкших токенов/паролей | Полный доступ к инфраструктуре |
| **Insider (админ/разработчик)** | Кража данных, финансовый ущерб | Полный доступ к системе |
| **Telegram-скамеры** | Фишинг через поддельные Mini App | Социальная инженерия |

### 1.2 Цели атаки

1. **Финансовые:** создать заказ без оплаты, получить возврат несуществующего платежа, заблокировать чужие заказы
2. **Данные:** утечка персональных данных пользователей (ФИО, телефон, TG ID), данных водителей
3. **Доступность:** DoS через переполнение заказами, блокировка водителей
4. **Репутационные:** дефейс Mini App, фейковые отзывы, ложные уведомления

### 1.3 Векторы атак на каждый компонент

```
User → Telegram → Mini App (bothost, SSL)
     → Bothost proxy → Cloud.ru VM (Nginx → FastAPI → PostgreSQL/Redis)
```

| Компонент | Векторы атак |
|---|---|
| **Mini App Frontend** | XSS через заказы, подделка initData (dev mode), CSRF через открытые endpoints |
| **Bothost Proxy** | Перехват трафика (если нет HTTPS), эксплуатация dev mode, Bot Token утечка |
| **Cloud.ru VM / Nginx** | DoS через rate limiting обход, информационные заголовки, конфигурационные ошибки |
| **FastAPI Backend** | Injection, неавторизованный доступ к API, переполнение загрузкой файлов |
| **PostgreSQL** | SQL-инъекция через непараметризованные запросы, доступ через сеть |
| **Redis** | Несанкционированный доступ, Command Injection |
| **ЮKassa Webhook** | Поддельные webhooks без проверки подписи, replay attacks |
| **Deploy Pipeline** | MITM при деплое, компрометация GitHub Secrets |

---

## 2. Анализ каждого компонента

### A. Аутентификация (Telegram initData)

#### Как работает HMAC-SHA256 валидация?

Правильная реализация в **`auth.js:44-65`**:

```javascript
// secret = HMAC_SHA256("WebAppData", botToken)
const secret = crypto
  .createHmac('sha256', 'WebAppData')
  .update(botToken)
  .digest();

// checkHash = HMAC_SHA256(secret, dataCheckString)
const checkHash = crypto
  .createHmac('sha256', secret)
  .update(dataCheckString)
  .digest('hex');

// Timing-safe comparison — КОРРЕКТНО
crypto.timingSafeEqual(checkHashBuf, hashBuf);
```

**Оценка:** Реализация корректна. Используется timing-safe сравнение (`crypto.timingSafeEqual`), правильный порядок сортировки параметров, корректный ключ `WebAppData`.

**auth_date проверка** (`auth.js:67-76`) — корректна:
```javascript
if (now - authTimestamp > oneDay) {
  return { valid: false, user: null };
}
```
Replay window = 24 часа — это стандартное значение.

#### Критический риск: Dev mode fallback

**`auth.js:15-16`**:
```javascript
if (!botToken || botToken === '') {
  return { valid: true, user: getUserFromInitData(initData) };
}
```

**`bothost_proxy.js:157-159`**:
```javascript
if (!botToken || botToken === '') {
    return { valid: true, user: null };
}
```

**`cloudru/api/main.py:88-90`**:
```python
if not BOT_TOKEN:
    return {"valid": True, "user": None}
```

**⚠️ УГРОЗА:** Если `BOT_TOKEN` не установлен в production, ЛЮБОЙ запрос проходит аутентификацию без проверки HMAC. Атакующий может сформировать любые `initData` с произвольным `user.id` и получить доступ ко всем заказам любого пользователя.

#### Неконсистентность: `getUserFromInitData` НЕ валидирует HMAC

**`auth.js:93-118`**: Функция `getUserFromInitData` просто парсит JSON из `initData` без какой-либо валидации HMAC:
```javascript
function getUserFromInitData(initData) {
  // ... нет вызова validateInitData!
  const user = JSON.parse(userRaw);
  return { id: user.id, ... };
}
```

Хотя в `app.js` валидация вызывается ДО `getUserFromInitData`, в **`bothost_proxy.js`** dev mode возвращает `user: null`, и Cloud.ru должен валидировать повторно. Двойная валидация — это хорошо, но несогласованность между компонентами создаёт путаницу.

#### FastAPI валидация: использует `compare_digest`

**`cloudru/api/main.py:110-122`**:
```python
secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
check_hash = hmac.new(secret, data_check_string.encode(), hashlib.sha256).hexdigest()
if not hmac.compare_digest(check_hash, received_hash):
    return {"valid": False, "user": None}
```

**Оценка:** Корректно. `hmac.compare_digest` — timing-safe сравнение.

---

### B. API Endpoints

#### Endpoints без аутентификации (КРИТИЧНО)

| Endpoint | Метод | Auth? | Риск |
|---|---|---|---|
| `/api/routes` | GET | ❌ Нет | Низкий (только публичные данные) |
| `/api/drivers` | GET | ❌ Нет | **Средний** — утечка телефонов водителей |
| `/api/orders` | POST | ✅ initData | Корректно |
| `/api/orders` | GET | ✅ initData | Корректно |
| `/api/orders/:id` | GET | ❌ Нет | **Высокий** — IDOR, можно смотреть чужие заказы |
| `/api/driver/orders` | GET | ❌ Нет | **Высокий** — можно получить заказы любого водителя |
| `/api/driver/orders/:id/status` | POST | ❌ Нет | **КРИТИЧНЫЙ** — можно менять статус ЛЮБОГО заказа |
| `/api/driver/calendar` | GET/POST/DELETE | ❌ Нет | **Средний** — можно читать/менять календарь |
| `/api/drivers/register` | POST | ❌ Нет | Низкий |
| `/api/payments/create` | POST | ❌ Нет | **КРИТИЧНЫЙ** — создание платежей без авторизации |
| `/api/payments/simulate` | POST | ❌ Нет | **КРИТИЧНЫЙ** — симуляция платежа без авторизации |
| `/api/payments/test-cards` | GET | ❌ Нет | Низкий |
| `/api/payments/:id/status` | GET | ❌ Нет | **Средний** — можно проверять чужие платежи |
| `/api/payments/webhook` | POST | ❌ Нет | Требуется подпись ЮKassa (см. раздел E) |
| `/api/health` | GET | ❌ Нет | **Средний** — раскрывает mode, shopId |
| `/deploy` | POST | ✅ BOTHOST_TOKEN | Корректно |

#### Подробный разбор критических endpoint'ов

**1. `GET /api/orders/:id` — IDOR (Insecure Direct Object Reference)**

**`app.js:208-223`**:
```javascript
function handleGetOrderById(req, res, id) {
  const order = database.getOrderById(id); // Нет проверки: заказ этого пользователя?
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(order));
}
```

Атакующий может перебирать ID (`1`, `2`, `3`...) и получить все заказы всех пользователей с полной информацией: ФИО, телефон, маршрут, водитель, цена.

**2. `POST /api/driver/orders/:id/status` — Unauthorized Status Change**

**`app.js:395-427`**:
```javascript
function handleUpdateOrderStatus(req, res, orderId) {
  // Нет проверки: водитель ли обновляет СВОЙ заказ?
  const order = database.updateOrderStatus(orderId, status);
}
```

Любой может отменить ЛЮБОЙ заказ, зная его ID. Подтвердить, отменить, завершить — любой статус.

**3. `POST /api/payments/create` — Unauthorized Payment Creation**

**`app.js:236-282`**:
```javascript
function handleCreatePayment(req, res) {
  // НЕТ проверки initData!
  // НЕТ проверки: заказ принадлежит этому пользователю?
  payment.createPayment(orderId, amount, description, returnUrl)
}
```

Атакующий может создать платёж для любого заказа. С `simulateMockPayment` — сразу "оплатить" его.

**4. `POST /api/payments/simulate` — Mock Payment Manipulation**

**`app.js:657-674`**:
```javascript
if (pathname === '/api/payments/simulate' && req.method === 'POST') {
  const result = payment.simulateMockPayment(data.payment_id, data.success !== false);
}
```

Доступен всем! В production с `YOOKASSA_SHOP_ID` не установлен — это позволит "оплатить" любой заказ.

#### Rate Limiting

**Nginx (`cloudru/nginx.conf:46-48`)**:
```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=orders:10m rate=10r/m;
```

**Оценка:** Недостаточно.
- `30r/m` = 1 запрос в 2 секунды — можно обойти с паттерном
- `orders:10r/m` — не применяется к `/api/orders/:id/status` (нет location match)
- Нет rate limiting на `/api/payments/create` — можно создавать бесконечное количество платежей
- Нет IP-allowlist для webhook endpoint

#### SQL Injection

**SQLite (`database.js`)**:

Все запросы используют prepared statements (`db.prepare`). НО:

**`database.js:343-352`**:
```javascript
function updateOrderStatus(orderId, status) {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
}
```

`orderId` передаётся как строка без проверки типа. Хотя better-sqlite3 защищает от инъекции через prepared statement, `orderId` может содержать неожиданные значения. В in-memory fallback (`database.js:355`) используется `parseInt(orderId, 10)` — корректно.

**`database.js:542-553`**:
```javascript
function getDriverCalendar(driverId, month) {
  return db.prepare(`
    SELECT * FROM driver_calendar
    WHERE driver_id = ? AND date LIKE ?
  `).all(driverId, `${month}%`);
}
```

`month` не валидируется на формат `YYYY-MM`. Атакующий может передать `month='2025-%' OR '1'='1'` — но так как используется prepared statement, инъекция невозможна.

**PostgreSQL (`cloudru/api/main.py`)**:

Все запросы используют `$1, $2` параметризацию — **SQL-инъекция невозможна**.

**FastAPI Pydantic валидация (`cloudru/api/main.py:201-203`)**:
```python
class OrderStatusUpdate(BaseModel):
    status: str = Field(..., pattern=r"^(PENDING|CONFIRMED|COMPLETED|CANCELLED)$")
```

Отлично — статус валидируется через регулярное выражение.

#### XSS (Cross-Site Scripting)

**Frontend — `script.js`**:

Функция `esc()` (`script.js:969`) корректно экранирует:
```javascript
function esc(t) { 
  var d = document.createElement('div'); 
  d.textContent = String(t); 
  return d.innerHTML; 
}
```

Все динамические вставки используют `esc()` — **XSS через отображение данных защищён**.

**НО:** `innerHTML` используется напрямую в некоторых местах:
- `script.js:371-372`:
```javascript
s.innerHTML = '<div class="order-summary-route">'+esc(route.name)+'</div>'+
  '<div class="order-summary-price">'+fp(route.price)+' ₽</div>';
```
`esc()` вызывается — безопасно.

**Backend — `database.js:267-276`** (in-memory):
```javascript
return {
  route_name: route ? route.name : null,
  driver_name: driver ? driver.name : null,
  driver_phone: driver ? driver.phone : null,
};
```

Данные возвращаются "как есть" из БД. Если бы в БД были XSS-полезные нагрузки — они бы попали в ответ. Но prepared statements предотвращают SQL-based XSS.

#### CSRF (Cross-Site Request Forgery)

**`app.js:35-38`**:
```javascript
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
```

**`cloudru/api/main.py:264-269`**:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
)
```

**⚠️ УГРОЗА:** CORS `*` позволяет любому сайту делать запросы к API. Хотя для Telegram Mini App это упрощает интеграцию, в сочетании с отсутствием CSRF-токенов и открытыми endpoint'ами (driver orders, payment create) это создаёт серьёзный риск:

1. Пользователь залогинен в Mini App (initData валиден)
2. Пользователь открывает вредоносный сайт
3. Сайт делает `fetch('https://altaitransfer.bothost.tech/api/payments/create', ...)` и создаёт платёж
4. Платёж проходит без дополнительной проверки

**Telegram initData защищает от CSRF** для endpoint'ов, которые его проверяют. Но endpoint'ы БЕЗ auth (driver status, payment create) уязвимы.

---

### C. База данных

#### PostgreSQL (Cloud.ru)

**Доступ** (`cloudru/docker-compose.yml:14`):
```yaml
ports:
  - "127.0.0.1:5432:5432"
```

✅ PostgreSQL доступен ТОЛЬКО с localhost. Docker network изолирует контейнеры. Внешний доступ невозможен напрямую.

**Redis** (`cloudru/docker-compose.yml:31-32`):
```yaml
ports:
  - "127.0.0.1:6379:6379"
```

✅ Redis с паролем (`--requirepass ${REDIS_PASSWORD}`) и maxmemory policy.

**API Backend** (`cloudru/docker-compose.yml:72`):
```yaml
ports:
  - "127.0.0.1:8000:8000"
```

✅ FastAPI доступен только через Nginx (reverse proxy).

#### Пароли

**`.env.example`**:
```bash
DB_PASSWORD=your_secure_password_here
REDIS_PASSWORD=your_redis_password_here
BOT_TOKEN=1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ
API_KEY=your_random_api_key_32_chars_min
YOOKASSA_SECRET_KEY=live_your_secret_key
```

**⚠️ УГРОЗА:** Все секреты в одном `.env` файле. Нет интеграции с:
- HashiCorp Vault
- AWS Secrets Manager / Yandex Lockbox
- Docker Secrets (swarm mode)
- Cloud.ru Secret Manager

#### Шифрование данных

**PostgreSQL**:
- Телефоны пользователей (`users.phone`, `orders.user_phone`) — **НЕ зашифрованы**
- ФИО пользователей (`orders.user_name`) — **НЕ зашифрованы**
- Telegram ID (`users.telegram_id`) — **НЕ зашифрованы**
- ЮKassa ID (`payments.yookassa_id`) — **НЕ зашифрованы**

Расширение `pgcrypto` установлено (`init.sql:9`), но не используется для шифрования данных.

#### Backup

**Нет механизма backup'ов в коде!** Только Docker volume:
```yaml
volumes:
  - postgres_data:/var/lib/postgresql/data
```

**Риск:** При потере VM данные теряются безвозвратно (если нет внешнего backup'а Cloud.ru).

#### SQLite (Bothost fallback)

**`database.js:4`**:
```javascript
const DATABASE_PATH = process.env.DATABASE_PATH || './data/altai.db';
```

Файл SQLite создаётся с правами текущего пользователя. Если приложение запущено от root — файл доступен любому процессу на сервере.

---

### D. Инфраструктура

#### Docker

**API Dockerfile (`cloudru/api/Dockerfile:28-30`)**:
```dockerfile
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser
```

✅ FastAPI запускается от не-root пользователя (`appuser`, UID 1000).

**НО**:
- **Nginx** (`cloudru/docker-compose.yml:80-82`) — образ `nginx:alpine` запускается от `nginx` пользователя внутри контейнера — корректно.
- **PostgreSQL** — запускается от `postgres` пользователя — корректно.
- **Redis** — запускается от `redis` пользователя — корректно.
- **Node.js (bothost)** — неизвестно, от кого запускается (bothost hosting).

#### Nginx — информационные заголовки

**`cloudru/nginx.conf:75-78`**:
```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

✅ Security headers настроены.

**Отсутствуют**:
```nginx
# Нет Strict-Transport-Security (HTTPS ещё не включён)
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# Нет Content-Security-Policy
add_header Content-Policy "default-src 'self'; script-src 'self' https://telegram.org" always;

# Server tokens не отключены
server_tokens off;
```

#### SSL/TLS

**`cloudru/nginx.conf:57-60`**:
```nginx
server {
    listen 80;
    server_name _;
```

**⚠️ УГРОЗА:** В настоящий момент только HTTP (порт 80). HTTPS закомментирован:
```nginx
#    server {
#        listen 443 ssl;
#        ...
#    }
```

Трафик between User ↔ Nginx передаётся в открытом виде. Bothost (nl7.bothost.ru) может иметь SSL, но Cloud.ru VM (84.54.59.43) — нет.

#### Firewall — порты

| Порт | Сервис | Доступ | Оценка |
|---|---|---|---|
| 80 | Nginx | 0.0.0.0 | ✅ Необходим |
| 443 | Nginx (SSL) | — | ⚠️ Не настроен |
| 8000 | FastAPI | 127.0.0.1 | ✅ Корректно |
| 5432 | PostgreSQL | 127.0.0.1 | ✅ Корректно |
| 6379 | Redis | 127.0.0.1 | ✅ Корректно |
| 3000 | Node.js (bothost) | ? | ⚠️ Неизвестно |

**Рекомендация:** Убедиться, что порты 5432, 6379, 8000 НЕ открыты через `ufw`/`iptables` наружу.

---

### E. Платежи (ЮKassa)

#### Webhook подпись — НЕ проверяется

**`payment.js:306-369`**:
```javascript
function handleWebhook(body) {
  const event = body.event;
  const object = body.object;
  const paymentId = object.id;
  // ... НЕТ проверки подписи webhook'а!
  database.savePayment({...});
  database.updateOrderStatus(orderId, status === 'succeeded' ? 'CONFIRMED' : 'CANCELLED');
}
```

**`app.js:284-312`**:
```javascript
function handlePaymentWebhook(req, res) {
  const result = payment.handleWebhook(body);
  res.writeHead(200);
  res.end(JSON.stringify({ received: true }));
}
```

**`cloudru/api/main.py:670-724`**:
```python
@app.post("/api/payments/webhook")
async def payment_webhook(data: dict):
    event = data.get("event", "")
    payment_obj = data.get("object", {})
    # ... НЕТ проверки подписи!
```

**⚠️ КРИТИЧНАЯ УЯЗВИМОСТЬ:** Любой может отправить POST-запрос на `/api/payments/webhook` с поддельным `payment.succeeded` событием и "оплатить" любой заказ!

ЮKassa предоставляет механизм проверки подписи через:
1. IP-allowlist webhook'ов (нестабильно)
2. Секретный ключ для подписи payload (нестандартно для ЮKassa)
3. Проверка `notification_secret` из личного кабинета

**Минимальная защита:** Проверка IP-адреса источника:
```javascript
const allowedIps = ['185.71.76.0/27', '77.75.153.0/25', '77.75.156.11', ...];
```

#### Race condition при создании платежа

**`app.js:236-282`**:
```javascript
function handleCreatePayment(req, res) {
  // Нет проверки: уже есть активный платёж для этого заказа?
  payment.createPayment(orderId, amount, description, returnUrl)
}
```

**`payment.js:178-241`**:
```javascript
async function createPayment(orderId, amount, description, returnUrl) {
  // Нет атомарной проверки существующего платежа
  // Каждый вызов генерирует новый UUID:
  const idempotenceKey = generateUUID(); // СЛУЧАЙНЫЙ каждый раз!
}
```

Два параллельных запроса могут создать два платежа для одного заказа. Idempotence-Key генерируется случайно и не связан с `orderId`.

**Корректный подход**:
```javascript
const idempotenceKey = crypto.createHash('sha256')
  .update(`payment_${orderId}_${Date.now().toISOString().slice(0,10)}`)
  .digest('hex');
```

#### Проверка "уже оплачен" — только в FastAPI

**`cloudru/api/main.py:584-585`**:
```python
if order["payment_status"] == "PAID":
    raise HTTPException(status_code=400, detail="Order already paid")
```

✅ В FastAPI-версии есть проверка. **НО в Node.js версии (`app.js`) такой проверки НЕТ**.

---

### F. Telegram Bot

#### Токен хранится в .env

**`app.js:14`**:
```javascript
const BOT_TOKEN = process.env.BOT_TOKEN || '';
```

**`cloudru/api/main.py:25`**:
```python
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
```

**⚠️ РИСК:**
- `.env` файл может случайно попасть в git (если нет `.gitignore`)
- Токен виден в процесс-листинге (`ps aux`)
- Токен логируется при старте (см. `app.js:723` — только тип аутентификации, не сам токен — ОК)

#### Доступ к @BotFather

Не контролируется кодом. **Рекомендация:**
1. Двухфакторная аутентификация на Telegram-аккаунте владельца бота
2. Минимум людей с доступом к @BotFather
3. Audit log изменений бота (через BotFather → /mybots → Bot Settings)

#### Webhook URL

**`bothost_proxy.js:271-286`**:
```javascript
if (pathname === '/webhook' && req.method === 'POST') {
  // Telegram webhook → Proxy to Cloud.ru
  const result = await proxyToCloud(req, rawBody, '/api/webhook');
}
```

Webhook доступен на `/webhook`. Запрос от Telegram проксируется на Cloud.ru. **Webhook URL должен быть установлен через BotFather с HTTPS.**

---

## 3. Найденные уязвимости

| # | Уязвимость | Серьёзность | Компонент | Описание | Строки кода |
|---|-----------|-------------|-----------|----------|------------|
| V1 | **Broken Access Control** | 🔴 **Критическая** | `app.js` | `POST /api/driver/orders/:id/status` — любой может менять статус ЛЮБОГО заказа без аутентификации | `app.js:395-427` |
| V2 | **IDOR (Insecure Direct Object Reference)** | 🔴 **Критическая** | `app.js` | `GET /api/orders/:id` — можно просматривать чужие заказы по ID без авторизации | `app.js:208-223` |
| V3 | **Unauthorized Payment Creation** | 🔴 **Критическая** | `app.js` | `POST /api/payments/create` — создание платежей без проверки initData | `app.js:236-282` |
| V4 | **Payment Simulation Bypass** | 🔴 **Критическая** | `app.js` | `POST /api/payments/simulate` — доступен всем, позволяет "оплатить" любой заказ | `app.js:657-674` |
| V5 | **Webhook Signature Not Verified** | 🔴 **Критическая** | `payment.js`, `cloudru/api/main.py` | `POST /api/payments/webhook` — не проверяется подпись ЮKassa. Любой может отправить фейковый webhook | `payment.js:306-369`, `main.py:670-724` |
| V6 | **Dev Mode Auth Bypass** | 🟠 **Высокая** | `auth.js`, `bothost_proxy.js`, `main.py` | Если `BOT_TOKEN` не установлен — ВСЕ запросы проходят аутентификацию | `auth.js:15-16`, `bothost_proxy.js:157-159`, `main.py:88-90` |
| V7 | **Driver Data Leak** | 🟠 **Высокая** | `app.js` | `GET /api/drivers` — возвращает телефоны водителей без авторизации | `app.js:108-118`, `database.js:78-87` |
| V8 | **Driver Orders Leak** | 🟠 **Высокая** | `app.js` | `GET /api/driver/orders?driver_id=X` — получение всех заказов любого водителя | `app.js:363-393` |
| V9 | **Calendar Manipulation** | 🟠 **Высокая** | `app.js` | `POST/DELETE /api/driver/calendar` — изменение календаря без авторизации | `app.js:457-513` |
| V10 | **Information Disclosure** | 🟡 **Средняя** | `app.js` | `GET /api/health` — раскрывает payment mode и shopId | `app.js:225-232` |
| V11 | **Race Condition (Payment)** | 🟡 **Средняя** | `payment.js` | Нет атомарной проверки существующего платежа. Idempotence-Key случайный | `payment.js:44-67`, `178-241` |
| V12 | **Missing CSRF Protection** | 🟡 **Средняя** | `app.js`, `main.py` | CORS `*` + нет CSRF токенов для открытых endpoint'ов | `app.js:35-38`, `main.py:264-269` |
| V13 | **No HTTPS** | 🟡 **Средняя** | `nginx.conf` | Только HTTP (порт 80), HTTPS закомментирован | `nginx.conf:57-60` |
| V14 | **Secrets in .env** | 🟡 **Средняя** | `.env.example` | Все секреты в одном файле без интеграции с Vault/Secrets Manager | `.env.example:6-27` |
| V15 | **No Data Encryption** | 🟡 **Средняя** | `init.sql` | Персональные данные (ФИО, телефоны, TG ID) хранятся в открытом виде | `init.sql:12-44` |
| V16 | **No Backup Strategy** | 🟡 **Средняя** | `docker-compose.yml` | Только Docker volume, нет автоматических backup'ов | `docker-compose.yml:101-103` |
| V17 | **Server Tokens Exposed** | 🟢 **Низкая** | `nginx.conf` | `server_tokens off` не установлен | `nginx.conf` (отсутствует) |
| V18 | **No CSP Header** | 🟢 **Низкая** | `nginx.conf` | Отсутствует Content-Security-Policy | `nginx.conf` (отсутствует) |

---

## 4. Рекомендации (по приоритету)

### P0 — Критические (исправить ДО production)

| Приоритет | Рекомендация | Сложность | Влияние | Как реализовать |
|---|---|---|---|---|
| **P0** | Добавить auth проверку в `POST /api/payments/create` | Низкая | Критическая | Добавить `auth.validateInitData(data.initData, BOT_TOKEN)` перед созданием платежа, проверить что заказ принадлежит пользователю |
| **P0** | Добавить auth проверку в `POST /api/driver/orders/:id/status` | Низкая | Критическая | Проверять initData + проверить что order.driver_id соответствует авторизованному водителю |
| **P0** | Удалить/защитить `POST /api/payments/simulate` | Низкая | Критическая | Проверять `IS_TEST_MODE && !YOOKASSA_SHOP_ID` + добавить auth. Лучше — удалить endpoint из production |
| **P0** | Добавить проверку подписи webhook'а ЮKassa | Средня | Критическая | Сохранить IP-allowlist ЮKassa (`185.71.76.0/27`, `77.75.153.0/25`, `77.75.156.11`). Проверять `X-Forwarded-For` или source IP. В идеале — проверка `notification_secret` |
| **P0** | Добавить auth в `GET /api/orders/:id` | Низкая | Высокая | Проверять initData + сравнивать user_id с order.user_id |

### P1 — Высокие (исправить в течение 1 недели)

| Приоритет | Рекомендация | Сложность | Влияние | Как реализовать |
|---|---|---|---|---|
| **P1** | Заблокировать dev mode fallback в production | Низкая | Высокая | Добавить `process.env.NODE_ENV === 'production'` — если production и нет BOT_TOKEN, кидать fatal error и завершать процесс |
| **P1** | Добавить auth в driver endpoints | Низкая | Высокая | `GET /api/driver/orders`, `GET/POST/DELETE /api/driver/calendar` — проверять initData или API key |
| **P1** | Скрыть телефоны водителей в публичном API | Низкая | Высокая | В `GET /api/drivers` исключить поле `phone` из ответа |
| **P1** | Атомарная проверка платежа | Средня | Высокая | `UPSERT` с проверкой `payment_status != 'PAID'`. Использовать `order_id`-based Idempotence-Key |
| **P1** | Добавить rate limiting на payment endpoints | Низкая | Средня | `limit_req_zone` для `/api/payments/*` в nginx.conf: `rate=5r/m` |

### P2 — Средние (исправить в течение 1 месяца)

| Приоритет | Рекомендация | Сложность | Влияние | Как реализовать |
|---|---|---|---|---|
| **P2** | Включить HTTPS на Cloud.ru VM | Средня | Высокая | Раскомментировать SSL блок в `nginx.conf`, получить сертификат Let's Encrypt |
| **P2** | Добавить `server_tokens off` | Низкая | Низкая | `server_tokens off;` в `nginx.conf` |
| **P2** | Добавить HSTS header | Низкая | Средняя | `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;` |
| **P2** | Добавить CSP header | Средня | Средняя | `add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://telegram.org" always;` |
| **P2** | Ограничить CORS | Низкая | Средняя | Вместо `*` — `allow_origins=["https://*.telegram.org", "https://web.telegram.org"]` |
| **P2** | Шифрование чувствительных данных | Средня | Средняя | Использовать `pgcrypto` для шифрования phone/user_name AES-256 |
| **P2** | Автоматические backup'ы | Средня | Высокая | `pg_dump` через cron + загрузка в Cloud.ru Object Storage |
| **P2** | Вынести секреты в Vault | Средня | Средняя | Cloud.ru Secret Manager или HashiCorp Vault |
| **P2** | Добавить input validation | Низкая | Средняя | Валидировать формат `date` (YYYY-MM-DD), `month` (YYYY-MM), `driver_id` (префикс 'd') |

### P3 — Низкие (улучшения)

| Приоритет | Рекомендация | Сложность | Влияние | Как реализовать |
|---|---|---|---|---|
| **P3** | Audit log | Средня | Низкая | Логировать все изменения статусов заказов с telegram_id пользователя |
| **P3** | Alerting | Средня | Низкая | Уведомления при аномалиях (>10 заказов/мин, поддельные webhooks) |
| **P3** | Dependency scanning | Низкая | Низкая | `npm audit` + `pip safety check` в CI/CD |
| **P3** | WAF (Web Application Firewall) | Высокая | Средняя | Cloud.ru WAF или ModSecurity для Nginx |

---

## 5. Чеклист безопасности (перед production launch)

### 🔴 Блокеры (Must Have)

- [ ] **V1** — `POST /api/driver/orders/:id/status` защищён авторизацией
- [ ] **V2** — `GET /api/orders/:id` проверяет принадлежность заказа
- [ ] **V3** — `POST /api/payments/create` проверяет initData и ownership заказа
- [ ] **V4** — `POST /api/payments/simulate` удалён или защищён
- [ ] **V5** — Webhook проверяет IP/source (минимум) или подпись ЮKassa
- [ ] **V6** — Dev mode fallback вызывает `process.exit(1)` в production
- [ ] **BOT_TOKEN** установлен в production
- [ ] **HTTPS** включён на Cloud.ru VM

### 🟠 Критические (Should Have — 1 неделя)

- [ ] **V7** — Телефоны водителей скрыты из публичного API
- [ ] **V8** — `GET /api/driver/orders` защищён авторизацией
- [ ] **V9** — `POST/DELETE /api/driver/calendar` защищены авторизацией
- [ ] **V10** — `/api/health` не раскрывает payment info в production
- [ ] **V11** — Race condition при создании платежа устранён
- [ ] Rate limiting на `/api/payments/*` настроен (5r/m)
- [ ] CORS ограничен (не `*`)

### 🟡 Важные (Nice to Have — 1 месяц)

- [ ] **V13** — HTTPS с валидным SSL-сертификатом
- [ ] **V14** — Секреты вынесены из `.env` в Secrets Manager
- [ ] **V15** — Персональные данные зашифрованы в БД
- [ ] **V16** — Автоматические backup'ы настроены
- [ ] **V17** — `server_tokens off` в Nginx
- [ ] **V18** — CSP header добавлен
- [ ] Security headers: HSTS, X-Content-Type-Options, X-Frame-Options
- [ ] Input validation на всех endpoint'ах
- [ ] Audit log для критичных операций

### 🟢 Мониторинг

- [ ] Логирование ошибок аутентификации ( failed initData )
- [ ] Алёртинг на подозрительную активность (brute-force, поддельные webhooks)
- [ ] Мониторинг доступности (health checks)
- [ ] Регулярное обновление зависимостей (`npm audit`, `pip safety`)

---

## 6. Соответствие стандартам

### OWASP Top 10 (2021)

| # | Категория OWASP | Статус | Уязвимости |
|---|---|---|---|
| A01 | **Broken Access Control** | 🔴 Не соответствует | V1, V2, V3, V4, V8, V9 |
| A02 | **Cryptographic Failures** | 🟠 Частично | V6, V13, V14, V15 |
| A03 | **Injection** | 🟡 Риск есть | Prepared statements используются, но input validation слабый |
| A04 | **Insecure Design** | 🔴 Не соответствует | V5, V11, V16 — отсутствие проверки webhook'ов, race conditions, нет backup'ов |
| A05 | **Security Misconfiguration** | 🟠 Частично | V6, V10, V13, V17, V18 — dev mode, exposed headers, no HTTPS |
| A06 | **Vulnerable and Outdated Components** | 🟡 Не проверено | Нет `npm audit` / `pip safety` в CI/CD |
| A07 | **Identification and Authentication Failures** | 🔴 Не соответствует | V6 — dev mode bypasses ALL auth |
| A08 | **Software and Data Integrity Failures** | 🔴 Не соответствует | V5 — webhook signature not verified |
| A09 | **Security Logging and Monitoring Failures** | 🟠 Частично | Есть логи в console, но нет структурированного аудита и алёртинга |
| A10 | **Server-Side Request Forgery (SSRF)** | 🟡 Риск есть | Bothost proxy перенаправляет запросы на Cloud.ru — потенциальная атака через поддельные URL |

### 152-ФЗ "О персональных данных"

| Требование | Статус | Комментарий |
|---|---|---|
| **Обработка с согласия** | 🟡 Не реализовано | Нет механизма получения согласия на обработку ПДн |
| **Запись ПДн в БД** | 🟠 Частично | ФИО, телефон, TG ID хранятся без шифрования |
| **Право на удаление** | 🔴 Не реализовано | Нет endpoint'а для удаления аккаунта и данных пользователя |
| **Соглашение об обработке ПДн** | 🔴 Не реализовано | Нет privacy policy / terms of service |
| **Назначение ответственного** | N/A | Вне рамок кода |
| **Уведомление Роскомнадзора** | N/A | Если > 100 000 субъектов ПДн — требуется |

**Заключение по 152-ФЗ:** Приложение обрабатывает персональные данные (ФИО, телефон, Telegram ID) и платёжную информацию. Для полного соответствия необходимо:
1. Добавить согласие на обработку ПДн в UI
2. Зашифровать чувствительные данные
3. Добавить endpoint удаления аккаунта
4. Написать privacy policy

---

## 7. Приложения

### Приложение А: Быстрые фиксы (patch'и)

#### A.1 — Базовая защита endpoint'ов (Node.js)

```javascript
// middleware.js — добавить в app.js

function requireAuth(req, res, callback) {
  parseJsonBody(req, (err, data) => {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    const initData = data.initData || '';
    const validation = auth.validateInitData(initData, BOT_TOKEN);
    if (!validation.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    callback(data, validation.user);
  });
}

// Для driver endpoints — проверка driver_id
function requireDriverAuth(req, res, driverId, callback) {
  // В реальном приложении — проверка через JWT или Telegram auth + driver binding
  if (!driverId || !driverId.startsWith('d')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid driver_id' }));
    return;
  }
  callback();
}
```

#### A.2 — Проверка webhook IP

```javascript
// payment.js — добавить в handleWebhook

const YOOKASSA_IP_RANGES = [
  '185.71.76.0/27',
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '2a02:5180::/32',  // IPv6
];

function isYookassaIp(ip) {
  // Реализация проверки IP в CIDR
  // Или — простой whitelist:
  return true; // TODO: реализовать проверку
}

function handleWebhook(body, sourceIp) {
  if (!isYookassaIp(sourceIp)) {
    return { success: false, handled: false, error: 'Invalid source IP' };
  }
  // ... rest of the logic
}
```

#### A.3 — Блокировка dev mode в production

```javascript
// auth.js — добавить в начало

if (process.env.NODE_ENV === 'production' && (!botToken || botToken === '')) {
  console.error('[FATAL] BOT_TOKEN is required in production');
  process.exit(1);
}
```

### Приложение Б: Рекомендуемая архитектура безопасности

```
User → Telegram (HTTPS) → Mini App
     → Bothost (HTTPS) → Cloud.ru VM
     
Inside Cloud.ru VM:
  Nginx (SSL termination, rate limiting, WAF)
    → FastAPI (auth, validation, business logic)
      → PostgreSQL (encrypted at rest)
      → Redis (authenticated, encrypted)
      
Security layers:
  1. Network: Firewall (only 80/443 open), Docker network isolation
  2. Transport: TLS 1.2+, HSTS
  3. Auth: Telegram initData HMAC-SHA256 + JWT sessions
  4. API: Rate limiting, input validation, CSRF tokens
  5. Data: Encrypted PII in DB, encrypted backups
  6. Monitoring: Audit logs, alerts, SIEM
```

### Приложение В: Команды для аудита зависимостей

```bash
# Node.js
npm audit --audit-level=moderate

# Python
pip install safety
safety check -r requirements.txt

# Docker
docker scan altai_api:latest
```

### Приложение Г: Тест-кейсы для pentest

| # | Тест | Ожидаемый результат | Фактический результат |
|---|---|---|---|
| T1 | `POST /api/payments/create` без initData | 401 Unauthorized | ❌ 200 OK (платёж создаётся) |
| T2 | `POST /api/driver/orders/1/status` с `{"status":"CANCELLED"}` без auth | 401 Unauthorized | ❌ 200 OK (статус меняется) |
| T3 | `GET /api/orders/1` без auth | 401 Unauthorized | ❌ 200 OK (видим чужой заказ) |
| T4 | `POST /api/payments/webhook` с фейковым `payment.succeeded` | 403 Forbidden | ❌ 200 OK (заказ "оплачен") |
| T5 | `GET /api/drivers` без auth | 200 OK без phone | ❌ 200 OK с phone |
| T6 | `POST /api/payments/simulate` в production | 404 или 401 | ❌ 200 OK (mock работает) |
| T7 | Запуск без BOT_TOKEN в production | Fatal error | ❌ Приложение работает (dev mode) |
| T8 | `GET /api/health` | {"status":"ok"} без payment info | ❌ {"payment":{"mode":"mock",...}} |

---

*Аудит завершён. Все выявленные уязвимости подлежат исправлению перед production-запуском. Приоритет: P0 — критические, P1 — высокие, P2 — средние, P3 — низкие.*

**Общая оценка безопасности: 3/10** (Критическая — множественные уязвимости Broken Access Control позволяют полностью скомпрометировать приложение)

**Оценка после исправления P0+P1: 7/10** (Хорошая — базовые механизмы защиты на месте, требуются улучшения мониторинга и соответствия 152-ФЗ)
