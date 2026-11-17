# Build context = repository root. Roles: api (default) | worker | migrate.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY projects/07-object-storage/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY shared /opt/shared
RUN pip install --no-cache-dir --no-deps /opt/shared
COPY projects/07-object-storage/objstore ./objstore
COPY projects/07-object-storage/migrations ./migrations
COPY projects/07-object-storage/alembic.ini ./alembic.ini
RUN useradd --uid 10001 app && mkdir /blobs && chown app /blobs
USER app
EXPOSE 8000
CMD ["uvicorn", "objstore.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
