"""Typed configuration for the private PaddleOCR service."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read service configuration from PADDLE_OCR_* environment variables."""

    model_config = SettingsConfigDict(
        env_prefix="PADDLE_OCR_",
        case_sensitive=False,
        extra="ignore",
    )

    service_host: str = "0.0.0.0"
    service_port: int = Field(default=8080, ge=1, le=65535)
    log_level: Literal["critical", "error", "warning", "info", "debug"] = "info"
    model_language: str = Field(default="korean", min_length=1, max_length=64)
    preload_model: bool = True
    shared_secret: SecretStr | None = Field(default=None, repr=False)


@lru_cache
def get_settings() -> Settings:
    """Return one validated settings instance per process."""

    return Settings()
