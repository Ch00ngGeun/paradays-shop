"""Fail-closed verification of the model manifest baked by the Dockerfile.

Local development also needs the baked cache and manifest; there is no bypass.
The runtime inventory is build provenance, not a second dependency lock.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from contextlib import contextmanager
from pathlib import Path


BAKED_CACHE = Path("/home/paddleocr/.paddlex")
EXPECTED_MODELS = frozenset({"PP-OCRv5_server_det", "korean_PP-OCRv5_mobile_rec"})
REQUIRED_FILES = ("inference.json", "inference.pdiparams", "inference.yml")
MAX_MANIFEST_BYTES = 4 * 1024 * 1024


class ArtifactIntegrityError(RuntimeError):
    """Model integrity could not be established; contains no filesystem details."""


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ArtifactIntegrityError
        result[key] = value
    return result


def _invalid_constant(value):
    raise ArtifactIntegrityError


@contextmanager
def _directory(path: Path):
    """Open every absolute path component without following any symlink."""
    path = path.absolute()
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.parts[1:]:
            child = os.open(
                component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
            )
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def verify_baked_model_artifacts() -> None:
    """Verify fixed baked files and prevent selecting an unverified cache."""
    effective_cache = os.environ.get("PADDLE_PDX_CACHE_HOME")
    if effective_cache is None:
        effective_cache = str(Path.home() / ".paddlex")
    if effective_cache != str(BAKED_CACHE):
        raise ArtifactIntegrityError from None
    verify_model_artifacts(BAKED_CACHE)


def verify_model_artifacts(cache: Path) -> None:
    """Validate a Docker-format manifest and its complete model file inventory."""
    try:
        with _directory(cache) as cache_fd:
            fd = os.open(
                "model-manifest.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                dir_fd=cache_fd,
            )
            with os.fdopen(fd, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ArtifactIntegrityError
                raw = stream.read(MAX_MANIFEST_BYTES + 1)
            if len(raw) > MAX_MANIFEST_BYTES:
                raise ArtifactIntegrityError
            manifest = json.loads(
                raw, object_pairs_hook=_unique_object, parse_constant=_invalid_constant
            )
            if not isinstance(manifest, dict) or set(manifest) != {"runtime", "artifacts"}:
                raise ArtifactIntegrityError
            if not isinstance(manifest["runtime"], dict):
                raise ArtifactIntegrityError
            artifacts = manifest["artifacts"]
            if not isinstance(artifacts, dict) or not artifacts:
                raise ArtifactIntegrityError
            for relative, record in artifacts.items():
                parts = relative.split("/")
                if (
                    "\\" in relative
                    or len(parts) < 2
                    or parts[0] not in EXPECTED_MODELS
                    or any(part in {"", ".", "..", ".cache"} for part in parts)
                    or not isinstance(record, dict)
                    or set(record) != {"bytes", "sha256"}
                    or type(record["bytes"]) is not int
                    or record["bytes"] < 0
                    or not isinstance(record["sha256"], str)
                    or re.fullmatch(r"[0-9a-f]{64}", record["sha256"]) is None
                ):
                    raise ArtifactIntegrityError
            for model in EXPECTED_MODELS:
                for required in REQUIRED_FILES:
                    record = artifacts.get(f"{model}/{required}")
                    if record is None or record["bytes"] == 0:
                        raise ArtifactIntegrityError

            models_fd = os.open(
                "official_models", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=cache_fd,
            )
            try:
                if set(os.listdir(models_fd)) != EXPECTED_MODELS:
                    raise ArtifactIntegrityError
                found = set()
                _verify_directory(models_fd, (), artifacts, found)
                if found != set(artifacts):
                    raise ArtifactIntegrityError
            finally:
                os.close(models_fd)
    except Exception:
        raise ArtifactIntegrityError from None


def _verify_directory(directory_fd, prefix, artifacts, found):
    for name in os.listdir(directory_fd):
        parts = prefix + (name,)
        entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(entry.st_mode):
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                _verify_directory(fd, parts, artifacts, found)
            finally:
                os.close(fd)
        elif stat.S_ISREG(entry.st_mode):
            # Docker excludes downloader metadata, but symlinks/special files in
            # these directories are still rejected by this traversal.
            if ".cache" in parts:
                continue
            relative = "/".join(parts)
            record = artifacts.get(relative)
            if record is None:
                raise ArtifactIntegrityError
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            with os.fdopen(fd, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_size != record["bytes"]:
                    raise ArtifactIntegrityError
                digest = hashlib.sha256()
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
                if digest.hexdigest() != record["sha256"]:
                    raise ArtifactIntegrityError
            found.add(relative)
        else:
            raise ArtifactIntegrityError
