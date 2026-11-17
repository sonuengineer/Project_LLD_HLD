# Build context = repository root. Roles: api | dispatcher | receiver (demo consumer).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY projects/04-webhooks/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY shared /opt/shared
RUN pip install --no-cache-dir --no-deps /opt/shared
COPY projects/04-webhooks/webhooks ./webhooks
COPY projects/04-webhooks/migrations ./migrations
COPY projects/04-webhooks/alembic.ini ./alembic.ini
RUN useradd --uid 10001 app
USER app
EXPOSE 8000
CMD ["uvicorn", "webhooks.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
