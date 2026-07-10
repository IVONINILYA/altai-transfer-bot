# Алтай Трансфер — Telegram Mini App

Telegram Mini App для заказа трансферных услуг в Горном Алтае. Маркетплейс, где туристы выбирают водителя по маршруту из аэропорта Горно-Алтайска.

## Архитектура

```
Bothost (nl7.bothost.ru) — Node.js HTTP сервер + SQLite + Mini App
```

## Стек

- **Backend**: Node.js (pure, no Express), better-sqlite3
- **Frontend**: HTML5 + CSS3 + Vanilla JS, Telegram WebApp SDK
- **Auth**: Telegram initData HMAC-SHA256 validation
- **DB**: SQLite (better-sqlite3) с graceful fallback на in-memory

## Быстрый старт

### 1. Локальный запуск (без SQLite — dev mode)

```bash
node app.js
```
Сервер запустится на `http://localhost:3000`. Будет использоваться in-memory хранилище.

### 2. Локальный запуск (с SQLite — production mode)

```bash
npm install  # требуется build toolchain (python3, g++, make)
node app.js
```

### 3. Деплой на Bothost

1. Добавьте `BOTHOST_TOKEN` в Settings → Secrets → Actions на GitHub
2. Push в ветку `main` — GitHub Actions автоматически деплоит на bothost:
```bash
git push origin main
```

## Переменные окружения

| Переменная | Описание | По умолчанию |
|------------|----------|-------------|
| `PORT` | Порт сервера | `3000` |
| `BOT_TOKEN` | Токен Telegram бота (для auth) | `''` (dev mode) |
| `BOTHOST_TOKEN` | Токен bothost для /deploy | `''` |
| `DATABASE_PATH` | Путь к SQLite БД | `./data/altai.db` |

## API Endpoints

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/routes` | Список маршрутов |
| `GET` | `/api/drivers` | Список водителей |
| `POST` | `/api/orders` | Создать заказ (требуется initData) |
| `GET` | `/api/orders` | Заказы пользователя (требуется initData) |
| `GET` | `/api/orders/:id` | Заказ по ID |
| `GET` | `/api/health` | Health check |
| `POST` | `/deploy` | Webhook деплоя (Bearer token) |
| `GET` | `/` | Mini App |

## Структура проекта

```
├── app.js           # HTTP сервер, routing, static files
├── database.js      # SQLite CRUD + in-memory fallback
├── auth.js          # Telegram initData HMAC-SHA256
├── deploy.js        # GitHub webhook handler
├── package.json
├── public/
│   ├── index.html   # Mini App (5 экранов)
│   ├── style.css    # Telegram theme styles
│   └── script.js    # Client logic
└── .github/workflows/deploy.yml
```

## 5 экранов Mini App

1. **Маршруты** — выбор направления
2. **Водители** — выбор водителя с рейтингом
3. **Бронирование** — форма (дата, время, пассажиры)
4. **Успех** — подтверждение заказа
5. **Мои поездки** — история заказов

## Решение проблем

### Белый экран в Telegram
- Исправлено: DOCTYPE, порядок скриптов, абсолютные пути, fallback UI
- Все ресурсы загружаются с `/` (не относительные пути)

### better-sqlite3 не устанавливается
- Сервер автоматически переключается на in-memory storage
- На bothost: `npm install better-sqlite3` в консоли хостинга

## Лицензия

MIT
