# Build context = repository root. One container runs the API + an in-process 3-broker cluster.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY projects/05-mini-kafka/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY shared /opt/shared
RUN pip install --no-cache-dir --no-deps /opt/shared
COPY projects/05-mini-kafka/minikafka ./minikafka
RUN useradd --uid 10001 app && mkdir /data && chown app /data
USER app
VOLUME /data
ENV MK_DATA_DIR=/data MK_BROKERS=3
EXPOSE 8000
CMD ["uvicorn", "minikafka.api.app:app_from_env", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
