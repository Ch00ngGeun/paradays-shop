"""Dependency-free model fixtures and actual lifespan code with API/runtime stubs."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


APP = Path(__file__).resolve().parents[1] / "app"
spec = importlib.util.spec_from_file_location("ocr_integrity_under_test", APP / "artifact_integrity.py")
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # macOS /var itself is a symlink; fixtures use the resolved absolute root.
        self.cache = Path(self.temp.name).resolve() / "cache"
        self.models = self.cache / "official_models"
        self.records = {}
        for model in integrity.EXPECTED_MODELS:
            for name in integrity.REQUIRED_FILES:
                relative = f"{model}/{name}"
                path = self.models / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                data = relative.encode()
                path.write_bytes(data)
                self.records[relative] = {
                    "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()
                }
        self.manifest = self.cache / "model-manifest.json"
        self.write_manifest()
        self.file = self.models / next(iter(self.records))

    def write_manifest(self):
        self.manifest.write_text(json.dumps({"runtime": {"PaddleOCR": "3.7.0"}, "artifacts": self.records}))

    def reject(self):
        with self.assertRaises(integrity.ArtifactIntegrityError) as result:
            integrity.verify_model_artifacts(self.cache)
        self.assertEqual(str(result.exception), "")
        self.assertTrue(result.exception.__suppress_context__)

    def test_valid_baked_shape(self):
        integrity.verify_model_artifacts(self.cache)

    def test_runtime_inventory_is_provenance(self):
        body = json.loads(self.manifest.read_text())
        body["runtime"] = {"PaddleOCR": "another-recorded-version"}
        self.manifest.write_text(json.dumps(body))
        integrity.verify_model_artifacts(self.cache)

    def test_same_size_corruption(self):
        self.file.write_bytes(b"x" * self.file.stat().st_size)
        self.reject()

    def test_size_mismatch(self):
        self.file.write_bytes(b"short")
        self.reject()

    def test_missing_artifact(self):
        self.file.unlink()
        self.reject()

    def test_missing_manifest(self):
        self.manifest.unlink()
        self.reject()

    def test_malformed_manifest(self):
        self.manifest.write_text("{broken")
        self.reject()

    def test_duplicate_key_manifest(self):
        self.manifest.write_text('{"runtime":{},"artifacts":{},"artifacts":{}}')
        self.reject()

    def test_nonstandard_json(self):
        self.manifest.write_text('{"runtime":{"version":NaN},"artifacts":{}}')
        self.reject()

    def test_invalid_schema(self):
        for body in ([], {}, {"runtime": [], "artifacts": self.records},
                     {"runtime": {}, "artifacts": {}}):
            with self.subTest(body=body):
                self.manifest.write_text(json.dumps(body))
                self.reject()

    def test_invalid_record(self):
        key = next(iter(self.records))
        for record in ({"bytes": True, "sha256": "a" * 64},
                       {"bytes": -1, "sha256": "a" * 64},
                       {"bytes": 1, "sha256": "no"},
                       {"bytes": 1, "sha256": "a" * 64, "extra": 1}):
            with self.subTest(record=record):
                self.records[key] = record
                self.write_manifest()
                self.reject()

    def test_path_escape(self):
        record = next(iter(self.records.values()))
        model = next(iter(integrity.EXPECTED_MODELS))
        for key in ("/tmp/evil", "../evil", f"{model}/../evil", f"{model}//evil",
                    f"{model}/./evil", f"{model}/\\evil", f"{model}/.cache/evil"):
            with self.subTest(key=key):
                self.records[key] = record
                self.write_manifest()
                self.reject()
                del self.records[key]

    def test_required_manifest_entry_missing(self):
        del self.records[next(iter(self.records))]
        self.write_manifest()
        self.reject()

    def test_required_artifact_empty(self):
        self.file.write_bytes(b"")
        key = self.file.relative_to(self.models).as_posix()
        self.records[key] = {"bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()}
        self.write_manifest()
        self.reject()

    def test_unlisted_file(self):
        (self.file.parent / "extra.bin").write_bytes(b"unverified")
        self.reject()

    def test_extra_model(self):
        (self.models / "another-model").mkdir()
        self.reject()

    def test_artifact_symlink(self):
        target = self.cache / "outside"
        target.write_bytes(self.file.read_bytes())
        self.file.unlink()
        self.file.symlink_to(target)
        self.reject()

    def test_model_directory_symlink(self):
        directory = self.file.parent
        target = self.cache / "moved-model"
        directory.rename(target)
        directory.symlink_to(target, target_is_directory=True)
        self.reject()

    def test_manifest_symlink(self):
        target = self.cache / "other-manifest"
        self.manifest.rename(target)
        self.manifest.symlink_to(target)
        self.reject()

    def test_cache_ancestor_symlink(self):
        target = self.cache.with_name("moved-cache")
        self.cache.rename(target)
        self.cache.symlink_to(target, target_is_directory=True)
        self.reject()

    def test_downloader_metadata_excluded(self):
        directory = self.file.parent / ".cache"
        directory.mkdir()
        (directory / "metadata").write_bytes(b"download info")
        integrity.verify_model_artifacts(self.cache)
        (directory / "linked").symlink_to(self.file)
        self.reject()

    def test_oversized_manifest(self):
        with patch.object(integrity, "MAX_MANIFEST_BYTES", 10):
            self.reject()

    def test_special_file(self):
        self.manifest.unlink()
        os.mkfifo(self.manifest)
        self.reject()

    def test_cache_override_rejected(self):
        with patch.dict(os.environ, {"PADDLE_PDX_CACHE_HOME": str(self.cache)}):
            with self.assertRaises(integrity.ArtifactIntegrityError):
                integrity.verify_baked_model_artifacts()

    def load_main(self):
        # Execute real main.py. Minimal API/settings stubs keep these tests runnable
        # with stdlib alone and avoid initializing/installing Paddle or FastAPI.
        package = types.ModuleType("ocr_test_app")
        package.__path__ = [str(APP)]
        fastapi = types.ModuleType("fastapi")

        class FakeApp:
            def __init__(self, **kwargs):
                self.state = types.SimpleNamespace()
                self.routes = {}

            def get(self, path, **kwargs):
                def decorate(fn):
                    self.routes[path] = fn
                    return fn
                return decorate

            post = get

        fastapi.FastAPI = FakeApp
        fastapi.Request = object
        fastapi.status = types.SimpleNamespace(HTTP_200_OK=200, HTTP_503_SERVICE_UNAVAILABLE=503)
        responses = types.ModuleType("fastapi.responses")
        responses.JSONResponse = lambda **kwargs: types.SimpleNamespace(**kwargs)
        settings = types.ModuleType("ocr_test_app.settings")
        settings.Settings = object
        settings.get_settings = lambda: types.SimpleNamespace(preload_model=True, model_language="korean")
        modules = {"ocr_test_app": package, "ocr_test_app.artifact_integrity": integrity,
                   "fastapi": fastapi, "fastapi.responses": responses,
                   "uvicorn": types.ModuleType("uvicorn"), "ocr_test_app.settings": settings}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location("ocr_test_app.main", APP / "main.py")
            main = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(main)
        return main

    def exercise_lifespan(self, valid, language="korean", preload=True):
        main = self.load_main()
        events = []

        def verify():
            events.append("verify")
            integrity.verify_baked_model_artifacts()

        def initialize(lang):
            events.append("initialize")
            return object()

        async def run():
            app = main.create_app(types.SimpleNamespace(preload_model=preload, model_language=language))
            with patch.object(main, "verify_baked_model_artifacts", side_effect=verify), \
                 patch.object(main, "preload_ocr_engine", side_effect=initialize), \
                 patch.object(integrity, "BAKED_CACHE", self.cache), \
                 patch.dict(os.environ, {"PADDLE_PDX_CACHE_HOME": str(self.cache)}):
                async with main.lifespan(app):
                    self.assertEqual(app.state.ocr_preload_failed, not valid)
                    self.assertEqual((await app.routes["/readyz"]()).status_code, 200 if valid else 503)
                    self.assertEqual((await app.routes["/healthz"]()).status_code, 200)
                    if not valid:
                        self.assertEqual((await app.routes["/readyz"]()).content, {"status": "not_ready"})
                self.assertIsNone(app.state.ocr_engine)
                self.assertIsNone(app.state.ocr_executor)
            return events

        return asyncio.run(run())

    def test_lifespan_verifies_before_initialization(self):
        self.assertEqual(self.exercise_lifespan(True), ["verify", "initialize"])

    def test_lifespan_corruption_blocks_initialization(self):
        self.file.write_bytes(b"corrupt")
        self.assertEqual(self.exercise_lifespan(False), ["verify"])

    def test_lifespan_missing_manifest_blocks_initialization(self):
        self.manifest.unlink()
        self.assertEqual(self.exercise_lifespan(False), ["verify"])

    def test_lifespan_malformed_manifest_blocks_initialization(self):
        self.manifest.write_text("not json")
        self.assertEqual(self.exercise_lifespan(False), ["verify"])

    def test_lifespan_other_language_blocks_initialization(self):
        self.assertEqual(self.exercise_lifespan(False, language="en"), [])

    def test_lifespan_preload_disabled_stays_not_ready(self):
        self.assertEqual(self.exercise_lifespan(False, preload=False), [])


if __name__ == "__main__":
    unittest.main()
