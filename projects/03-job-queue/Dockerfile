# Build context = repository root. One image, two roles (api / worker), chosen by command.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY projects/03-job-queue/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY shared /opt/shared
RUN pip install --no-cache-dir --no-deps /opt/shared
COPY projects/03-job-queue/jobqueue ./jobqueue
COPY projects/03-job-queue/migrations ./migrations
COPY projects/03-job-queue/alembic.ini ./alembic.ini
RUN useradd --uid 10001 app
USER app
EXPOSE 8000
CMD ["uvicorn", "jobqueue.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
