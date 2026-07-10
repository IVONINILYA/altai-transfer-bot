# Переустановка с нуля — начиная с Этапа 3 (Cloud.ru VM)

> Если вы застряли на Этапе 4 и nginx не поднимается — эта инструкция для вас.
> Мы удалим ВСЁ на виртуальной машине, загрузим новые файлы и установим заново.

---

## ШАГ 0: Удалить всё на виртуальной машине

**Где выполнять:** Терминал виртуальной машины Cloud.ru (через SSH или веб-консоль)

```bash
# 1. Остановить все Docker контейнеры
cd ~/altai-transfer 2>/dev/null && docker compose down --volumes --remove-orphans 2>/dev/null

# 2. Удалить все контейнеры, образы, volumes (если остались)
docker stop $(docker ps -aq) 2>/dev/null
docker rm $(docker ps -aq) 2>/dev/null
docker volume rm $(docker volume ls -q) 2>/dev/null
docker network prune -f 2>/dev/null

# 3. Удалить папку проекта полностью (если есть)
cd ~
rm -rf ~/altai-transfer

# 4. Создать папку заново (git clone или загрузка файлов создадут содержимое)
mkdir -p ~/altai-transfer

# 5. Проверить что всё чисто
docker ps -a        # должно быть пусто (только заголовки)
docker images       # можно оставить — не мешает
docker volume ls    # должно быть пусто
ls ~/               # не должно быть папки altai-transfer
```

**Если docker не установлен** — просто выполните шаг 3 и 4 (удаление папки).

---

## ШАГ 1: Загрузить новые файлы на VM

### Вариант A: Через git clone (если git установлен)

```bash
cd ~
git clone https://github.com/IVONINILYA/altai-transfer-bot.git altai-transfer
```

### Вариант B: Через загрузку ZIP (если git НЕ установлен)

На **вашем компьютере**:
1. Скачайте ZIP: https://github.com/IVONINILYA/altai-transfer-bot/archive/refs/heads/main.zip
2. Распакуйте → получите папку `altai-transfer-bot-main/`
3. Переименуйте в `altai-transfer/`

Загрузка на VM через SCP (в терминале **вашего компьютера**, не VM!):
```bash
# Замените YOUR_VM_IP на IP вашей виртуальной машины
scp -r /путь/до/altai-transfer root@YOUR_VM_IP:~/
```

Или через `rsync`:
```bash
rsync -avz /путь/до/altai-transfer/ root@YOUR_VM_IP:~/altai-transfer/
```

### Вариант C: Через файловый менеджер Cloud.ru

1. В панели Cloud.ru откройте файловый менеджер VM
2. Создайте папку `altai-transfer`
3. Загрузите файлы из папки `cloudru/` вашего репозитория

---

## ШАГ 2: Проверить структуру файлов

**Где:** Терминал VM

```bash
cd ~/altai-transfer
ls -la
```

Должно быть:
```
cloudru/          # ← папка с конфигами (создайте если нет)
api/              # ← папка с FastAPI
.env.example
nginx.conf
docker-compose.yml
init.sql
migrate.js
```

Если у вас структура `cloudru/cloudru/...` (вложенная) — исправьте:
```bash
cd ~/altai-transfer
# Если cloudru внутри ещё одной папки:
mv cloudru/cloudru/* cloudru/ 2>/dev/null
rm -rf cloudru/cloudru 2>/dev/null
```

Перейдите в рабочую папку:
```bash
cd ~/altai-transfer/cloudru
ls -la
```

Должно быть:
```
nginx.conf
docker-compose.yml
init.sql
.env.example
api/
migrate.js
```

---

## ШАГ 3: Установить Docker + Docker Compose

**Где:** Терминал VM

### 3.1 Проверить, установлен ли Docker

```bash
docker --version
docker compose version
```

Если выводятся версии (например `Docker version 24.0.x`, `Docker Compose version v2.x.x`) — **перейдите к ШАГУ 4**.

### 3.2 Установить Docker (если не установлен)

```bash
# Обновить пакеты
sudo apt update && sudo apt install -y ca-certificates curl gnupg

# Добавить GPG ключ Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Добавить репозиторий
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Установить Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Проверить
sudo docker --version
sudo docker compose version
```

**Что проверить:** команды выше должны показать версии без ошибок.

---

## ШАГ 4: Создать .env файл

**Где:** Терминал VM

```bash
cd ~/altai-transfer/cloudru
```

Создать файл `.env`:
```bash
nano .env
```

Вставьте следующее (замените ПАРОЛИ на свои!):

```env
# ═══════════════════════════════════════════
# PostgreSQL
# ═══════════════════════════════════════════
DB_PASSWORD=ВАШ_СЛОЖНЫЙ_ПАРОЛЬ_БД_123

# ═══════════════════════════════════════════
# Redis
# ═══════════════════════════════════════════
REDIS_PASSWORD=ВАШ_СЛОЖНЫЙ_ПАРОЛЬ_REDIS_456

# ═══════════════════════════════════════════
# Telegram Bot (токен из @BotFather)
# ═══════════════════════════════════════════
BOT_TOKEN=ВАШ_ТОКЕН_БОТА

# ═══════════════════════════════════════════
# ЮKassa (пока пусто — mock mode)
# ═══════════════════════════════════════════
YOOKASSA_SHOP_ID=
YOOKASSA_SECRET_KEY=
YOOKASSA_RETURN_URL=

# ═══════════════════════════════════════════
# Security (случайная строка, минимум 32 символа)
# Сгенерируйте: openssl rand -hex 32
# ═══════════════════════════════════════════
API_KEY=СЛУЧАЙНАЯ_СТРОКА_32_СИМВОЛА_МИНИМУМ

# ═══════════════════════════════════════════
# Bothost (URL для обратной связи)
# ═══════════════════════════════════════════
BOTHOST_URL=https://nl7.bothost.ru
```

Сохранить: `Ctrl+O` → `Enter` → `Ctrl+X`

> **ВАЖНО:** Замените все значения в ВАШИХ_ПАРОЛЯХ на реальные пароли!
> Пароли должны быть длинными и случайными (минимум 16 символов).

---

## ШАГ 5: Создать SSL-сертификаты (самоподписанные для старта)

**Где:** Терминал VM

```bash
cd ~/altai-transfer/cloudru

# Создать папку для SSL
mkdir -p ssl

# Сгенерировать самоподписанный сертификат (временный, для старта)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout ssl/privkey.pem \
  -out ssl/fullchain.pem \
  -subj "/C=RU/ST=Altai/L=Gorno-Altaysk/O=AltaiTransfer/CN=your-domain.ru"

# Проверить что файлы созданы
ls -la ssl/
```

Должно быть два файла:
- `fullchain.pem` — сертификат
- `privkey.pem` — приватный ключ

> **Позже** заменим на реальные от Let's Encrypt (Этап 6).

---

## ШАГ 6: Создать папку для Mini App статики

**Где:** Терминал VM

```bash
cd ~/altai-transfer/cloudru
mkdir -p public
```

Скопируйте файлы Mini App из репозитория:
```bash
# Если ваш репозиторий клонирован в ~/altai-transfer:
cp ~/altai-transfer/public/* public/ 2>/dev/null || echo "Файлы Mini App нужно загрузить вручную в папку public/"
```

Проверить:
```bash
ls public/
# Должно быть: index.html, style.css, script.js, hero-bg.jpg, driver-*.jpg
```

---

## ШАГ 7: ПЕРВЫЙ ЗАПУСК (только PostgreSQL + Redis)

**Где:** Терминал VM

```bash
cd ~/altai-transfer/cloudru

# Запускаем ТОЛЬКО базы данных (без API и nginx)
docker compose up -d postgres redis
```

Ждём 15-20 секунд, пока PostgreSQL инициализируется:

```bash
# Проверить что контейнеры запущены
docker compose ps
```

Должно показать:
```
NAME           STATUS
altai_postgres Up (healthy)
altai_redis    Up (healthy)
```

Если `healthy` не появляется в течение 30 секунд — проверьте логи:
```bash
docker compose logs postgres
docker compose logs redis
```

---

## ШАГ 8: Проверить что база данных инициализировалась

```bash
# Зайти в PostgreSQL контейнер
docker compose exec postgres psql -U altai_user -d altai_transfer -c "\dt"
```

Должно показать список таблиц:
```
 routes
 drivers
 orders
 payments
```

Если таблиц нет — проверьте что init.sql на месте:
```bash
ls -la init.sql
docker compose logs postgres | grep -i "init"
```

---

## ШАГ 9: Запустить API

```bash
cd ~/altai-transfer/cloudru

# Собрать и запустить API
docker compose up -d --build api
```

Ждём 10-15 секунд и проверяем:

```bash
# Проверить статус
docker compose ps

# Должно быть:
# altai_api      Up (healthy)

# Проверить логи API
docker compose logs api | tail -20
```

**Ожидаемый вывод в логах:**
```
INFO:     Uvicorn running on http://0.0.0.0:8000
INFO:     Application startup complete.
```

Проверить что API отвечает:
```bash
curl http://localhost:8000/api/health
```

Должен вернуть:
```json
{"status":"ok"}
```

---

## ШАГ 10: Запустить Nginx

```bash
cd ~/altai-transfer/cloudru

# Запустить nginx
docker compose up -d nginx
```

Проверить статус:
```bash
docker compose ps
```

Должно быть 4 контейнера со статусом `Up`:
```
NAME           STATUS
altai_nginx    Up
altai_api      Up (healthy)
altai_postgres Up (healthy)
altai_redis    Up (healthy)
```

Если nginx в статусе `Restarting` или `Exited` — смотрим логи:
```bash
docker compose logs nginx
```

### Частые ошибки nginx:

**Ошибка: "cannot load certificate"**
→ SSL файлы не созданы. Вернитесь к ШАГУ 5.

**Ошибка: "proxy_params" not found**
→ Старый nginx.conf. Убедитесь что вы загрузили НОВЫЕ файлы (ШАГ 1).

**Ошибка: "upstream prematurely closed"**
→ API ещё не готов. Подождите 10 секунд и перезапустите:
```bash
docker compose restart nginx
```

---

## ШАГ 11: Проверить что всё работает

```bash
# Проверить API через nginx (самоподписанный SSL — флаг -k)
curl -k https://localhost/api/health

# Должен вернуть:
# {"status":"ok"}

# Проверить список маршрутов
curl -k https://localhost/api/routes | head -50

# Должен вернуть JSON с маршрутами
```

---

## ШАГ 12: Открыть порт 443 в firewall Cloud.ru

**Где:** Панель управления Cloud.ru (веб-интерфейс, НЕ терминал!)

1. Откройте панель Cloud.ru → Ваш VM → Firewall / Security Group
2. Добавьте правило:
   - **Протокол:** TCP
   - **Порт:** 443
   - **Источник:** 0.0.0.0/0 (любой)
3. Также проверьте что открыт порт 80 (TCP)

---

## ШАГ 13: Проверить из браузера

Откройте в браузере:
```
https://IP_ВАШЕЙ_VM/api/health
```

Браузер покажет предупреждение о самоподписанном сертификате — это **нормально**.
- Chrome: Нажмите `Дополнительно` → `Перейти на сайт`
- Firefox: Нажмите `Дополнительно` → `Принять риск и продолжить`

Должен показать:
```json
{"status":"ok"}
```

---

## ЭТАП 5: Настройка домена и Let's Encrypt (SSL)

### 5.1 Купить/настроить домен

Купите домен (например `altai-transfer.ru`) у любого регистратора.

### 5.2 Настроить DNS A-запись

В панели управления доменом создайте A-запись:
```
Тип: A
Имя: @ (или api)
Значение: IP_ВАШЕЙ_VM
TTL: 300
```

Ждите 5-15 минут пока DNS обновится.

### 5.3 Установить certbot

**Где:** Терминал VM

```bash
# Установить certbot
sudo apt install -y certbot

# Получить сертификат (замените altai-transfer.ru на ваш домен)
sudo certbot certonly --standalone -d altai-transfer.ru -d www.altai-transfer.ru

# Введите email для уведомлений о продлении
# Согласитесь с Terms of Service
```

**Ожидаемый результат:**
```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/altai-transfer.ru/fullchain.pem
```

### 5.4 Обновить SSL путь в docker-compose

```bash
cd ~/altai-transfer/cloudru
```

Отредактируйте docker-compose.yml, замените строку:
```yaml
- ./ssl:/etc/nginx/ssl:ro
```

на:
```yaml
- /etc/letsencrypt/live/ВАШ_ДОМЕН:/etc/nginx/ssl:ro
- /etc/letsencrypt/archive/ВАШ_ДОМЕН:/etc/nginx/ssl/archive:ro
```

И перезапустить:
```bash
docker compose up -d
```

### 5.5 Автообновление сертификата

```bash
# Добавить в crontab
sudo crontab -e
```

Добавить строку:
```
0 3 * * * certbot renew --quiet && cd /root/altai-transfer/cloudru && docker compose restart nginx
```

Сохранить: `Ctrl+O` → `Enter` → `Ctrl+X`

---

## ЭТАП 6: Проверка всей системы

Выполните все проверки:

```bash
cd ~/altai-transfer/cloudru

# Все контейнеры работают?
docker compose ps

# API отвечает?
curl -k https://localhost/api/health

# Маршруты есть?
curl -k https://localhost/api/routes | wc -c
# Должно быть больше 500 байт

# Водители есть?
curl -k https://localhost/api/drivers

# PostgreSQL жив?
docker compose exec postgres psql -U altai_user -d altai_transfer -c "SELECT COUNT(*) FROM routes;"
# Должно вернуть: 14 (или сколько маршрутов в init.sql)
```

---

## Если что-то пошло не так

### Полный сброс (начать заново)

```bash
cd ~/altai-transfer/cloudru 2>/dev/null
docker compose down --volumes --remove-orphans 2>/dev/null
docker system prune -a --volumes -f 2>/dev/null
rm -rf ~/altai-transfer
mkdir -p ~/altai-transfer
# Вернитесь к ШАГУ 0
```

### Перезапуск одного сервиса

```bash
# Только API
docker compose restart api

# Только nginx
docker compose restart nginx

# Посмотреть логи сервиса
docker compose logs api --tail=50 -f
docker compose logs nginx --tail=50 -f
docker compose logs postgres --tail=20
```

### Проверить что слушает порты

```bash
sudo ss -tlnp | grep -E ':80|:443|:8000'
```

---

## Что дальше (Этап 7+)

После успешной установки:
1. **Миграция данных** из SQLite (old bothost) → PostgreSQL (new cloud)
   → Файл: `migrate.js`
2. **Настройка Bothost как proxy** — обновить app.js на bothost
   → Файл: `bothost_proxy.js`
3. **Настройка ЮKassa** — добавить реальные shopId и secretKey в .env
4. **Мониторинг** — настроить алерты на падение контейнеров

---

## Сводка команд (для быстрого копирования)

```bash
# === УДАЛЕНИЕ ===
cd ~/altai-transfer 2>/dev/null && docker compose down --volumes 2>/dev/null
cd ~ && rm -rf ~/altai-transfer

# === СОЗДАТЬ ПАПКУ ===
mkdir -p ~/altai-transfer

# === ЗАГРУЗКА ===
git clone https://github.com/IVONINILYA/altai-transfer-bot.git ~/altai-transfer
cd ~/altai-transfer/cloudru

# === .env ===
cp .env.example .env
nano .env  # заполнить пароли!

# === SSL ===
mkdir -p ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout ssl/privkey.pem -out ssl/fullchain.pem \
  -subj "/C=RU/ST=Altai/L=Gorno-Altaysk/O=AltaiTransfer/CN=localhost"

# === СТАТИКА ===
mkdir -p public
cp ~/altai-transfer/public/* public/ 2>/dev/null || true

# === ЗАПУСК ===
docker compose up -d postgres redis
sleep 15
docker compose up -d --build api
sleep 10
docker compose up -d nginx

# === ПРОВЕРКА ===
docker compose ps
curl -k https://localhost/api/health
```
