# Build context = repository root.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY shared /opt/shared
RUN pip install --no-cache-dir /opt/shared
COPY projects/02-mini-redis/minidis ./minidis
RUN useradd --uid 10001 app && mkdir /data && chown app /data
USER app
VOLUME /data
EXPOSE 6380
CMD ["python", "-m", "minidis", "--host", "0.0.0.0", "--port", "6380", "--dir", "/data", "--appendonly", "yes"]
