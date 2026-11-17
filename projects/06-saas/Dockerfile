# Build context = repository root. Roles: api (default) | worker | migrate.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY projects/06-saas/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY shared /opt/shared
RUN pip install --no-cache-dir --no-deps /opt/shared
COPY projects/06-saas/saas ./saas
COPY projects/06-saas/migrations ./migrations
COPY projects/06-saas/alembic.ini ./alembic.ini
RUN useradd --uid 10001 app
USER app
EXPOSE 8000
CMD ["uvicorn", "saas.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
