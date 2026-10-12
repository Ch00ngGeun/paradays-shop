"""Strict, stdlib-only validation for untrusted PaddleOCR request images."""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Final, Literal


MAX_IMAGE_BYTES: Final = 4 * 1024 * 1024
MAX_BASE64_CHARACTERS: Final = ((MAX_IMAGE_BYTES + 2) // 3) * 4
# A compressed 4 MiB image can otherwise expand to an unsafe amount of memory.
# The limit is enforced before importing a decoder or invoking PaddleOCR.
MAX_IMAGE_PIXELS: Final = 40_000_000
# The exact JSON envelope is small; this guards streamed request buffering too.
MAX_OCR_REQUEST_BYTES: Final = MAX_BASE64_CHARACTERS + 1024
EXPECTED_OCR_KEYS: Final = frozenset({"file", "fileType", "visualize"})
_MAX_JPEG_SEGMENTS: Final = 1024
_MAX_WEBP_CHUNKS: Final = 2048
_JPEG_SOF_MARKERS: Final = frozenset(
    {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
)

ImageMimeType = Literal["image/jpeg", "image/png", "image/webp"]


class InvalidOcrRequest(ValueError):
    """The request shape or encoded image is invalid without exposing input data."""


class OcrImageTooLarge(ValueError):
    """The decoded image exceeds the inline OCR image ceiling."""


class UnsupportedOcrImage(ValueError):
    """The decoded bytes do not have an allowed image signature."""


@dataclass(frozen=True)
class ValidatedOcrImage:
    """Validated bytes are intentionally kept in memory only for the next slice."""

    data: bytes
    mime_type: ImageMimeType
    width: int
    height: int


def parse_ocr_request(body: bytes) -> ValidatedOcrImage:
    """Parse the exact provider envelope before validating its raw base64 image."""

    try:
        value = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_read_unique_object,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise InvalidOcrRequest from None

    if not isinstance(value, dict) or set(value) != EXPECTED_OCR_KEYS:
        raise InvalidOcrRequest

    file_value = value["file"]
    file_type = value["fileType"]
    visualize = value["visualize"]

    if (
        type(file_value) is not str
        or type(file_type) is not int
        or file_type != 1
        or type(visualize) is not bool
        or visualize is not False
    ):
        raise InvalidOcrRequest

    return validate_base64_image(file_value)


def validate_base64_image(encoded: str) -> ValidatedOcrImage:
    """Accept only canonical raw base64 for a 4 MiB JPEG, PNG, or WEBP image."""

    if not encoded or _looks_like_image_reference(encoded):
        raise InvalidOcrRequest

    # Check encoded size first so a large request cannot allocate a much larger
    # decoded buffer. The decoded length is checked again below for the boundary.
    if len(encoded) > MAX_BASE64_CHARACTERS:
        raise OcrImageTooLarge

    if len(encoded) % 4 != 0:
        raise InvalidOcrRequest

    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise InvalidOcrRequest from None

    # validate=True permits a few non-canonical encodings; a round trip closes
    # that gap and also rejects whitespace, URL-safe alphabet, and altered padding.
    if not decoded or base64.b64encode(decoded).decode("ascii") != encoded:
        raise InvalidOcrRequest

    if len(decoded) > MAX_IMAGE_BYTES:
        raise OcrImageTooLarge

    mime_type = detect_image_mime_type(decoded)

    if mime_type is None:
        raise UnsupportedOcrImage

    width, height = read_image_dimensions(decoded, mime_type)
    _validate_image_dimensions(width, height)

    return ValidatedOcrImage(
        data=decoded,
        mime_type=mime_type,
        width=width,
        height=height,
    )


def detect_image_mime_type(value: bytes) -> ImageMimeType | None:
    """Recognize only the same lightweight byte signatures accepted by Lambda."""

    if value.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"

    if value.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"

    if len(value) >= 12 and value.startswith(b"RIFF") and value[8:12] == b"WEBP":
        return "image/webp"

    return None


def read_image_dimensions(value: bytes, mime_type: ImageMimeType) -> tuple[int, int]:
    """Read bounded dimensions from an allowed image header without decoding pixels.

    A magic byte match alone is insufficient because an image can advertise a
    decompression-bomb canvas. These readers only access fixed, checked ranges;
    malformed or truncated allowed-format headers fail as an invalid request.
    """

    if mime_type == "image/png":
        return _read_png_dimensions(value)

    if mime_type == "image/jpeg":
        return _read_jpeg_dimensions(value)

    if mime_type == "image/webp":
        return _read_webp_dimensions(value)

    # ImageMimeType is closed, but keep this defensive branch if a future caller
    # passes an invalid value at runtime.
    raise InvalidOcrRequest


def _read_png_dimensions(value: bytes) -> tuple[int, int]:
    """Read a standards-conformant PNG IHDR chunk with checked bounds."""

    # Signature + IHDR chunk length/type/data/CRC.
    if len(value) < 33:
        raise InvalidOcrRequest

    if value[:8] != b"\x89PNG\r\n\x1a\n":
        raise InvalidOcrRequest

    if value[8:12] != b"\x00\x00\x00\r" or value[12:16] != b"IHDR":
        raise InvalidOcrRequest

    width = int.from_bytes(value[16:20], byteorder="big")
    height = int.from_bytes(value[20:24], byteorder="big")
    bit_depth = value[24]
    color_type = value[25]
    compression_method = value[26]
    filter_method = value[27]
    interlace_method = value[28]

    valid_bit_depths = {
        0: {1, 2, 4, 8, 16},
        2: {8, 16},
        3: {1, 2, 4, 8},
        4: {8, 16},
        6: {8, 16},
    }

    if (
        bit_depth not in valid_bit_depths.get(color_type, set())
        or compression_method != 0
        or filter_method != 0
        or interlace_method not in {0, 1}
    ):
        raise InvalidOcrRequest

    return width, height


def _read_jpeg_dimensions(value: bytes) -> tuple[int, int]:
    """Walk JPEG marker segments until a supported start-of-frame marker."""

    if len(value) < 4 or value[:2] != b"\xff\xd8":
        raise InvalidOcrRequest

    offset = 2
    marker_count = 0

    while offset < len(value):
        # Markers may be padded by one or more 0xFF bytes. Every branch advances
        # offset, and the segment ceiling prevents adversarial tiny segments from
        # consuming unbounded CPU time.
        if value[offset] != 0xFF:
            raise InvalidOcrRequest

        while offset < len(value) and value[offset] == 0xFF:
            offset += 1

        if offset >= len(value):
            raise InvalidOcrRequest

        marker = value[offset]
        offset += 1
        marker_count += 1

        if marker_count > _MAX_JPEG_SEGMENTS:
            raise InvalidOcrRequest

        # Standalone markers do not have a length field.
        if marker == 0xD8:
            # The one permitted SOI marker was consumed before this loop.
            raise InvalidOcrRequest

        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            continue

        # Entropy-coded data follows SOS. A valid JPEG must have supplied its SOF
        # dimensions before then; EOI before a SOF is likewise malformed here.
        if marker in {0x00, 0xD9, 0xDA}:
            raise InvalidOcrRequest

        if offset + 2 > len(value):
            raise InvalidOcrRequest

        segment_length = int.from_bytes(value[offset : offset + 2], byteorder="big")

        if segment_length < 2 or segment_length > len(value) - offset:
            raise InvalidOcrRequest

        if marker in _JPEG_SOF_MARKERS:
            # Length includes the two length bytes. The fixed SOF portion has
            # precision, height, width, and component-count fields.
            if segment_length < 8:
                raise InvalidOcrRequest

            height = int.from_bytes(value[offset + 3 : offset + 5], byteorder="big")
            width = int.from_bytes(value[offset + 5 : offset + 7], byteorder="big")
            component_count = value[offset + 7]

            if component_count < 1 or segment_length < 8 + (3 * component_count):
                raise InvalidOcrRequest

            return width, height

        offset += segment_length

    raise InvalidOcrRequest


def _read_webp_dimensions(value: bytes) -> tuple[int, int]:
    """Read a bounded RIFF/WebP canvas from VP8, VP8L, or VP8X chunks."""

    if len(value) < 12 or value[:4] != b"RIFF" or value[8:12] != b"WEBP":
        raise InvalidOcrRequest

    riff_size = int.from_bytes(value[4:8], byteorder="little")

    # RIFF size counts bytes after its size field. Requiring the exact declared
    # length rejects truncated headers and unexpected trailing data alike.
    if riff_size < 4 or riff_size + 8 != len(value):
        raise InvalidOcrRequest

    riff_end = len(value)
    offset = 12
    chunk_count = 0
    canvas_dimensions: tuple[int, int] | None = None
    image_dimensions: tuple[int, int] | None = None

    while offset < riff_end:
        if offset + 8 > riff_end:
            raise InvalidOcrRequest

        chunk_type = value[offset : offset + 4]
        chunk_size = int.from_bytes(value[offset + 4 : offset + 8], byteorder="little")
        data_start = offset + 8

        if chunk_size > riff_end - data_start:
            raise InvalidOcrRequest

        data_end = data_start + chunk_size
        padded_end = data_end + (chunk_size & 1)

        if padded_end > riff_end:
            raise InvalidOcrRequest

        # RIFF requires a zero padding byte for odd-sized chunks. Enforcing it
        # prevents hidden non-image data from being accepted as a valid header.
        if chunk_size & 1 and value[data_end] != 0:
            raise InvalidOcrRequest

        chunk_data = value[data_start:data_end]

        if chunk_type == b"VP8X":
            # The extended header must be the first RIFF chunk and occur once.
            if chunk_count != 0 or canvas_dimensions is not None:
                raise InvalidOcrRequest
            canvas_dimensions = _read_vp8x_dimensions(chunk_data)
        elif chunk_type in {b"ANIM", b"ANMF"}:
            # Animated WebP can contain multiple nested frame bitstreams. This
            # single-image provider does not parse every nested frame, so reject
            # it rather than let a large frame bypass the canvas-only check.
            raise InvalidOcrRequest
        elif chunk_type == b"VP8 ":
            if image_dimensions is not None:
                raise InvalidOcrRequest
            image_dimensions = _read_vp8_dimensions(chunk_data)
        elif chunk_type == b"VP8L":
            if image_dimensions is not None:
                raise InvalidOcrRequest
            image_dimensions = _read_vp8l_dimensions(chunk_data)

        offset = padded_end
        chunk_count += 1

        if chunk_count > _MAX_WEBP_CHUNKS:
            raise InvalidOcrRequest

    if offset != riff_end or image_dimensions is None:
        raise InvalidOcrRequest

    if canvas_dimensions is not None:
        # A VP8X canvas can be smaller than its encoded frame. Check both before
        # returning the canvas dimensions so a static extended WebP cannot evade
        # the pixel limit through a small advertised canvas.
        _validate_image_dimensions(*canvas_dimensions)
        _validate_image_dimensions(*image_dimensions)
        return canvas_dimensions

    return image_dimensions


def _read_vp8x_dimensions(value: bytes) -> tuple[int, int]:
    """Read the 24-bit minus-one canvas fields in a VP8X header."""

    if len(value) != 10:
        raise InvalidOcrRequest

    width = 1 + int.from_bytes(value[4:7], byteorder="little")
    height = 1 + int.from_bytes(value[7:10], byteorder="little")
    return width, height


def _read_vp8_dimensions(value: bytes) -> tuple[int, int]:
    """Read dimensions from a key-frame VP8 bitstream header."""

    # Frame-tag bit 0 is zero for a key frame, whose start code and dimensions
    # are present at the fixed offsets below.
    if (
        len(value) < 10
        or value[0] & 0x01
        or value[3:6] != b"\x9d\x01\x2a"
    ):
        raise InvalidOcrRequest

    width = int.from_bytes(value[6:8], byteorder="little") & 0x3FFF
    height = int.from_bytes(value[8:10], byteorder="little") & 0x3FFF
    return width, height


def _read_vp8l_dimensions(value: bytes) -> tuple[int, int]:
    """Read dimensions from the fixed VP8L image header."""

    # The upper three bits of byte four encode the VP8L version and must be 0.
    if len(value) < 5 or value[0] != 0x2F or value[4] & 0xE0:
        raise InvalidOcrRequest

    width = 1 + value[1] + ((value[2] & 0x3F) << 8)
    height = 1 + (value[2] >> 6) + (value[3] << 2) + ((value[4] & 0x0F) << 10)
    return width, height


def _validate_image_dimensions(width: int, height: int) -> None:
    """Reject empty, implausibly large, and decompression-bomb canvases."""

    if width <= 0 or height <= 0:
        raise InvalidOcrRequest

    # Positive dimensions make this multiplication unambiguous. Python integers
    # do not overflow, and the explicit ceiling is enforced before pixel decode.
    if width > MAX_IMAGE_PIXELS or height > MAX_IMAGE_PIXELS:
        raise OcrImageTooLarge

    if width * height > MAX_IMAGE_PIXELS:
        raise OcrImageTooLarge


def _read_unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject duplicate JSON keys rather than allowing a parser to choose one."""

    result: dict[str, object] = {}

    for key, value in pairs:
        if key in result:
            raise InvalidOcrRequest
        result[key] = value

    return result


def _reject_json_constant(_value: str) -> None:
    """Reject non-standard JSON constants such as NaN and Infinity."""

    raise InvalidOcrRequest


def _looks_like_image_reference(value: str) -> bool:
    """Reject common URI and filesystem forms before any base64 decode attempt."""

    lowered = value.lower()

    if lowered.startswith(("data:", "http://", "https://", "file:", "./", "../", "~")):
        return True

    if "\\" in value:
        return True

    # A supported JPEG's canonical base64 begins /9j/. Other leading-slash
    # values are filesystem-like references, not raw payloads for this API.
    if value.startswith("/") and not value.startswith("/9j/"):
        return True

    return False
