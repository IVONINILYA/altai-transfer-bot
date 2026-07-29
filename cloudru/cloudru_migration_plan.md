# План миграции backend на Cloud.ru — "Алтай Трансфер"

> **Цель:** Перенести базу данных, API и платежи с Bothost на Cloud.ru VM, оставив Bothost как proxy для статики Mini App и webhook'ов Telegram.
> **Время на выполнение:** 2-4 часа (последовательно, с проверками)
> **Сложность:** Средняя (не требует глубокого опыта DevOps)

---

## Содержание

1. [Архитектура до и после](#0-архитектура)
2. [Этап 1: Подготовка VM (Cloud.ru)](#этап-1-подготовка-vm-cloudru)
3. [Этап 2: Docker + Docker Compose](#этап-2-docker--docker-compose)
4. [Этап 3: PostgreSQL — инициализация](#этап-3-postgresql)
5. [Этап 4: API сервер (FastAPI)](#этап-4-api-сервер-fastapi)
6. [Этап 5: Nginx + SSL](#этап-5-nginx--ssl)
7. [Этап 6: Миграция данных SQLite → PostgreSQL](#этап-6-миграция-данных)
8. [Этап 7: Bothost как proxy](#этап-7-bothost-как-proxy)
9. [Этап 8: Переключение и тестирование](#этап-8-переключение-и-тестирование)
10. [Этап 9: ЮKassa платежи](#этап-9-юkassa-платежи)
11. [Откат (Rollback)](#откат-rollback)
12. [Чек-лист проверок](#чек-лист-проверок)

---

## 0. Архитектура

### До (только Bothost)

```
┌─────────────────────────────────────┐
│  Bothost (nl7.bothost.ru)           │
│  ┌─────────────────────────────┐    │
│  │  Node.js HTTP server        │    │
│  │  ├── Mini App static files  │    │
│  │  ├── API endpoints          │    │
│  │  ├── SQLite database        │    │
│  │  └── Telegram auth          │    │
│  └─────────────────────────────┘    │
│                                     │
│  Free tier: 512 MB RAM, shared CPU  │
└─────────────────────────────────────┘
```

### После (Bothost + Cloud.ru)

```
┌──────────────────────┐         ┌──────────────────────────────────┐
│  Bothost (nl7)       │◄────────│  Telegram API (webhook, bot)     │
│  ┌────────────────┐  │         └──────────────────────────────────┘
│  │ Mini App static│  │
│  │ Proxy → Cloud  │──┼────────►┌──────────────────────────────────┐
│  │ Telegram auth  │  │         │  Cloud.ru VM                     │
│  └────────────────┘  │         │  ┌────────────────────────────┐  │
└──────────────────────┘         │  │  Nginx (SSL, proxy)        │  │
                                 │  │  ├── HTTPS :443            │  │
                                 │  │  └── HTTP  :80 → HTTPS     │  │
                                 │  ├────────────────────────────┤  │
                                 │  │  FastAPI (Python)          │  │
                                 │  │  ├── /api/routes           │  │
                                 │  │  ├── /api/orders           │  │
                                 │  │  ├── /api/drivers          │  │
                                 │  │  └── /api/payments         │  │
                                 │  ├────────────────────────────┤  │
                                 │  │  PostgreSQL 15             │  │
                                 │  │  ├── users, drivers        │  │
                                 │  │  ├── routes, orders        │  │
                                 │  │  └── payments              │  │
                                 │  ├────────────────────────────┤  │
                                 │  │  Redis 7                   │  │
                                 │  │  ├── sessions              │  │
                                 │  │  └── cache                 │  │
                                 │  └────────────────────────────┘  │
                                 │                                  │
                                 │  2 vCPU, 4 GB RAM, 50 GB SSD    │
                                 └──────────────────────────────────┘
```

### Поток данных

| Запрос | Bothost | Cloud.ru |
|--------|---------|----------|
| Mini App страница | ✅ Раздаёт статику | ❌ |
| API запросы | ✅ Принимает, проксирует | ✅ Обрабатывает |
| Telegram webhook | ✅ Принимает, проксирует | ✅ Обрабатывает |
| Auth (initData) | ✅ Проверяет HMAC | ❌ (только данные) |
| Database | ❌ Убрано | ✅ PostgreSQL |
| Payments | ❌ | ✅ ЮKassa |
| Sessions | ❌ | ✅ Redis |

---

## Этап 1: Подготовка VM (Cloud.ru)

### Шаг 1.1: Создание виртуальной машины

**Где выполнять:** Личный кабинет Cloud.ru (https://cloud.ru)

1. Откройте личный кабинет Cloud.ru → "Облачные вычисления" → "Виртуальные машины"
2. Нажмите "Создать ВМ"
3. Параметры:

| Параметр | Значение |
|----------|----------|
| **Название** | `altai-transfer-api` |
| **Операционная система** | Ubuntu 22.04 LTS |
| **Тариф** | 2 vCPU, 4 GB RAM |
| **Диск** | 50 GB SSD |
| **Сеть** | Публичный IP (внешний) |
| **Доступ** | SSH-ключ (сгенерируйте новую пару) |
| **Группы безопасности** | `default` (доработаем ниже) |

4. Нажмите "Создать" и дождитесь статуса "Активна" (обычно 2-3 минуты)
5. Запишите **публичный IP адрес** VM (например, `89.169.1.23`)

**Ожидаемый результат:** VM создана и запущена, есть публичный IP.

**Что проверить:**
```bash
# С вашего локального компьютера:
ping <VM_IP>
# Должен быть ответ от сервера
```

---

### Шаг 1.2: Базовая настройка VM

**Где выполнять:** Терминал, подключённый к Cloud.ru VM через SSH

```bash
# ═══════════════════════════════════════════════════════════════
#  Подключение к VM (с вашего локального компьютера)
# ═══════════════════════════════════════════════════════════════
# Если используете SSH-ключ:
ssh ubuntu@<VM_IP>

# Если используете пароль:
ssh ubuntu@<VM_IP>
# (введите пароль при запросе)
```

```bash
# ═══════════════════════════════════════════════════════════════
#  1. Обновление системы
# ═══════════════════════════════════════════════════════════════
sudo apt update && sudo apt upgrade -y

# Ожидаемый результат: "0 upgraded, 0 newly installed" (или обновления установлены)
```

```bash
# ═══════════════════════════════════════════════════════════════
#  2. Настройка Firewall (UFW)
# ═══════════════════════════════════════════════════════════════
# По умолчанию — запретить ВСЕ входящие, разрешить все исходящие
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Разрешить необходимые порты
sudo ufw allow 22/tcp   comment 'SSH'
sudo ufw allow 80/tcp   comment 'HTTP'
sudo ufw allow 443/tcp  comment 'HTTPS'

# НЕ открываем 5432 и 6379 наружу — они доступны только внутри Docker!

# Включаем firewall
sudo ufw enable
# (введите 'y' при подтверждении)

# Проверяем статус
sudo ufw status verbose

# Ожидаемый результат:
# Status: active
# To                         Action      From
# --                         ------      ----
# 22/tcp                     ALLOW IN    Anywhere
# 80/tcp                     ALLOW IN    Anywhere
# 443/tcp                    ALLOW IN    Anywhere
```

```bash
# ═══════════════════════════════════════════════════════════════
#  3. Установка базовых утилит
# ═══════════════════════════════════════════════════════════════
sudo apt install -y \
    curl \
    wget \
    git \
    nano \
    htop \
    net-tools \
    unzip \
    software-properties-common \
    apt-transport-https \
    ca-certificates \
    gnupg \
    lsb-release
```

```bash
# ═══════════════════════════════════════════════════════════════
#  4. Настройка часового пояса
# ═══════════════════════════════════════════════════════════════
sudo timedatectl set-timezone Asia/Barnaul
# (Горно-Алтайск — ближайший крупный TZ)

# Проверка
date
# Ожидаемый результат: текущая дата/время по алтайскому времени (UTC+7)
```

**Что проверить:**
```bash
# Все команды выше должны выполниться без ошибок
# Проверьте:
sudo ufw status | grep "Status: active"
timedatectl | grep "Asia/Barnaul"
```

**Как откатить:**
```bash
# Если что-то пошло не так — можно снести VM и создать заново
# В личном кабинете Cloud.ru: VM → Удалить → Создать новую
```

---

## Этап 2: Docker + Docker Compose

### Шаг 2.1: Установка Docker

**Где выполнять:** Cloud.ru VM (через SSH)

```bash
# ═══════════════════════════════════════════════════════════════
#  1. Установка Docker Engine
# ═══════════════════════════════════════════════════════════════
# Добавляем официальный GPG-ключ Docker
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# Добавляем репозиторий Docker
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Обновляем индекс пакетов и устанавливаем Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Проверка установки
sudo docker --version
# Ожидаемый результат: Docker version 24.x.x или выше

sudo docker compose version
# Ожидаемый результат: Docker Compose version v2.x.x
```

```bash
# ═══════════════════════════════════════════════════════════════
#  2. Настройка Docker (без sudo)
# ═══════════════════════════════════════════════════════════════
# Добавляем текущего пользователя в группу docker
sudo usermod -aG docker $USER

# Применяем изменения (или перезайдите по SSH)
newgrp docker

# Проверка — docker без sudo
docker ps
# Ожидаемый результат: CONTAINER ID  IMAGE  COMMAND... (пусто, но без ошибок)
```

```bash
# ═══════════════════════════════════════════════════════════════
#  3. Включение автозапуска Docker
# ═══════════════════════════════════════════════════════════════
sudo systemctl enable docker
sudo systemctl start docker
sudo systemctl status docker | grep "active (running)"
# Ожидаемый результат: зелёная строка "active (running)"
```

### Шаг 2.2: Создание директории проекта

```bash
# ═══════════════════════════════════════════════════════════════
#  4. Создание структуры директорий
# ═══════════════════════════════════════════════════════════════
mkdir -p ~/altai-transfer
cd ~/altai-transfer
mkdir -p api ssl backups

# Создаём .env файл
nano .env
```

В открывшемся редакторе nano вставьте (замените значения на свои):

```bash
# .env — конфигурация проекта
# ═══════════════════════════════════════════════════════════════

DB_PASSWORD=your_super_secure_password_32chars
REDIS_PASSWORD=your_redis_password_24chars
BOT_TOKEN=1234567890:AAAAAAAAAAABBBBBBBBBBCCCCCCCCCC
API_KEY=altai_transfer_api_key_2024_secure_random_string

# ЮKassa (опционально — заполните после регистрации)
YOOKASSA_SHOP_ID=
YOOKASSA_SECRET_KEY=
YOOKASSA_RETURN_URL=https://t.me/your_bot
```

Сохраните: `Ctrl+O` → `Enter` → `Ctrl+X`

```bash
# Защитим .env файл
chmod 600 .env
```

**Что проверить:**
```bash
cd ~/altai-transfer && ls -la
# Ожидаемый результат: .env файл есть, директории api/ ssl/ backups/ созданы
```

---

## Этап 3: PostgreSQL

### Шаг 3.1: Копирование конфигов

**Где выполнять:** Локальный компьютер (где скачаны файлы из этого плана)

```bash
# ═══════════════════════════════════════════════════════════════
#  Загрузка файлов на Cloud.ru VM
# ═══════════════════════════════════════════════════════════════
# Замените <VM_IP> на реальный IP вашей VM

# docker-compose.yml
scp docker-compose.yml ubuntu@<VM_IP>:~/altai-transfer/

# init.sql
scp init.sql ubuntu@<VM_IP>:~/altai-transfer/

# nginx.conf
scp nginx.conf ubuntu@<VM_IP>:~/altai-transfer/

# api/
scp api/* ubuntu@<VM_IP>:~/altai-transfer/api/

# proxy_params
scp proxy_params ubuntu@<VM_IP>:~/altai-transfer/
```

**Что проверить:**
```bash
# На VM:
ssh ubuntu@<VM_IP> "ls -la ~/altai-transfer/"
# Ожидаемый результат: docker-compose.yml, init.sql, nginx.conf, api/Dockerfile, api/main.py
```

### Шаг 3.2: Запуск PostgreSQL

**Где выполнять:** Cloud.ru VM

```bash
cd ~/altai-transfer

# ═══════════════════════════════════════════════════════════════
#  1. Запускаем ТОЛЬКО PostgreSQL (для инициализации)
# ═══════════════════════════════════════════════════════════════
docker compose up -d postgres

# Ждём инициализацию (30 секунд)
sleep 30

# Проверяем статус
docker compose ps
# Ожидаемый результат: postgres container — State: running, Health: healthy

# Проверяем логи
docker compose logs postgres | tail -20
# Ожидаемый результат: "database system is ready to accept connections"
```

```bash
# ═══════════════════════════════════════════════════════════════
#  2. Проверяем, что таблицы создались
# ═══════════════════════════════════════════════════════════════
docker compose exec -it postgres psql -U altai_user -d altai_transfer -c "\dt"

# Ожидаемый результат:
#           List of relations
#  Schema |        Name        | Type  |   Owner
# --------+--------------------+-------+-----------
#  public | api_keys           | table | altai_user
#  public | drivers            | table | altai_user
#  public | order_status_history | table | altai_user
#  public | orders             | table | altai_user
#  public | payments           | table | altai_user
#  public | routes             | table | altai_user
#  public | sessions           | table | altai_user
#  public | users              | table | altai_user
```

```bash
# ═══════════════════════════════════════════════════════════════
#  3. Проверяем seed-данные
# ═══════════════════════════════════════════════════════════════
docker compose exec -it postgres psql -U altai_user -d altai_transfer -c "SELECT id, name, price FROM routes;"

# Ожидаемый результат: 14 маршрутов от r1 до r14

docker compose exec -it postgres psql -U altai_user -d altai_transfer -c "SELECT id, name, rating FROM drivers;"

# Ожидаемый результат: 3 водителя (d1, d2, d3)
```

```bash
# ═══════════════════════════════════════════════════════════════
#  4. Проверяем views
# ═══════════════════════════════════════════════════════════════
docker compose exec -it postgres psql -U altai_user -d altai_transfer -c "SELECT * FROM v_popular_routes LIMIT 3;"

# Ожидаемый результат: список маршрутов с order_count = 0
```

**Что проверить:**
```bash
# PostgreSQL работает, таблицы созданы, данные засеяны
docker compose exec postgres psql -U altai_user -d altai_transfer -c "SELECT COUNT(*) FROM routes;"  # должно быть 14
docker compose exec postgres psql -U altai_user -d altai_transfer -c "SELECT COUNT(*) FROM drivers;" # должно быть 3
```

**Как откатить:**
```bash
# Удалить ВСЕ данные PostgreSQL и начать заново:
docker compose down -v  # удалит volume с данными
# Потом снова: docker compose up -d postgres
```

---

## Этап 4: API сервер (FastAPI)

### Шаг 4.1: Запуск всех сервисов

**Где выполнять:** Cloud.ru VM

```bash
cd ~/altai-transfer

# ═══════════════════════════════════════════════════════════════
#  1. Запуск всех сервисов (PostgreSQL + Redis + API + Nginx)
# ═══════════════════════════════════════════════════════════════
docker compose up -d --build

# --build — пересобрать Docker image для API
# -d      — фоновый режим

# Ждём запуск (60 секунд)
sleep 60

# Проверяем статус всех контейнеров
docker compose ps

# Ожидаемый результат:
# NAME           IMAGE                    STATUS
# altai_postgres postgres:15-alpine       Up ... (healthy)
# altai_redis    redis:7-alpine           Up ... (healthy)
# altai_api      altai-transfer-api       Up ... (healthy)
# altai_nginx    nginx:alpine             Up ... (healthy)
```

```bash
# ═══════════════════════════════════════════════════════════════
#  2. Проверка API — health check
# ═══════════════════════════════════════════════════════════════
curl http://localhost:8000/api/health | python3 -m json.tool

# Ожидаемый результат:
# {
#     "status": "ok",
#     "timestamp": "2025-01-...T...Z",
#     "database": "ok",
#     "redis": "ok",
#     "version": "2.0.0"
# }
```

```bash
# ═══════════════════════════════════════════════════════════════
#  3. Проверка API — список маршрутов
# ═══════════════════════════════════════════════════════════════
curl http://localhost:8000/api/routes | python3 -m json.tool

# Ожидаемый результат: JSON массив из 14 маршрутов
```

```bash
# ═══════════════════════════════════════════════════════════════
#  4. Проверка API — список водителей
# ═══════════════════════════════════════════════════════════════
curl http://localhost:8000/api/drivers | python3 -m json.tool

# Ожидаемый результат: JSON массив из 3 водителей
```

```bash
# ═══════════════════════════════════════════════════════════════
#  5. Просмотр логов API
# ═══════════════════════════════════════════════════════════════
docker compose logs api | tail -30

# Ожидаемый результат: логи запуска FastAPI, без ошибок
```

**Что проверить:**
```bash
# Все 4 контейнера в статусе Up (healthy)
docker compose ps | grep "Up.*healthy" | wc -l  # должно быть 4

# API отвечает
curl -s http://localhost:8000/api/health | grep '"status": "ok"'
```

**Как откатить:**
```bash
# Перезапуск всех сервисов:
docker compose restart

# Полный сброс:
docker compose down
docker compose up -d --build

# Просмотр ошибок конкретного сервиса:
docker compose logs api --tail=50 -f
```

---

## Этап 5: Nginx + SSL (Let's Encrypt)

### Шаг 5.1: Получение SSL-сертификата

**Где выполнять:** Cloud.ru VM

Для Let's Encrypt нужен домен. У вас два варианта:

#### Вариант A: У вас есть домен (рекомендуется)

```bash
# ═══════════════════════════════════════════════════════════════
#  1. Настройка DNS
# ═══════════════════════════════════════════════════════════════
# В панели управления вашего домена создайте A-запись:
#   api.yourdomain.com → <VM_IP>
#
# Дождитесь распространения DNS (до 24 часов, обычно 5-15 минут)
# Проверка:
dig api.yourdomain.com +short
# Ожидаемый результат: IP вашей Cloud.ru VM
```

```bash
# ═══════════════════════════════════════════════════════════════
#  2. Установка Certbot
# ═══════════════════════════════════════════════════════════════
sudo apt install -y certbot

# Получение сертификата (standalone mode)
sudo certbot certonly --standalone -d api.yourdomain.com

# Введите email для уведомлений
# Согласитесь с Terms of Service

# Ожидаемый результат:
# "Congratulations! Your certificate and chain have been saved at:
#  /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem"
```

```bash
# ═══════════════════════════════════════════════════════════════
#  3. Копирование сертификатов для Nginx контейнера
# ═══════════════════════════════════════════════════════════════
# Создаём директорию для SSL
mkdir -p ~/altai-transfer/ssl

# Копируем сертификаты
sudo cp /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem ~/altai-transfer/ssl/
sudo cp /etc/letsencrypt/live/api.yourdomain.com/privkey.pem ~/altai-transfer/ssl/

# Права доступа
sudo chmod 644 ~/altai-transfer/ssl/*.pem

# Перезапускаем Nginx контейнер
cd ~/altai-transfer && docker compose restart nginx
```

#### Вариант B: Нет домена (self-signed сертификат)

```bash
# ═══════════════════════════════════════════════════════════════
#  Self-signed сертификат (только для тестирования!)
# ═══════════════════════════════════════════════════════════════
mkdir -p ~/altai-transfer/ssl

cd ~/altai-transfer/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout privkey.pem \
    -out fullchain.pem \
    -subj "/CN=altai-transfer-api"

# Перезапуск Nginx
cd ~/altai-transfer && docker compose restart nginx
```

### Шаг 5.2: Проверка HTTPS

```bash
# ═══════════════════════════════════════════════════════════════
#  Проверка через публичный IP
# ═══════════════════════════════════════════════════════════════
# Для начала проверим HTTP
curl -I http://<VM_IP>/api/health

# Ожидаемый результат: HTTP/1.1 200 OK (через Nginx proxy)

# HTTPS (если есть домен + Let's Encrypt):
curl -I https://api.yourdomain.com/api/health

# Ожидаемый результат: HTTP/2 200 OK
```

**Что проверить:**
```bash
# Nginx слушает порты
sudo netstat -tlnp | grep -E ':80|:443'
# Ожидаемый результат: nginx слушает 0.0.0.0:80 и 0.0.0.0:443

# API доступен через Nginx
curl http://localhost/api/health | grep "ok"
```

---

## Этап 6: Миграция данных (SQLite → PostgreSQL)

### Шаг 6.1: Получение SQLite файла с Bothost

**Где выполнять:** Bothost сервер (через SSH/FTP)

```bash
# ═══════════════════════════════════════════════════════════════
#  1. На Bothost: проверяем путь к SQLite
# ═══════════════════════════════════════════════════════════════
# Подключитесь к Bothost (через панель управления Bothost или SSH)
# Обычно файл находится в:
ls -la ~/altai-transfer/data/altai.db

# Или найдите его:
find ~ -name "*.db" 2>/dev/null
```

```bash
# ═══════════════════════════════════════════════════════════════
#  2. Копируем SQLite файл с Bothost на ваш локальный компьютер
# ═══════════════════════════════════════════════════════════════
# Через scp (если есть SSH-доступ к Bothost):
scp bothost_username@nl7.bothost.ru:~/altai-transfer/data/altai.db ./altai_backup.db

# Или через FTP/SFTP панель Bothost — скачайте файл altai.db

# Проверьте, что файл скачан:
ls -la ./altai_backup.db
```

### Шаг 6.2: Открытие SSH туннеля для миграции

**Где выполнять:** Ваш локальный компьютер

```bash
# ═══════════════════════════════════════════════════════════════
#  3. Создаём SSH туннель к PostgreSQL на Cloud.ru VM
# ═══════════════════════════════════════════════════════════════
# Это пробрасывает порт 5432 VM на ваш локальный порт 5433

ssh -L 5433:localhost:5432 ubuntu@<VM_IP> -N -f

# Проверка — подключение к PostgreSQL через туннель
# (установите psql клиент локально, или используйте Docker)
docker run --rm -it postgres:15-alpine psql \
    postgresql://altai_user:DB_PASSWORD@host.docker.internal:5433/altai_transfer \
    -c "SELECT 1"

# Ожидаемый результат: "?column?  1"
```

### Шаг 6.3: Запуск миграции

**Где выполнять:** Ваш локальный компьютер

```bash
# ═══════════════════════════════════════════════════════════════
#  4. Подготовка к миграции
# ═══════════════════════════════════════════════════════════════
# Установите зависимости
npm install better-sqlite3 pg

# Установите переменные окружения
export DATABASE_PATH="./altai_backup.db"
export DATABASE_URL="postgresql://altai_user:YOUR_PASSWORD@localhost:5433/altai_transfer"
```

```bash
# ═══════════════════════════════════════════════════════════════
#  5. Запуск миграции
# ═══════════════════════════════════════════════════════════════
node migrate.js

# Ожидаемый результат:
# ╔══════════════════════════════════════════════════════════╗
# ║     🔄 Миграция: SQLite → PostgreSQL                    ║
# ╠══════════════════════════════════════════════════════════╣
# ║  SQLite:  ./altai_backup.db                             ║
# ║  PostgreSQL: postgresql://altai_user:***@localhost:...  ║
# ╚══════════════════════════════════════════════════════════╝
# [1/6] Подключение к SQLite...
#       ✅ SQLite подключен
# [2/6] Подключение к PostgreSQL...
#       ✅ PostgreSQL подключен
# [3/6] Проверка схемы PostgreSQL...
#       ✅ Схема проверена
# [4/6] Миграция маршрутов...
#       ✅ Маршрутов перенесено: X/14
# [5/6] Миграция водителей...
#       ✅ Водителей перенесено: X/3
# [6/6] Миграция заказов...
#       ✅ Заказов перенесено: X/XXX
#
# ╔══════════════════════════════════════════════════════════╗
# ║                 📊 Результат миграции                     ║
# ╠══════════════════════════════════════════════════════════╣
# ║  Маршруты:   XX / 14                                    ║
# ║  Водители:   XX / 3                                     ║
# ║  Заказы:     XX / XXX                                   ║
# ╚══════════════════════════════════════════════════════════╝
```

```bash
# ═══════════════════════════════════════════════════════════════
#  6. Проверка мигрированных данных
# ═══════════════════════════════════════════════════════════════
# Заказы
docker run --rm -it postgres:15-alpine psql \
    postgresql://altai_user:PASSWORD@host.docker.internal:5433/altai_transfer \
    -c "SELECT COUNT(*) FROM orders;"

# Должно совпадать с количеством в SQLite

# Проверка конкретного заказа
docker run --rm -it postgres:15-alpine psql \
    postgresql://altai_user:PASSWORD@host.docker.internal:5433/altai_transfer \
    -c "SELECT * FROM v_orders_detail LIMIT 3;"
```

### Шаг 6.4: Закрытие туннеля

```bash
# ═══════════════════════════════════════════════════════════════
#  7. Закрываем SSH туннель
# ═══════════════════════════════════════════════════════════════
# Найдите PID процесса SSH туннеля
ps aux | grep "ssh -L 5433"
# kill <PID>

# Или просто:
pkill -f "ssh -L 5433"
```

**Что проверить:**
```bash
# Все данные на месте
docker compose exec postgres psql -U altai_user -d altai_transfer -c "SELECT COUNT(*) FROM orders;"
docker compose exec postgres psql -U altai_user -d altai_transfer -c "SELECT COUNT(*) FROM users;"
```

**Как откатить:**
```bash
# Если миграция пошла не так — просто удалите данные:
docker compose exec postgres psql -U altai_user -d altai_transfer -c "DELETE FROM orders; DELETE FROM users;"
# Потом перезапустите init.sql для seed-данных и попробуйте снова
```

---

## Этап 7: Bothost как Proxy

### Шаг 7.1: Обновление кода на Bothost

**Где выполнять:** Bothost сервер (через панель управления или SSH)

```bash
# ═══════════════════════════════════════════════════════════════
#  1. Резервная копия текущего app.js
# ═══════════════════════════════════════════════════════════════
cd ~/altai-transfer  # (или где ваш проект на Bothost)
cp app.js app.js.backup.v1
```

```bash
# ═══════════════════════════════════════════════════════════════
#  2. Замена app.js на proxy-версию
# ═══════════════════════════════════════════════════════════════
# Загрузите bothost_proxy.js из этого плана на Bothost
# Переименуйте:
cp bothost_proxy.js app.js
```

```bash
# ═══════════════════════════════════════════════════════════════
#  3. Настройка переменных окружения
# ═══════════════════════════════════════════════════════════════
# Отредактируйте файл запуска (зависит от панели Bothost)
# Или создайте .env файл:

nano .env

# Добавьте:
CLOUDRU_API_URL=http://<VM_IP>:8000
CLOUDRU_API_KEY=your_api_key_from_cloudru_env
```

```bash
# ═══════════════════════════════════════════════════════════════
#  4. Перезапуск приложения на Bothost
# ═══════════════════════════════════════════════════════════════
# Через панель Bothost: "Перезапустить приложение"
# Или если есть PM2:
pm2 restart app

# Проверка логов
pm2 logs

# Ожидаемый результат:
# ╔══════════════════════════════════════════════════════════╗
# ║     🏔️  Алтай Трансфер — Bothost Proxy Mode v2.0       ║
# ╠══════════════════════════════════════════════════════════╣
# ║  Mode:     PROXY → Cloud.ru                             ║
# ╚══════════════════════════════════════════════════════════╝
```

### Шаг 7.2: Проверка proxy

```bash
# ═══════════════════════════════════════════════════════════════
#  5. Проверка health Bothost
# ═══════════════════════════════════════════════════════════════
curl https://nl7.bothost.ru/health

# Ожидаемый результат:
# {
#     "status": "ok",
#     "mode": "proxy",
#     "cloudru": "ok"
# }
```

```bash
# ═══════════════════════════════════════════════════════════════
#  6. Проверка API через Bothost
# ═══════════════════════════════════════════════════════════════
curl https://nl7.bothost.ru/api/routes

# Ожидаемый результат: массив маршрутов (приходят с Cloud.ru)

curl https://nl7.bothost.ru/api/drivers

# Ожидаемый результат: массив водителей (приходят с Cloud.ru)
```

**Что проверить:**
```bash
# API Bothost возвращает данные с Cloud.ru
curl -s https://nl7.bothost.ru/api/routes | python3 -m json.tool | head -20

# Статика Mini App по-прежнему раздаётся
curl -I https://nl7.bothost.ru/ | grep "text/html"
```

**Как откатить:**
```bash
# На Bothost:
cp app.js.backup.v1 app.js
# Перезапустите приложение
# → Вернётся к оригинальной версии с SQLite
```

---

## Этап 8: Переключение и тестирование

### Шаг 8.1: Обновление Mini App в @BotFather

**Где выполнять:** Telegram

1. Откройте @BotFather → /mybots → ваш бот
2. "Bot Settings" → "Menu Button" → "Configure menu button"
3. Убедитесь, что URL Mini App указывает на Bothost:
   ```
   https://nl7.bothost.ru/
   ```
   (НЕ меняем — статика остаётся на Bothost!)

### Шаг 8.2: End-to-End тестирование

```bash
# ═══════════════════════════════════════════════════════════════
#  1. Откройте Mini App в Telegram
# ═══════════════════════════════════════════════════════════════
#  - Запустите бота
#  - Нажмите кнопку "Открыть Mini App"
#  - Проверьте, что страница загружается

#  2. Проверьте выбор маршрута и водителя
#  3. Создайте тестовый заказ
#  4. Проверьте отображение заказа в "Мои заказы"
```

```bash
# ═══════════════════════════════════════════════════════════════
#  2. Мониторинг — смотрим логи в реальном времени
# ═══════════════════════════════════════════════════════════════

# Cloud.ru VM — логи API:
cd ~/altai-transfer && docker compose logs api -f

# Cloud.ru VM — логи Nginx:
cd ~/altai-transfer && docker compose logs nginx -f

# Bothost — логи приложения:
pm2 logs
```

### Шаг 8.3: Проверка производительности

```bash
# ═══════════════════════════════════════════════════════════════
#  Нагрузочное тестирование (с вашего компьютера)
# ═══════════════════════════════════════════════════════════════
# Установите Apache Bench:
#   macOS: brew install apache2
#   Ubuntu: sudo apt install apache2-utils

# Тест: 100 запросов, 10 параллельных
ab -n 100 -c 10 https://nl7.bothost.ru/api/routes

# Ожидаемый результат:
# Requests per second: > 50
# Time per request: < 200ms
# Failed requests: 0
```

**Что проверить (полный чек-лист):**
- [ ] Mini App открывается в Telegram
- [ ] Список маршрутов загружается
- [ ] Список водителей загружается
- [ ] Создание заказа работает
- [ ] "Мои заказы" отображает заказы
- [ ] Водитель видит заказы в календаре
- [ ] Статус заказа можно изменить
- [ ] Нет ошибок в логах

---

## Этап 9: ЮKassa платежи

### Шаг 9.1: Регистрация в ЮKassa

1. Перейдите на https://yookassa.ru/
2. Зарегистрируйтесь как юрлицо / ИП
3. Получите:
   - **shopId** (например, `123456`)
   - **Секретный ключ** (например, `live_...` или `test_...`)
4. Настройте webhook в личном кабинете ЮKassa:
   - URL: `https://nl7.bothost.ru/api/payments/webhook`
   - События: `payment.succeeded`, `payment.canceled`

### Шаг 9.2: Настройка Cloud.ru

**Где выполнять:** Cloud.ru VM

```bash
cd ~/altai-transfer

# Обновляем .env
nano .env

# Добавьте:
YOOKASSA_SHOP_ID=your_shop_id
YOOKASSA_SECRET_KEY=your_secret_key
YOOKASSA_RETURN_URL=https://t.me/your_bot_username

# Перезапуск API для применения настроек
docker compose restart api
```

### Шаг 9.3: Тестирование платежа

```bash
# Создайте заказ через Mini App
# Нажмите "Оплатить" — должна открыться страница ЮKassa

# Для тестирования используйте тестовые карты ЮKassa:
#   5555 5555 5555 4477 — успешная оплата
#   4000 0000 0000 0002 — отказ
```

---

## Откат (Rollback)

### Полный откат к оригинальной конфигурации

Если что-то пошло не так — выполните в обратном порядке:

```bash
# Шаг 1: Вернуть оригинальный app.js на Bothost
cd ~/altai-transfer  # на Bothost
cp app.js.backup.v1 app.js
pm2 restart app
# → Mini App снова работает с SQLite

# Шаг 2: Остановить контейнеры на Cloud.ru
# (на VM)
cd ~/altai-transfer && docker compose down
# → API на Cloud.ru остановлен

# Шаг 3: (опционально) Удалить VM
# В личном кабинете Cloud.ru → VM → Удалить
```

**Причины для отката:**
- Mini App не загружается после переключения
- API возвращает ошибки
- Заказы не создаются
- Проблемы с производительностью

---

## Чек-лист проверок

### Перед запуском (Pre-flight)
- [ ] Cloud.ru VM создана и доступна по SSH
- [ ] Docker установлен и работает
- [ ] Файлы проекта скопированы на VM
- [ ] .env файл создан с корректными значениями
- [ ] SQLite файл скачан с Bothost

### После развёртывания
- [ ] PostgreSQL контейнер: Status = Up, Health = healthy
- [ ] Redis контейнер: Status = Up, Health = healthy
- [ ] API контейнер: Status = Up, Health = healthy
- [ ] Nginx контейнер: Status = Up, Health = healthy
- [ ] API отвечает: `curl localhost:8000/api/health` → `{"status":"ok"}`
- [ ] Маршруты: `curl localhost:8000/api/routes` → 14 записей
- [ ] Водители: `curl localhost:8000/api/drivers` → 3 записи

### После миграции данных
- [ ] Заказы перенесены (количество совпадает с SQLite)
- [ ] Пользователи перенесены
- [ ] Связи (route_id, driver_id) целостны

### После переключения Bothost
- [ ] Bothost health: `/health` → `mode: "proxy"`
- [ ] API через Bothost: `/api/routes` → данные с Cloud.ru
- [ ] Статика через Bothost: `/` → Mini App загружается
- [ ] Создание заказа работает
- [ ] "Мои заказы" отображает корректно

### Финальные проверки
- [ ] Mini App открывается в Telegram на телефоне
- [ ] Mini App открывается в Telegram на десктопе
- [ ] Заказ создаётся успешно
- [ ] Водитель видит заказ в календаре
- [ ] Статус заказа обновляется
- [ ] Нет ошибок в логах API
- [ ] Нет ошибок в логах Nginx

---

## Полезные команды (шпаргалка)

### Docker
```bash
cd ~/altai-transfer

docker compose ps           # статус контейнеров
docker compose logs         # все логи
docker compose logs api -f  # логи API в реальном времени
docker compose restart api  # перезапуск API
docker compose down         # остановить все
docker compose up -d        # запустить все
docker compose up -d --build # пересобрать и запустить
docker system prune -f      # очистить неиспользуемые образы
```

### PostgreSQL
```bash
# Подключение к БД
docker compose exec -it postgres psql -U altai_user -d altai_transfer

# Внутри psql:
\dt                    # список таблиц
\d orders              # структура таблицы
SELECT * FROM routes;  # данные маршрутов
SELECT COUNT(*) FROM orders;  # количество заказов
\q                     # выход
```

### Redis
```bash
# Подключение к Redis
docker compose exec -it redis redis-cli -a $REDIS_PASSWORD

# Внутри redis-cli:
KEYS *                 # все ключи
GET <key>              # значение ключа
FLUSHALL               # ОЧИСТИТЬ ВСЕ (осторожно!)
exit                   # выход
```

### Nginx
```bash
# Проверка конфигурации
docker compose exec nginx nginx -t

# Перезагрузка конфигурации
docker compose exec nginx nginx -s reload
```

### Логи и мониторинг
```bash
# Диск
df -h

# Память
free -h

# CPU
top

# Сетевые соединения
sudo netstat -tlnp

# Трафик по интерфейсам
sudo iftop -i eth0
```

### SSL обновление
```bash
# Let's Encrypt обновляет сертификаты автоматически
# Проверка:
sudo certbot renew --dry-run

# Обновление сертификатов (если нужно вручную):
sudo certbot renew
# Копируйте новые сертификаты в ~/altai-transfer/ssl/
# Перезапустите nginx: docker compose restart nginx
```

---

## Техническая поддержка

### Частые проблемы

**Проблема: PostgreSQL не запускается**
```bash
# Проверьте логи
docker compose logs postgres

# Частая причина: порт 5432 занят
sudo lsof -i :5432
# Решение: остановите локальный PostgreSQL или измените порт
```

**Проблема: API не может подключиться к PostgreSQL**
```bash
# Проверьте сеть Docker
docker network ls
docker network inspect altai-transfer_altai_network

# Проверьте, что контейнеры в одной сети
docker compose exec api ping -c 1 postgres
```

**Проблема: Nginx возвращает 502 Bad Gateway**
```bash
# Проверьте, что API работает
curl http://localhost:8000/api/health

# Проверьте upstream в nginx.conf
docker compose logs nginx
```

**Проблема: Bothost не достаёт Cloud.ru**
```bash
# Проверьте доступность Cloud.ru с Bothost
ssh bothost "curl -I http://<VM_IP>:8000/api/health"

# Проверьте firewall Cloud.ru
sudo ufw status

# Временно откройте порт 8000 для теста:
sudo ufw allow from <BOTHOST_IP> to any port 8000
```

---

## Созданные файлы

| Файл | Описание |
|------|----------|
| `cloudru_migration_plan.md` | Этот план (полная инструкция) |
| `docker-compose.yml` | Docker Compose: PostgreSQL + Redis + API + Nginx |
| `init.sql` | Схема PostgreSQL + seed данные |
| `api/main.py` | FastAPI сервер (все endpoint'ы) |
| `api/requirements.txt` | Python-зависимости |
| `api/Dockerfile` | Docker-образ для API |
| `api/proxy_params` | Параметры Nginx прокси |
| `nginx.conf` | Nginx: reverse proxy + SSL + rate limiting |
| `migrate.js` | Скрипт миграции SQLite → PostgreSQL |
| `bothost_proxy.js` | Обновлённый app.js для Bothost (proxy mode) |
| `.env.example` | Пример переменных окружения |
