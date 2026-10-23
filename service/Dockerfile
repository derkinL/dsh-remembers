FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CMEM_DATA_DIR=/data \
    CMEM_HOST=0.0.0.0 \
    CMEM_PORT=8080

WORKDIR /app

# numpy 是唯一的大依赖；用 slim + 只装 wheel，镜像约 200MB
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY schema.sql memory_core.py embedding.py server.py mcp_server.py backup.py ./

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

# 不用 root 跑：记忆库是私密数据
RUN useradd -r -u 10001 -m cmem && chown -R cmem:cmem /data /app
USER cmem

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=4).status==200 else 1)"

CMD ["python", "server.py"]
