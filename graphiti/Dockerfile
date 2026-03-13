FROM python:3.12-slim

WORKDIR /app

# Install system deps for FalkorDB client + healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && apt-get update && apt-get purge -y --auto-remove gcc \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home appuser
USER appuser

COPY . .

EXPOSE 3200

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3200"]
