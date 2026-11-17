# Build context = repository root.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY projects/08-collab/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY shared /opt/shared
RUN pip install --no-cache-dir --no-deps /opt/shared
COPY projects/08-collab/collab ./collab
COPY projects/08-collab/migrations ./migrations
COPY projects/08-collab/alembic.ini ./alembic.ini
RUN useradd --uid 10001 app
USER app
EXPOSE 8000
CMD ["uvicorn", "collab.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "websockets-sansio", "--no-access-log"]
