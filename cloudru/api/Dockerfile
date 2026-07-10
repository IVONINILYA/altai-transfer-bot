# ═══════════════════════════════════════════════════════════════
#  Dockerfile — Алтай Трансфер API (FastAPI)
# ═══════════════════════════════════════════════════════════════

FROM python:3.11-slim

LABEL maintainer="Алтай Трансфer"
LABEL description="FastAPI backend для Cloud.ru"

# Установка зависимостей системы
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Рабочая директория
WORKDIR /app

# Копируем зависимости
COPY requirements.txt .

# Устанавливаем Python-зависимости
RUN pip install --no-cache-dir -r requirements.txt

# Копируем код
COPY main.py .

# Не-root пользователь для безопасности
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://localhost:8000/api/health || exit 1

# Запуск
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers"]
