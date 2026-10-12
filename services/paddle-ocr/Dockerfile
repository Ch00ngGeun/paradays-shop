# PaddlePaddle's CPU runtime is packaged and tested for Linux x86_64 here.
FROM --platform=linux/amd64 python:3.11.17-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PADDLE_OCR_SERVICE_HOST=0.0.0.0 \
    PADDLE_OCR_SERVICE_PORT=8000 \
    PADDLE_OCR_MODEL_LANGUAGE=korean \
    PADDLE_PDX_CACHE_HOME=/home/paddleocr/.paddlex \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True

# libgomp is required by the CPU Paddle runtime; glib and libGL are needed by
# OpenCV, including PaddleOCR's contrib wheel. No runtime credential is included.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libglib2.0-0 libgomp1 libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin paddleocr

WORKDIR /app

COPY pyproject.toml ./
COPY app ./app

# Direct runtime versions match the validated CPU smoke. Transitive dependencies
# and upstream model bytes are recorded in the built image, not a complete lock.
RUN pip install --no-cache-dir . \
    && chown --recursive paddleocr:paddleocr /app \
    && mkdir --parents /home/paddleocr/.paddlex/func_ret \
        /home/paddleocr/.paddlex/locks /home/paddleocr/.paddlex/temp \
    && chown --recursive paddleocr:paddleocr /home/paddleocr/.paddlex

USER paddleocr

# Bake the two Korean pipeline models into the image as the runtime user. Builds
# need model-download access; the deployed service uses these files without it.
# A model or warm-inference failure fails the image build before it can deploy.
RUN paddle-ocr-smoke

# Record and verify the model artifacts shipped in this particular image. Deploy
# the tested immutable image digest; this manifest does not pin remote rebuilds.
RUN python - <<'PY'
import hashlib
import importlib.metadata
import json
from pathlib import Path

cache = Path("/home/paddleocr/.paddlex")
models = cache / "official_models"
expected_models = {"PP-OCRv5_server_det", "korean_PP-OCRv5_mobile_rec"}
if {path.name for path in models.iterdir() if path.is_dir()} != expected_models:
    raise SystemExit("Unexpected OCR model artifacts")

def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

artifacts = {}
for name in sorted(expected_models):
    directory = models / name
    for required in ("inference.json", "inference.pdiparams", "inference.yml"):
        path = directory / required
        if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
            raise SystemExit("Missing OCR model artifacts")
    for path in sorted(directory.rglob("*")):
        if ".cache" in path.relative_to(directory).parts:
            continue
        if path.is_symlink():
            raise SystemExit("Unexpected OCR model symlink")
        if path.is_file():
            artifacts[path.relative_to(models).as_posix()] = {
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }

runtime = {
    distribution.metadata["Name"]: distribution.version
    for distribution in importlib.metadata.distributions()
}
manifest = cache / "model-manifest.json"
manifest.write_text(
    json.dumps({"runtime": runtime, "artifacts": artifacts}, sort_keys=True, indent=2)
    + "\n",
    encoding="utf-8",
)
for relative, expected in json.loads(manifest.read_text(encoding="utf-8"))["artifacts"].items():
    path = models / relative
    if path.stat().st_size != expected["bytes"] or sha256(path) != expected["sha256"]:
        raise SystemExit("OCR model integrity check failed")
PY

USER root

# Keep model bytes read-only while PaddleX's generic lock/function/temp cache
# remains writable to UID 10001. The service never mounts customer image files.
RUN chown --recursive root:root /home/paddleocr/.paddlex/official_models \
    && chown root:root /home/paddleocr/.paddlex/model-manifest.json \
    && chmod --recursive a-w /home/paddleocr/.paddlex/official_models \
    && chmod a-w /home/paddleocr/.paddlex/model-manifest.json

USER paddleocr

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=120s --retries=3 \
    CMD python -c "import sys, urllib.request; response = urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2); sys.exit(0 if response.status == 200 else 1)"

CMD ["paddle-ocr-api"]
