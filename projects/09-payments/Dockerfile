# Build context = repository root. Roles: api | worker | migrate | provider (mock).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY projects/09-payments/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY shared /opt/shared
RUN pip install --no-cache-dir --no-deps /opt/shared
COPY projects/09-payments/payments ./payments
COPY projects/09-payments/mockprovider ./mockprovider
COPY projects/09-payments/migrations ./migrations
COPY projects/09-payments/alembic.ini ./alembic.ini
RUN useradd --uid 10001 app
USER app
EXPOSE 8000
CMD ["uvicorn", "payments.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
