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

# 所有服务端模块都要进镜像：server.py 会 import extractor / llm / surprisal / scheduler，
# 少拷一个就是启动即崩（旧版这里只拷了 5 个文件）。
COPY schema.sql *.py seeds.json ./
COPY static ./static

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

# 不用 root 跑：记忆库是私密数据
RUN useradd -r -u 10001 -m cmem && chown -R cmem:cmem /data /app
USER cmem

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=4).status==200 else 1)"

CMD ["python", "server.py"]
