# 역할: 비공개 PaddleOCR provider 서비스 이미지를 만들고, 한국어 model을 미리 넣어 manifest로 고정함.
# PaddlePaddle CPU runtime은 여기서 Linux x86_64 기준으로 설치·검증함.
FROM --platform=linux/amd64 python:3.11.17-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PADDLE_OCR_SERVICE_HOST=0.0.0.0 \
    PADDLE_OCR_SERVICE_PORT=8000 \
    PADDLE_OCR_MODEL_LANGUAGE=korean \
    PADDLE_PDX_CACHE_HOME=/home/paddleocr/.paddlex \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True

# libgomp는 CPU Paddle runtime에, glib·libGL은 PaddleOCR contrib wheel을 포함한
# OpenCV에 필요함. 실행용 자격증명은 넣지 않음.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libglib2.0-0 libgomp1 libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin paddleocr

WORKDIR /app

COPY pyproject.toml ./
COPY app ./app

# 직접 의존 runtime 버전은 검증된 CPU smoke와 같음. 간접 의존성과 상류 model
# byte는 완전한 lock이 아니라 build된 이미지 안에 기록됨.
RUN pip install --no-cache-dir . \
    && chown --recursive paddleocr:paddleocr /app \
    && mkdir --parents /home/paddleocr/.paddlex/func_ret \
        /home/paddleocr/.paddlex/locks /home/paddleocr/.paddlex/temp \
    && chown --recursive paddleocr:paddleocr /home/paddleocr/.paddlex

USER paddleocr

# 실행 사용자로 한국어 pipeline model 2개를 이미지에 넣음. build에는 model 다운로드
# 접근이 필요하지만, 배포된 서비스는 그 접근 없이 이 파일을 씀.
# model이나 예열 추론이 실패하면 배포 전에 이미지 build가 실패함.
RUN paddle-ocr-smoke

# 이 이미지에 들어간 model 파일을 기록하고 검증함. 검증한 불변 이미지 digest를
# 배포하며, 이 manifest가 원격 재build 결과를 고정하지는 않음.
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

# model byte는 읽기 전용으로 두고, PaddleX의 일반 lock/function/temp cache만
# UID 10001이 쓸 수 있게 둠. 서비스는 고객 이미지 파일을 mount하지 않음.
RUN chown --recursive root:root /home/paddleocr/.paddlex/official_models \
    && chown root:root /home/paddleocr/.paddlex/model-manifest.json \
    && chmod --recursive a-w /home/paddleocr/.paddlex/official_models \
    && chmod a-w /home/paddleocr/.paddlex/model-manifest.json

USER paddleocr

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=120s --retries=3 \
    CMD python -c "import sys, urllib.request; response = urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2); sys.exit(0 if response.status == 200 else 1)"

CMD ["paddle-ocr-api"]
