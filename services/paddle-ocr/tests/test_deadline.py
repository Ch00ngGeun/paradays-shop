"""Run actual main.py endpoint/gate/executor with a controlled native-work stub.

FastAPI/settings shells only register routes and hold responses. Admission,
shielding, deadlines, callbacks, body parsing and executor shutdown remain the
production implementation. No Paddle, decoder, ASGI server or network is used.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import importlib.util
import json
from pathlib import Path
import struct
import sys
import threading
import types
import unittest
from unittest.mock import patch


APP = Path(__file__).resolve().parents[1] / "app"
RESULT = {"result": {"ocrResults": [{"prunedResult": {
    "rec_texts": ["입고 2"], "rec_scores": [0.9], "rec_boxes": []
}}]}}


def load_main():
    package = types.ModuleType("ocr_deadline_app")
    package.__path__ = [str(APP)]
    fastapi = types.ModuleType("fastapi")

    class FakeApp:
        def __init__(self, **kwargs):
            self.state = types.SimpleNamespace()
            self.routes = {}

        def get(self, path, **kwargs):
            def register(fn):
                self.routes[path] = fn
                return fn
            return register

        post = get

    fastapi.FastAPI = FakeApp
    fastapi.Request = object
    fastapi.status = types.SimpleNamespace(
        HTTP_200_OK=200, HTTP_400_BAD_REQUEST=400, HTTP_401_UNAUTHORIZED=401,
        HTTP_413_REQUEST_ENTITY_TOO_LARGE=413, HTTP_415_UNSUPPORTED_MEDIA_TYPE=415,
        HTTP_503_SERVICE_UNAVAILABLE=503, HTTP_504_GATEWAY_TIMEOUT=504,
    )
    responses = types.ModuleType("fastapi.responses")
    responses.JSONResponse = lambda **kwargs: types.SimpleNamespace(**kwargs)
    settings = types.ModuleType("ocr_deadline_app.settings")
    settings.Settings = object
    settings.get_settings = lambda: types.SimpleNamespace(
        preload_model=True, model_language="korean",
        shared_secret=types.SimpleNamespace(get_secret_value=lambda: "test-only-secret"),
    )
    with patch.dict(sys.modules, {
        "ocr_deadline_app": package, "fastapi": fastapi,
        "fastapi.responses": responses, "ocr_deadline_app.settings": settings,
        "uvicorn": types.ModuleType("uvicorn"),
    }):
        spec = importlib.util.spec_from_file_location("ocr_deadline_app.main", APP / "main.py")
        main = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(main)
    return main


class Request:
    headers = {"authorization": "Bearer test-only-secret", "content-type": "application/json"}

    async def stream(self):
        # Real parse_ocr_request reads a valid bounded 1x1 PNG IHDR.
        image = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR" + struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0) + bytes(4)
        body = json.dumps({"file": base64.b64encode(image).decode(), "fileType": 1, "visualize": False}).encode()
        yield body[:20]
        yield body[20:]


class ControlledWorker:
    def __init__(self, loop):
        self.loop = loop
        self.started = asyncio.Event()
        self.allow_finish = threading.Event()
        self.finished = threading.Event()
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self.thread_ids = []
        self.error = None
        self.watchdog_expired = False

    def run(self, engine, image):
        self.calls += 1
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.thread_ids.append(threading.get_ident())
        self.loop.call_soon_threadsafe(self.started.set)
        try:
            if not self.allow_finish.wait(2):
                self.watchdog_expired = True
                raise RuntimeError("test worker watchdog")
            if self.error:
                raise self.error
            return RESULT
        finally:
            self.active -= 1
            self.finished.set()


class DeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.main = load_main()
        self.loop = asyncio.get_running_loop()
        self.worker = ControlledWorker(self.loop)
        self.app = self.main.create_app()
        self.patches = [
            patch.object(self.main, "verify_baked_model_artifacts"),
            patch.object(self.main, "preload_ocr_engine", return_value=object()),
            patch.object(self.main, "run_ocr_in_memory", side_effect=self.worker.run),
            patch.object(self.main, "OCR_RESPONSE_DEADLINE_SECONDS", 0.03),
        ]
        for item in self.patches:
            item.start()
        self.lifespan = self.main.lifespan(self.app)
        await self.lifespan.__aenter__()
        self.executor = self.app.state.ocr_executor
        self.gate = self.app.state.ocr_inference_gate
        self.releases = 0
        self.released = asyncio.Event()
        actual_release = self.main._release_inference_gate

        def observe_release(gate):
            actual_release(gate)
            self.releases += 1
            self.released.set()

        self.release_patch = patch.object(self.main, "_release_inference_gate", side_effect=observe_release)
        self.release_patch.start()
        self.tasks = []

    async def asyncTearDown(self):
        # Always free the controlled thread, even after an assertion fails.
        self.worker.allow_finish.set()
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.executor.shutdown(wait=True, cancel_futures=True)
        # Process real asyncio future completion/release callbacks before closing.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await self.lifespan.__aexit__(None, None, None)
        self.release_patch.stop()
        for item in reversed(self.patches):
            item.stop()
        self.assertFalse(self.worker.watchdog_expired)
        self.assertEqual(self.worker.active, 0)
        self.assertTrue(self.executor._shutdown)

    def start_request(self):
        task = asyncio.create_task(self.app.routes["/ocr"](Request()))
        self.tasks.append(task)
        return task

    async def wait_started(self):
        await asyncio.wait_for(self.worker.started.wait(), 0.5)
        self.assertTrue(self.gate.locked())

    async def complete_worker(self):
        self.worker.allow_finish.set()
        await asyncio.wait_for(self.released.wait(), 0.5)
        self.assertTrue(self.worker.finished.is_set())
        self.assertFalse(self.gate.locked())
        self.assertEqual(self.gate._value, 1)

    async def assert_busy(self):
        response = await self.app.routes["/ocr"](Request())
        self.assertEqual((response.status_code, response.content), (503, {"code": "OCR_BUSY"}))
        self.assertEqual(self.worker.calls, 1)
        self.assertEqual(self.releases, 0)

    async def assert_readmitted(self):
        response = await self.app.routes["/ocr"](Request())
        self.assertEqual((response.status_code, response.content), (200, RESULT))
        self.assertEqual(self.worker.calls, 2)
        self.assertEqual(self.worker.max_active, 1)
        self.assertEqual(self.releases, 2)
        self.assertEqual(self.gate._value, 1)

    async def test_configured_native_deadline_and_single_permit(self):
        unpatched = load_main()
        self.assertEqual(unpatched.OCR_RESPONSE_DEADLINE_SECONDS, 9.0)
        self.assertEqual(unpatched.OCR_MAX_CONCURRENT_INFERENCES, 1)
        self.assertEqual(self.gate._value, 1)

    async def test_success_runs_on_thread_and_releases_exactly_once(self):
        task = self.start_request()
        await self.wait_started()
        await self.complete_worker()
        response = await task
        self.assertEqual((response.status_code, response.content), (200, RESULT))
        self.assertEqual(self.releases, 1)
        self.assertNotEqual(self.worker.thread_ids[0], threading.get_ident())
        await self.assert_readmitted()

    async def test_overlap_is_busy_without_queueing_native_work(self):
        task = self.start_request()
        await self.wait_started()
        await self.assert_busy()
        await self.assert_busy()
        await self.complete_worker()
        self.assertEqual((await task).status_code, 200)
        await self.assert_readmitted()

    async def test_timeout_returns_504_before_native_finishes_and_retains_permit(self):
        task = self.start_request()
        await self.wait_started()
        response = await asyncio.wait_for(task, 0.5)
        self.assertEqual((response.status_code, response.content), (504, {"code": "OCR_TIMEOUT"}))
        self.assertFalse(self.worker.finished.is_set())
        self.assertTrue(self.gate.locked())
        await self.assert_busy()
        await self.complete_worker()
        self.assertEqual(self.releases, 1)
        await self.assert_readmitted()

    async def test_client_cancel_retains_native_permit_until_exact_worker_finishes(self):
        task = self.start_request()
        await self.wait_started()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(self.worker.finished.is_set())
        await self.assert_busy()
        await self.complete_worker()
        self.assertEqual(self.releases, 1)
        await self.assert_readmitted()

    async def test_native_failure_is_safe_and_releases_permit(self):
        self.worker.error = self.main.OcrInferenceError("private native detail")
        task = self.start_request()
        await self.wait_started()
        await self.complete_worker()
        response = await task
        self.assertEqual((response.status_code, response.content), (503, {"code": "OCR_SERVICE_UNAVAILABLE"}))
        self.assertEqual(self.releases, 1)
        self.worker.error = None
        await self.assert_readmitted()

    async def test_executor_submission_failure_releases_permit_without_worker(self):
        with patch.object(self.executor, "submit", side_effect=RuntimeError("private executor detail")):
            response = await self.app.routes["/ocr"](Request())
        self.assertEqual((response.status_code, response.content), (503, {"code": "OCR_SERVICE_UNAVAILABLE"}))
        self.assertEqual(self.releases, 1)
        self.assertEqual(self.worker.calls, 0)
        self.assertEqual(self.gate._value, 1)

    async def test_shutdown_while_native_running_preserves_old_gate_callback(self):
        task = self.start_request()
        await self.wait_started()
        self.assertEqual((await task).status_code, 504)
        await self.lifespan.__aexit__(None, None, None)
        self.assertIsNone(self.app.state.ocr_executor)
        self.assertIsNone(self.app.state.ocr_inference_gate)
        self.assertIsNone(self.app.state.ocr_engine)
        self.assertTrue(self.executor._shutdown)
        self.assertTrue(self.gate.locked())
        await self.complete_worker()
        self.assertEqual(self.releases, 1)
        response = await self.app.routes["/ocr"](Request())
        self.assertEqual((response.status_code, response.content), (503, {"code": "OCR_SERVICE_NOT_READY"}))

    async def test_timed_out_native_failure_is_consumed_without_unhandled_loop_error(self):
        contexts = []
        previous_handler = self.loop.get_exception_handler()
        self.loop.set_exception_handler(lambda loop, context: contexts.append(context))
        try:
            task = self.start_request()
            await self.wait_started()
            self.assertEqual((await task).status_code, 504)
            self.worker.error = self.main.OcrInferenceError("private native detail")
            await self.complete_worker()
            self.assertEqual(self.releases, 1)
            await asyncio.sleep(0)
            gc.collect()
            await asyncio.sleep(0)
            # An abandoned shielded future must not expose native exceptions via
            # asyncio's default logging when it finishes after the HTTP timeout.
            self.assertEqual(len(contexts), 0, "abandoned native future raised an unhandled loop error")
            self.worker.error = None
            await self.assert_readmitted()
            self.assertEqual((await self.app.routes["/healthz"]()).status_code, 200)
            self.assertEqual((await self.app.routes["/readyz"]()).status_code, 200)
        finally:
            self.loop.set_exception_handler(previous_handler)

    async def test_cancelled_client_native_failure_is_consumed_and_readmitted(self):
        contexts = []
        previous_handler = self.loop.get_exception_handler()
        self.loop.set_exception_handler(lambda loop, context: contexts.append(context))
        try:
            task = self.start_request()
            await self.wait_started()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.worker.error = RuntimeError("private native detail")
            await self.complete_worker()
            self.assertEqual(self.releases, 1)
            await asyncio.sleep(0)
            gc.collect()
            await asyncio.sleep(0)
            self.assertEqual(len(contexts), 0, "cancelled client's native failure was not consumed")
            self.worker.error = None
            await self.assert_readmitted()
        finally:
            self.loop.set_exception_handler(previous_handler)

    async def test_abandoned_completion_handles_cancelled_future_without_error(self):
        await self.gate.acquire()
        future = self.loop.create_future()
        future.cancel()
        self.main._finish_abandoned_inference(future, self.gate)
        self.assertEqual(self.releases, 1)
        self.assertEqual(self.gate._value, 1)


if __name__ == "__main__":
    unittest.main()
