# Build context = repository root (so the shared bpcommon package can be copied in).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY projects/01-rate-limiter/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY shared /opt/shared
RUN pip install --no-cache-dir --no-deps /opt/shared
COPY projects/01-rate-limiter/ratelimiter ./ratelimiter
RUN useradd --uid 10001 app
USER app
EXPOSE 8000
CMD ["uvicorn", "ratelimiter.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
