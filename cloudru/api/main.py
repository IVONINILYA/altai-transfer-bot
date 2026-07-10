# ═══════════════════════════════════════════════════════════════
#  FastAPI — Алтай Трансфер API (Cloud.ru)
#  Endpoints: routes, drivers, orders, payments, health
# ═══════════════════════════════════════════════════════════════

import os
import hashlib
import hmac
import json
import asyncio
import asyncpg
import redis.asyncio as redis
from datetime import datetime, timedelta
from typing import Optional, List
from contextlib import asynccontextmanager
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Header, Depends, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Config ─────────────────────────────────────────────────────
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
API_KEY = os.getenv("API_KEY", "")

# DB Config
DB_CONFIG = {
    "host": os.getenv("DB_HOST", "postgres"),
    "port": int(os.getenv("DB_PORT", "5432")),
    "database": os.getenv("DB_NAME", "altai_transfer"),
    "user": os.getenv("DB_USER", "altai_user"),
    "password": os.getenv("DB_PASSWORD", ""),
}

# Redis Config
REDIS_CONFIG = {
    "host": os.getenv("REDIS_HOST", "redis"),
    "port": int(os.getenv("REDIS_PORT", "6379")),
    "password": os.getenv("REDIS_PASSWORD", ""),
    "decode_responses": True,
}

# ЮKassa Config
YOOKASSA_SHOP_ID = os.getenv("YOOKASSA_SHOP_ID", "")
YOOKASSA_SECRET_KEY = os.getenv("YOOKASSA_SECRET_KEY", "")
YOOKASSA_RETURN_URL = os.getenv("YOOKASSA_RETURN_URL", "")

# ── Connection Pools ───────────────────────────────────────────
db_pool: Optional[asyncpg.Pool] = None
redis_client: Optional[redis.Redis] = None


async def get_db() -> asyncpg.Pool:
    """Получить пул соединений с PostgreSQL."""
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database not available")
    return db_pool


async def get_redis() -> redis.Redis:
    """Получить клиент Redis."""
    if redis_client is None:
        raise HTTPException(status_code=503, detail="Redis not available")
    return redis_client


async def validate_api_key(x_api_key: str = Header("")):
    """Проверка API-ключа от Bothost."""
    if not API_KEY:
        return True
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return True


# ── Telegram Auth ──────────────────────────────────────────────

def validate_init_data(init_data: str) -> dict:
    """
    Валидация Telegram WebApp initData через HMAC-SHA256.
    Возвращает {valid: bool, user: dict|null}
    """
    if not init_data or not isinstance(init_data, str):
        return {"valid": False, "user": None}

    # Dev mode
    if not BOT_TOKEN:
        return {"valid": True, "user": None}

    try:
        params = {}
        for pair in init_data.split("&"):
            if "=" in pair:
                key, value = pair.split("=", 1)
                params[key] = unquote(value)

        received_hash = params.pop("hash", None)
        if not received_hash:
            return {"valid": False, "user": None}

        # Sort keys alphabetically
        data_check_parts = []
        for key in sorted(params.keys()):
            data_check_parts.append(f"{key}={params[key]}")
        data_check_string = "\n".join(data_check_parts)

        # HMAC validation
        secret = hmac.new(
            b"WebAppData",
            BOT_TOKEN.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        check_hash = hmac.new(
            secret,
            data_check_string.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(check_hash, received_hash):
            return {"valid": False, "user": None}

        # Parse user data
        user = None
        if "user" in params:
            user = json.loads(params["user"])

        return {"valid": True, "user": user}

    except Exception:
        return {"valid": False, "user": None}


def get_user_from_init_data(init_data: str) -> Optional[dict]:
    """Извлечь пользователя из initData."""
    result = validate_init_data(init_data)
    return result.get("user") if result["valid"] else None


# ── Pydantic Models ────────────────────────────────────────────

class RouteResponse(BaseModel):
    id: str
    name: str
    from_location: str
    to_location: str
    distance: Optional[int] = None
    duration: Optional[str] = None
    price: int
    created_at: Optional[datetime] = None


class DriverResponse(BaseModel):
    id: str
    name: str
    phone: Optional[str] = None
    car: Optional[str] = None
    year: Optional[int] = None
    color: Optional[str] = None
    rating: float = 5.0
    orders_count: int = 0
    photo_url: Optional[str] = None
    is_active: bool = True


class OrderCreate(BaseModel):
    initData: str
    route_id: str
    driver_id: str
    date: str  # YYYY-MM-DD
    time: Optional[str] = None  # HH:MM
    passengers: int = 1
    price: int
    user_phone: Optional[str] = None
    comment: Optional[str] = None


class OrderResponse(BaseModel):
    id: int
    user_id: str
    user_name: Optional[str] = None
    user_phone: Optional[str] = None
    route_id: str
    driver_id: str
    date: str
    time: Optional[str] = None
    passengers: int = 1
    price: int
    status: str = "PENDING"
    comment: Optional[str] = None
    created_at: Optional[datetime] = None
    route_name: Optional[str] = None
    from_location: Optional[str] = None
    to_location: Optional[str] = None
    driver_name: Optional[str] = None
    driver_car: Optional[str] = None
    driver_phone: Optional[str] = None


class OrderStatusUpdate(BaseModel):
    status: str = Field(..., pattern=r"^(PENDING|CONFIRMED|COMPLETED|CANCELLED)$")


class PaymentCreate(BaseModel):
    order_id: int
    return_url: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    database: str
    redis: str
    version: str = "2.0.0"


# ── Lifespan (startup/shutdown) ────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Инициализация и завершение работы приложения."""
    global db_pool, redis_client

    # Startup
    try:
        db_pool = await asyncpg.create_pool(
            **DB_CONFIG,
            min_size=2,
            max_size=10,
            command_timeout=10,
        )
        print("[DB] PostgreSQL pool created")
    except Exception as e:
        print(f"[DB] Error connecting to PostgreSQL: {e}")

    try:
        redis_client = redis.Redis(**REDIS_CONFIG)
        await redis_client.ping()
        print("[Redis] Connected")
    except Exception as e:
        print(f"[Redis] Error connecting to Redis: {e}")

    yield

    # Shutdown
    if db_pool:
        await db_pool.close()
        print("[DB] PostgreSQL pool closed")
    if redis_client:
        await redis_client.close()
        print("[Redis] Connection closed")


# ── FastAPI App ────────────────────────────────────────────────

app = FastAPI(
    title="Алтай Трансфер API",
    description="API для Telegram Mini App — трансферный маркетплейс Горного Алтая",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
)


# ── API Endpoints ──────────────────────────────────────────────

@app.get("/api/health", response_model=HealthResponse)
async def health_check():
    """Проверка здоровья сервиса."""
    db_status = "ok"
    redis_status = "ok"

    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
        except Exception:
            db_status = "error"
    else:
        db_status = "not_connected"

    if redis_client:
        try:
            await redis_client.ping()
        except Exception:
            redis_status = "error"
    else:
        redis_status = "not_connected"

    return HealthResponse(
        status="ok",
        timestamp=datetime.utcnow().isoformat() + "Z",
        database=db_status,
        redis=redis_status,
    )


@app.get("/api/routes", response_model=List[RouteResponse])
async def get_routes(pool: asyncpg.Pool = Depends(get_db)):
    """Получить список всех маршрутов, отсортированных по цене."""
    rows = await pool.fetch(
        "SELECT * FROM routes WHERE is_active = TRUE ORDER BY price ASC"
    )
    return [dict(r) for r in rows]


@app.get("/api/drivers", response_model=List[DriverResponse])
async def get_drivers(pool: asyncpg.Pool = Depends(get_db)):
    """Получить список активных водителей, отсортированных по рейтингу."""
    rows = await pool.fetch(
        "SELECT * FROM drivers WHERE is_active = TRUE ORDER BY rating DESC"
    )
    return [dict(r) for r in rows]


@app.post("/api/orders", response_model=OrderResponse, status_code=201)
async def create_order(
    order: OrderCreate,
    pool: asyncpg.Pool = Depends(get_db),
):
    """Создать новый заказ (требует авторизации Telegram)."""
    # Validate initData
    user = get_user_from_init_data(order.initData)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized: invalid initData")

    user_id = str(user.get("id", ""))
    user_name = " ".join(
        filter(None, [user.get("first_name"), user.get("last_name")])
    ) or None

    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized: user not found")

    # Validate required fields
    if not order.route_id or not order.driver_id or not order.date or not order.price:
        raise HTTPException(
            status_code=400,
            detail="Missing required fields: route_id, driver_id, date, price",
        )

    try:
        # Insert or update user
        await pool.execute(
            """
            INSERT INTO users (telegram_id, username, first_name, last_name)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (telegram_id) DO UPDATE SET
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name,
                updated_at = CURRENT_TIMESTAMP
            """,
            user.get("id"),
            user.get("username"),
            user.get("first_name"),
            user.get("last_name"),
        )

        # Create order
        row = await pool.fetchrow(
            """
            INSERT INTO orders (
                user_id, user_name, user_phone, route_id, driver_id,
                date, time, passengers, price, status, comment
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10)
            RETURNING *
            """,
            user_id,
            user_name,
            order.user_phone,
            order.route_id,
            order.driver_id,
            order.date,
            order.time,
            order.passengers,
            order.price,
            order.comment,
        )

        # Get enriched order data
        enriched = await pool.fetchrow(
            """
            SELECT o.*,
                   r.name as route_name, r.from_location, r.to_location,
                   d.name as driver_name, d.car as driver_car, d.phone as driver_phone
            FROM orders o
            JOIN routes r ON o.route_id = r.id
            JOIN drivers d ON o.driver_id = d.id
            WHERE o.id = $1
            """,
            row["id"],
        )

        return dict(enriched)

    except asyncpg.ForeignKeyViolationError as e:
        raise HTTPException(status_code=400, detail=f"Invalid route_id or driver_id: {e}")
    except Exception as e:
        if DEBUG:
            raise HTTPException(status_code=500, detail=str(e))
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/orders", response_model=List[OrderResponse])
async def get_user_orders(
    initData: str = Query(...),
    pool: asyncpg.Pool = Depends(get_db),
):
    """Получить заказы текущего пользователя (требует авторизации)."""
    user = get_user_from_init_data(initData)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized: invalid initData")

    user_id = str(user.get("id", ""))
    if not user_id:
        raise HTTPException(status_code=401, detail="Unauthorized: user not found")

    rows = await pool.fetch(
        """
        SELECT o.*,
               r.name as route_name, r.from_location, r.to_location,
               d.name as driver_name, d.car as driver_car, d.phone as driver_phone
        FROM orders o
        JOIN routes r ON o.route_id = r.id
        JOIN drivers d ON o.driver_id = d.id
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC
        """,
        user_id,
    )
    return [dict(r) for r in rows]


@app.get("/api/orders/{order_id}", response_model=OrderResponse)
async def get_order_by_id(
    order_id: int,
    pool: asyncpg.Pool = Depends(get_db),
):
    """Получить заказ по ID."""
    row = await pool.fetchrow(
        """
        SELECT o.*,
               r.name as route_name, r.from_location, r.to_location,
               d.name as driver_name, d.car as driver_car, d.phone as driver_phone
        FROM orders o
        JOIN routes r ON o.route_id = r.id
        JOIN drivers d ON o.driver_id = d.id
        WHERE o.id = $1
        """,
        order_id,
    )

    if not row:
        raise HTTPException(status_code=404, detail="Order not found")

    return dict(row)


@app.get("/api/driver/orders")
async def get_driver_orders(
    driver_id: str = Query(...),
    status: Optional[str] = Query(None),
    pool: asyncpg.Pool = Depends(get_db),
):
    """Получить заказы водителя с опциональной фильтрацией по статусу."""
    valid_statuses = ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED"]

    if status and status not in valid_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}",
        )

    if status:
        rows = await pool.fetch(
            """
            SELECT o.*, r.name as route_name, r.from_location, r.to_location
            FROM orders o
            JOIN routes r ON o.route_id = r.id
            WHERE o.driver_id = $1 AND o.status = $2
            ORDER BY o.date DESC, o.time DESC
            """,
            driver_id,
            status,
        )
    else:
        rows = await pool.fetch(
            """
            SELECT o.*, r.name as route_name, r.from_location, r.to_location
            FROM orders o
            JOIN routes r ON o.route_id = r.id
            WHERE o.driver_id = $1
            ORDER BY o.date DESC, o.time DESC
            """,
            driver_id,
        )

    return [dict(r) for r in rows]


@app.post("/api/driver/orders/{order_id}/status")
async def update_order_status(
    order_id: int,
    update: OrderStatusUpdate,
    pool: asyncpg.Pool = Depends(get_db),
):
    """Обновить статус заказа."""
    # Check order exists
    existing = await pool.fetchval("SELECT id FROM orders WHERE id = $1", order_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")

    row = await pool.fetchrow(
        "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
        update.status,
        order_id,
    )

    # Get enriched data
    enriched = await pool.fetchrow(
        """
        SELECT o.*,
               r.name as route_name, r.from_location, r.to_location,
               d.name as driver_name, d.car as driver_car, d.phone as driver_phone
        FROM orders o
        JOIN routes r ON o.route_id = r.id
        JOIN drivers d ON o.driver_id = d.id
        WHERE o.id = $1
        """,
        order_id,
    )

    return dict(enriched)


@app.get("/api/driver/calendar")
async def get_driver_calendar(
    driver_id: str = Query(...),
    date: str = Query(...),
    pool: asyncpg.Pool = Depends(get_db),
):
    """Получить заказы водителя на конкретную дату."""
    rows = await pool.fetch(
        """
        SELECT o.*, r.name as route_name, r.from_location, r.to_location
        FROM orders o
        JOIN routes r ON o.route_id = r.id
        WHERE o.driver_id = $1 AND o.date = $2
        ORDER BY o.time ASC
        """,
        driver_id,
        date,
    )
    return [dict(r) for r in rows]


# ── Payment Endpoints (ЮKassa) ─────────────────────────────────

@app.post("/api/payments/create")
async def create_payment(
    payment: PaymentCreate,
    pool: asyncpg.Pool = Depends(get_db),
):
    """Создать платёж через ЮKassa."""
    if not YOOKASSA_SHOP_ID or not YOOKASSA_SECRET_KEY:
        raise HTTPException(status_code=501, detail="Payments not configured")

    # Get order details
    order = await pool.fetchrow(
        "SELECT * FROM orders WHERE id = $1", payment.order_id
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if order["payment_status"] == "PAID":
        raise HTTPException(status_code=400, detail="Order already paid")

    # Create ЮKassa payment via API
    import base64
    import aiohttp

    idempotence_key = hashlib.sha256(
        f"{payment.order_id}_{datetime.utcnow().timestamp()}".encode()
    ).hexdigest()

    return_url = payment.return_url or YOOKASSA_RETURN_URL or "https://t.me"

    payload = {
        "amount": {
            "value": f"{order['price']}.00",
            "currency": "RUB",
        },
        "confirmation": {
            "type": "redirect",
            "return_url": return_url,
        },
        "capture": True,
        "description": f"Трансфер {order['route_id']} — Заказ #{order['id']}",
        "metadata": {
            "order_id": str(order["id"]),
        },
    }

    auth_str = base64.b64encode(
        f"{YOOKASSA_SHOP_ID}:{YOOKASSA_SECRET_KEY}".encode()
    ).decode()

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.yookassa.ru/v3/payments",
                json=payload,
                headers={
                    "Authorization": f"Basic {auth_str}",
                    "Content-Type": "application/json",
                    "Idempotence-Key": idempotence_key,
                },
            ) as resp:
                yookassa_data = await resp.json()

                if resp.status != 200:
                    raise HTTPException(
                        status_code=resp.status,
                        detail=yookassa_data.get("description", "Payment creation failed"),
                    )

                # Save payment to DB
                await pool.execute(
                    """
                    INSERT INTO payments (order_id, yookassa_id, amount, currency, status, description, metadata)
                    VALUES ($1, $2, $3, 'RUB', $4, $5, $6)
                    ON CONFLICT (yookassa_id) DO NOTHING
                    """,
                    payment.order_id,
                    yookassa_data["id"],
                    order["price"],
                    yookassa_data["status"],
                    payload["description"],
                    json.dumps(yookassa_data),
                )

                # Update order payment_id
                await pool.execute(
                    "UPDATE orders SET payment_id = $1 WHERE id = $2",
                    yookassa_data["id"],
                    payment.order_id,
                )

                return {
                    "payment_id": yookassa_data["id"],
                    "status": yookassa_data["status"],
                    "confirmation_url": yookassa_data.get("confirmation", {})
                    .get("confirmation_url"),
                    "amount": order["price"],
                }

    except aiohttp.ClientError as e:
        raise HTTPException(status_code=502, detail=f"Payment gateway error: {str(e)}")


@app.post("/api/payments/webhook")
async def payment_webhook(
    data: dict,
    pool: asyncpg.Pool = Depends(get_db),
):
    """Webhook для уведомлений от ЮKassa о статусе платежа."""
    event = data.get("event", "")
    payment_obj = data.get("object", {})
    payment_id = payment_obj.get("id")

    if not payment_id:
        return {"status": "ignored"}

    # Map ЮKassa status to our status
    yookassa_status = payment_obj.get("status", "")
    status_map = {
        "succeeded": "PAID",
        "canceled": "FAILED",
        "refunded": "REFUNDED",
    }
    payment_status = status_map.get(yookassa_status, "PENDING")

    # Update payment record
    await pool.execute(
        """
        UPDATE payments
        SET status = $1,
            payment_method = $2,
            paid_at = CASE WHEN $1 = 'succeeded' THEN CURRENT_TIMESTAMP ELSE paid_at END,
            metadata = $3,
            updated_at = CURRENT_TIMESTAMP
        WHERE yookassa_id = $4
        """,
        yookassa_status,
        payment_obj.get("payment_method", {}).get("type"),
        json.dumps(payment_obj),
        payment_id,
    )

    # Update order payment status
    await pool.execute(
        """
        UPDATE orders
        SET payment_status = $1,
            status = CASE
                WHEN $1 = 'PAID' AND status = 'PENDING' THEN 'CONFIRMED'
                ELSE status
            END
        WHERE payment_id = $2
        """,
        payment_status,
        payment_id,
    )

    return {"status": "processed"}


# ── Admin / Bothost Proxy Endpoints ────────────────────────────

@app.get("/api/admin/stats")
async def get_stats(
    _: bool = Depends(validate_api_key),
    pool: asyncpg.Pool = Depends(get_db),
):
    """Статистика для админ-панели (требует API key)."""
    total_orders = await pool.fetchval("SELECT COUNT(*) FROM orders")
    total_users = await pool.fetchval("SELECT COUNT(*) FROM users")
    total_drivers = await pool.fetchval(
        "SELECT COUNT(*) FROM drivers WHERE is_active = TRUE"
    )
    revenue = await pool.fetchval(
        "SELECT COALESCE(SUM(price), 0) FROM orders WHERE status = 'COMPLETED'"
    )

    return {
        "total_orders": total_orders,
        "total_users": total_users,
        "total_drivers": total_drivers,
        "total_revenue": revenue,
    }


# ── Main Entry ─────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=DEBUG,
        log_level="info",
    )
