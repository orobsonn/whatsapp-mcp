FROM --platform=linux/amd64 python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 TIKTOKEN_CACHE_DIR=/opt/tokenizers
WORKDIR /app
COPY requirements.lock build.lock ./
RUN pip install --no-cache-dir --require-hashes -r build.lock && pip install --no-cache-dir --no-build-isolation --require-hashes -r requirements.lock
COPY precache.py ./
RUN python precache.py && useradd --uid 10001 --create-home assistant && mkdir /data && chown assistant:assistant /data
COPY server.py backend.py ./
COPY Dockerfile build-fingerprint.json ./
USER 10001:10001
EXPOSE 8080
CMD ["python", "server.py"]
