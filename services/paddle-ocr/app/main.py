# 역할: 인증된 제한 크기 이미지 요청만 받아 PaddleOCR를 실행하는 비공개 FastAPI 진입점임.
"""Private FastAPI entry point for the PaddleOCR provider service.

The service accepts only authenticated, bounded in-memory image requests and
returns the narrow OCR provider response expected by the commerce Lambda.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Final

import uvicorn
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from .artifact_integrity import ArtifactIntegrityError, verify_baked_model_artifacts
from .image_validation import (
    MAX_OCR_REQUEST_BYTES,
    InvalidOcrRequest,
    OcrImageTooLarge,
    UnsupportedOcrImage,
    ValidatedOcrImage,
    parse_ocr_request,
)
from .ocr_engine import (
    OcrInferenceError,
    OcrInputDecodeError,
    preload_ocr_engine,
    run_ocr_in_memory,
)
from .settings import Settings, get_settings


logger = logging.getLogger(__name__)

# Lambda는 provider 요청을 12초 뒤 중단함. provider는 그보다 먼저 응답하고,
# CPU를 쓰는 native 추론은 한 번에 하나만 받음.
OCR_RESPONSE_DEADLINE_SECONDS: Final = 9.0
OCR_MAX_CONCURRENT_INFERENCES: Final = 1


class _OcrInferenceBusy(RuntimeError):
    """A request arrived while the sole in-process OCR worker was still busy."""


class _OcrInferenceDeadlineExceeded(RuntimeError):
    """A response deadline elapsed while native OCR may still be executing."""


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Try to preload PaddleOCR without taking down the liveness endpoint."""

    settings: Settings = app.state.settings
    app.state.ocr_engine = None
    app.state.ocr_preload_failed = False
    app.state.ocr_executor = ThreadPoolExecutor(
        max_workers=OCR_MAX_CONCURRENT_INFERENCES,
        thread_name_prefix="paradays-ocr",
    )
    app.state.ocr_inference_gate = asyncio.BoundedSemaphore(
        OCR_MAX_CONCURRENT_INFERENCES
    )

    try:
        if not settings.preload_model:
            app.state.ocr_preload_failed = True
            logger.warning("PaddleOCR model preload is disabled; service is not ready")
        else:
            try:
                # 이미지에 포함된 한국어 model만 검증된 상태임. 다른 언어·cache 설정이
                # 검증되지 않은 model 다운로드를 일으키지 않게 함.
                if settings.model_language != "korean":
                    raise ArtifactIntegrityError
                verify_baked_model_artifacts()
                app.state.ocr_engine = preload_ocr_engine(settings.model_language)
                logger.info("PaddleOCR model preload completed")
            except Exception:
                # readiness는 일반 상태만 알리며, 이 서비스는 예외 trace·비밀값·
                # 파일 시스템 정보를 내보내지 않음.
                app.state.ocr_preload_failed = True
                logger.warning("PaddleOCR model preload failed; service remains live")

        yield
    finally:
        # 특정 PaddleOCR 종료 API를 가정하지 않음. 프로세스가 쥔 참조를 놓는 방식은
        # 지원 버전 전반에서 안전함.
        app.state.ocr_engine = None
        executor = app.state.ocr_executor
        app.state.ocr_executor = None
        app.state.ocr_inference_gate = None
        executor.shutdown(wait=False, cancel_futures=True)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the provider API without exposing configuration or OCR internals."""

    app = FastAPI(
        title="Paradays PaddleOCR provider",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings or get_settings()
    app.state.ocr_engine: Any | None = None
    app.state.ocr_preload_failed = False
    app.state.ocr_executor: ThreadPoolExecutor | None = None
    app.state.ocr_inference_gate: asyncio.BoundedSemaphore | None = None

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> JSONResponse:
        """Return process liveness even when PaddleOCR cannot be initialized."""

        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "ok"})

    @app.get("/readyz", include_in_schema=False)
    async def readyz() -> JSONResponse:
        """Return readiness only after a PaddleOCR engine has loaded."""

        if app.state.ocr_engine is None:
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={"status": "not_ready"},
            )

        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"status": "ready"},
        )

    @app.post("/ocr", include_in_schema=False)
    async def ocr(request: Request) -> JSONResponse:
        """Authenticate, validate, and run bounded in-memory OCR work."""

        expected_secret = _read_configured_shared_secret(app.state.settings)

        if expected_secret is None:
            return _service_not_ready_response()

        provided_token = _read_bearer_token(request.headers.get("authorization"))

        if provided_token is None or not hmac.compare_digest(
            provided_token,
            expected_secret.encode("utf-8"),
        ):
            return _unauthorized_response()

        if not _is_json_content_type(request.headers.get("content-type")):
            return _invalid_request_response()

        try:
            body = await _read_bounded_request_body(request)
            validated_image = parse_ocr_request(body)
        except OcrImageTooLarge:
            return JSONResponse(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                content={"code": "OCR_IMAGE_TOO_LARGE"},
            )
        except UnsupportedOcrImage:
            return JSONResponse(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                content={"code": "UNSUPPORTED_OCR_IMAGE"},
            )
        except InvalidOcrRequest:
            return _invalid_request_response()

        # 인증된 요청은 OCR engine을 쓸 수 없는 동안에도 입력 검증 결과를 받아야 함.
        # 유효한 요청만 아래의 fail-closed 서비스 gate에 도달함.
        engine = app.state.ocr_engine

        if engine is None:
            return _service_not_ready_response()

        try:
            canonical_response = await _run_bounded_inference(
                app,
                engine,
                validated_image,
            )
        except OcrInputDecodeError:
            return _invalid_request_response()
        except _OcrInferenceBusy:
            return _ocr_busy_response()
        except _OcrInferenceDeadlineExceeded:
            return _ocr_timeout_response()
        except OcrInferenceError:
            return _ocr_unavailable_response()
        except Exception:
            # OCR 라이브러리 오류·입력 정보·traceback을 절대 노출하지 않음.
            return _ocr_unavailable_response()

        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content=canonical_response,
        )

    return app


app = create_app()


def _read_configured_shared_secret(settings: Settings) -> str | None:
    """Return a usable in-memory secret without exposing or normalizing its value."""

    configured_secret = settings.shared_secret

    if configured_secret is None:
        return None

    value = configured_secret.get_secret_value()

    if not value or any(character.isspace() for character in value):
        return None

    return value


def _read_bearer_token(authorization: str | None) -> bytes | None:
    """Read a single Bearer token without accepting whitespace or alternate schemes."""

    if not authorization or not authorization.startswith("Bearer "):
        return None

    token = authorization[len("Bearer ") :]

    if not token or any(character.isspace() for character in token):
        return None

    try:
        return token.encode("utf-8")
    except UnicodeEncodeError:
        return None


async def _read_bounded_request_body(request: Request) -> bytes:
    """Read JSON only after authentication, with a hard cap for chunked bodies."""

    content_length = request.headers.get("content-length")

    try:
        if content_length is not None and int(content_length) > MAX_OCR_REQUEST_BYTES:
            raise OcrImageTooLarge
    except ValueError:
        # header가 없거나 잘못된 경우에는 아래 stream 상한이 최종 기준임.
        pass

    chunks: list[bytes] = []
    total_bytes = 0

    try:
        async for chunk in request.stream():
            total_bytes += len(chunk)

            if total_bytes > MAX_OCR_REQUEST_BYTES:
                raise OcrImageTooLarge

            chunks.append(chunk)
    except OcrImageTooLarge:
        raise
    except Exception:
        raise InvalidOcrRequest from None

    return b"".join(chunks)


async def _run_bounded_inference(
    app: FastAPI,
    engine: Any,
    image: ValidatedOcrImage,
) -> dict[str, Any]:
    """Run one CPU-bound OCR job with deadline-safe, non-queued admission.

    Python cancellation cannot stop a native Paddle/OpenCV worker thread. If a
    response reaches its deadline (or the client disconnects), the permit stays
    held until that exact future completes; no second job is submitted meanwhile.
    """

    executor = app.state.ocr_executor
    gate = app.state.ocr_inference_gate

    if executor is None or gate is None:
        raise OcrInferenceError

    # 이 검사는 await 전에 일어남. worker 1개 executor와 시간 초과 작업이 쥔
    # permit과 함께, CPU 작업 queue가 무한히 쌓이는 것을 막음.
    if gate.locked():
        raise _OcrInferenceBusy

    await gate.acquire()
    release_gate_here = True

    try:
        try:
            future = asyncio.get_running_loop().run_in_executor(
                executor,
                run_ocr_in_memory,
                engine,
                image,
            )
        except Exception:
            raise OcrInferenceError from None

        try:
            return await asyncio.wait_for(
                asyncio.shield(future),
                timeout=OCR_RESPONSE_DEADLINE_SECONDS,
            )
        except asyncio.TimeoutError:
            # shield가 native 작업을 계속 살려 둠. 이 응답이 아니라 그 작업의 완료
            # callback이 permit을 풀어 다음 요청을 허용함.
            release_gate_here = False
            future.add_done_callback(lambda done: _finish_abandoned_inference(done, gate))
            raise _OcrInferenceDeadlineExceeded from None
        except asyncio.CancelledError:
            # client 취소도 같은 비중첩 보장을 따라야 함.
            release_gate_here = False
            future.add_done_callback(lambda done: _finish_abandoned_inference(done, gate))
            raise
    finally:
        if release_gate_here:
            _release_inference_gate(gate)


def _finish_abandoned_inference(
    future: asyncio.Future, gate: asyncio.BoundedSemaphore
) -> None:
    """Consume a late native failure without logging it, then release its permit.

    Timeout/client cancellation abandons the shielded asyncio future, not its
    native work. Retrieving its exception prevents asyncio's unhandled-future
    logger from exposing runtime details. Normally awaited failures are unchanged.
    """

    try:
        if not future.cancelled():
            future.exception()
    finally:
        _release_inference_gate(gate)


def _release_inference_gate(gate: asyncio.BoundedSemaphore) -> None:
    """Release only the single permit held by the in-flight OCR future."""

    if gate.locked():
        gate.release()


def _is_json_content_type(content_type: str | None) -> bool:
    """Accept application/json with an optional charset parameter."""

    return bool(content_type) and content_type.split(";", 1)[0].strip().lower() == "application/json"


def _service_not_ready_response() -> JSONResponse:
    """Return the fail-closed response used when the shared engine is unavailable."""

    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"code": "OCR_SERVICE_NOT_READY"},
    )


def _unauthorized_response() -> JSONResponse:
    """Avoid distinguishing missing, malformed, and incorrect credentials."""

    return JSONResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        content={"code": "UNAUTHORIZED"},
        headers={"WWW-Authenticate": "Bearer"},
    )


def _invalid_request_response() -> JSONResponse:
    """Use one generic response for malformed request and encoded-image data."""

    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"code": "INVALID_OCR_REQUEST"},
    )


def _ocr_busy_response() -> JSONResponse:
    """Avoid queueing more native OCR work behind a stalled or active job."""

    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"code": "OCR_BUSY"},
    )


def _ocr_timeout_response() -> JSONResponse:
    """Return before the Lambda provider timeout without leaking engine details."""

    return JSONResponse(
        status_code=status.HTTP_504_GATEWAY_TIMEOUT,
        content={"code": "OCR_TIMEOUT"},
    )


def _ocr_unavailable_response() -> JSONResponse:
    """Collapse all safe inference/runtime failures into one public response."""

    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"code": "OCR_SERVICE_UNAVAILABLE"},
    )


def main() -> None:
    """Run the private OCR provider with its typed service settings."""

    settings = get_settings()
    uvicorn.run(
        create_app(settings),
        host=settings.service_host,
        port=settings.service_port,
        log_level=settings.log_level,
    )


if __name__ == "__main__":
    main()
