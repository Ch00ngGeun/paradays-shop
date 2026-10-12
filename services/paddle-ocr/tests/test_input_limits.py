"""Exercise real stdlib request/header validation without importing OCR/decoders.

Fixtures contain bounded headers, not complete pixel streams. Acceptance here
means pre-decode validation passed; the engine still verifies decoded dimensions.
"""

from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys
import unittest
import zlib


_SPEC = importlib.util.spec_from_file_location(
    "ocr_input_limits_validation", Path(__file__).parents[1] / "app/image_validation.py"
)
validation = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = validation  # dataclasses resolves its defining module.
_SPEC.loader.exec_module(validation)


def png(width=1, height=1):
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr
            + struct.pack(">I", zlib.crc32(b"IHDR" + ihdr)))


def jpeg(width=1, height=1):
    # One component, SOF segment length 8 + 3*N (including length bytes).
    return b"\xff\xd8\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"


def chunk(kind, data):
    return kind + struct.pack("<I", len(data)) + data + (b"\0" if len(data) % 2 else b"")


def webp(*chunks):
    payload = b"WEBP" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(payload)) + payload


def vp8(width=1, height=1):
    return chunk(b"VP8 ", b"\0\0\0\x9d\x01\x2a" + struct.pack("<HH", width, height))


def vp8l(width=1, height=1):
    bits = (width - 1) | ((height - 1) << 14)
    return chunk(b"VP8L", b"\x2f" + bits.to_bytes(4, "little"))


def vp8x(width=1, height=1):
    return chunk(b"VP8X", b"\0" * 4 + (width - 1).to_bytes(3, "little")
                 + (height - 1).to_bytes(3, "little"))


def request(image):
    return json.dumps({"file": base64.b64encode(image).decode("ascii"),
                       "fileType": 1, "visualize": False}).encode()


class InputLimitsTests(unittest.TestCase):
    def assert_rejected(self, image, error=validation.InvalidOcrRequest):
        with self.assertRaises(error) as caught:
            validation.parse_ocr_request(request(image))
        # Public validation failures must not expose input/path content.
        self.assertEqual(str(caught.exception), "")

    def test_limits_are_not_relaxed(self):
        self.assertEqual(validation.MAX_IMAGE_BYTES, 4 * 1024 * 1024)
        self.assertEqual(validation.MAX_IMAGE_PIXELS, 40_000_000)

    def test_allowed_png_jpeg_and_all_static_webp_headers(self):
        for image, mime in [(png(), "image/png"), (jpeg(), "image/jpeg"),
                            (webp(vp8()), "image/webp"),
                            (webp(vp8l()), "image/webp"),
                            (webp(vp8x(), vp8()), "image/webp")]:
            with self.subTest(mime=mime, header=image[:20]):
                result = validation.parse_ocr_request(request(image))
                self.assertEqual((result.mime_type, result.width, result.height), (mime, 1, 1))
                self.assertEqual(result.data, image)

    def test_exact_4mib_and_same_base64_quantum_overflow(self):
        for header in (png(), jpeg()):
            for extra in (0, 1, 2):
                image = header + bytes(validation.MAX_IMAGE_BYTES + extra - len(header))
                with self.subTest(format=header[:4], extra=extra):
                    if extra:
                        self.assert_rejected(image, validation.OcrImageTooLarge)
                    else:
                        self.assertEqual(len(validation.parse_ocr_request(request(image)).data), validation.MAX_IMAGE_BYTES)

    def test_webp_exact_4mib_and_plus_one(self):
        # Unknown metadata chunks are allowed; RIFF/chunk lengths remain exact.
        image = webp(vp8(), chunk(b"JUNK", bytes(validation.MAX_IMAGE_BYTES - 38)))
        self.assertEqual(len(image), validation.MAX_IMAGE_BYTES)
        self.assertEqual(len(validation.parse_ocr_request(request(image)).data), validation.MAX_IMAGE_BYTES)
        self.assert_rejected(image + b"\0", validation.OcrImageTooLarge)

    def test_encoded_size_guard_before_decode(self):
        with self.assertRaises(validation.OcrImageTooLarge):
            validation.validate_base64_image("A" * (validation.MAX_BASE64_CHARACTERS + 4))

    def test_base64_corruption_and_noncanonical_padding(self):
        encoded = base64.b64encode(png()).decode()
        padded = base64.b64encode(png() + b"\0").decode()
        corrupt = ["", " " + encoded, encoded + "\n", encoded[:-1],
                   encoded + "=", "?" + encoded[1:], "_" + encoded[1:],
                   padded[:-3] + "B=="]
        for value in corrupt:
            with self.subTest(value_length=len(value)), self.assertRaises(validation.InvalidOcrRequest):
                validation.validate_base64_image(value)

    def test_raw_base64_only_no_uri_or_filesystem_references(self):
        for value in ("data:image/png;base64," + base64.b64encode(png()).decode(),
                      "https://example.test/a.png", "http://example.test/a.png",
                      "file:///tmp/a.png", "../a.png", "./a.png", "~/a.png",
                      "/tmp/a.png", "C:\\a.png"):
            with self.subTest(prefix=value[:5]), self.assertRaises(validation.InvalidOcrRequest):
                validation.validate_base64_image(value)

    def test_json_exact_shape_and_strict_types(self):
        valid = json.loads(request(png()))
        for invalid in ([], None, {**valid, "extra": 1}, {"file": valid["file"]},
                        {**valid, "file": 12}, {**valid, "fileType": True},
                        {**valid, "fileType": 1.0}, {**valid, "fileType": 2},
                        {**valid, "visualize": 0}, {**valid, "visualize": True}):
            with self.subTest(shape=type(invalid).__name__), self.assertRaises(validation.InvalidOcrRequest):
                validation.parse_ocr_request(json.dumps(invalid).encode())

    def test_invalid_json_utf8_duplicate_keys_and_constants(self):
        valid = request(png())
        for body in (b"\xff", valid[:-1], b'{"file":NaN,"fileType":1,"visualize":false}',
                     b'{"file":Infinity,"fileType":1,"visualize":false}',
                     valid[:-1] + b',"fileType":1}'):
            with self.subTest(length=len(body)), self.assertRaises(validation.InvalidOcrRequest):
                validation.parse_ocr_request(body)

    def test_unsupported_signatures(self):
        for image in (b"GIF89a" + bytes(30), b"<svg></svg>", bytes(40)):
            self.assert_rejected(image, validation.UnsupportedOcrImage)

    def test_every_truncated_png_jpeg_webp_header(self):
        # Keep the complete format signature so the expected error is a malformed
        # request rather than an unsupported format. No unchecked read may escape.
        for image, signature_length in ((png(), 8), (jpeg(), 3), (webp(vp8()), 12),
                                        (webp(vp8l()), 12), (webp(vp8x(), vp8()), 12)):
            for length in range(signature_length, len(image)):
                with self.subTest(format=image[:4], length=length):
                    self.assert_rejected(image[:length])

    def test_png_ihdr_malformed_fields(self):
        for offset, value in ((8, 1), (12, 0), (24, 3), (25, 1), (26, 1), (27, 1), (28, 2)):
            image = bytearray(png())
            image[offset] = value
            self.assert_rejected(bytes(image))

    def test_zero_dimensions(self):
        for image in (png(0, 1), png(1, 0), jpeg(0, 1), jpeg(1, 0), webp(vp8(0, 1))):
            self.assert_rejected(image)

    def test_40million_exact_and_one_pixel_over_png(self):
        result = validation.parse_ocr_request(request(png(40_000_000, 1)))
        self.assertEqual(result.width * result.height, 40_000_000)
        self.assert_rejected(png(40_000_001, 1), validation.OcrImageTooLarge)

    def test_40million_exact_and_over_other_formats(self):
        for factory in (jpeg, lambda w, h: webp(vp8(w, h)), lambda w, h: webp(vp8l(w, h))):
            self.assertEqual(validation.parse_ocr_request(request(factory(8000, 5000))).width, 8000)
            self.assert_rejected(factory(8000, 5001), validation.OcrImageTooLarge)

    def test_extended_webp_checks_canvas_and_frame_separately(self):
        self.assertEqual(validation.parse_ocr_request(request(webp(vp8x(8000, 5000), vp8(8000, 5000)))).width, 8000)
        self.assert_rejected(webp(vp8x(8000, 5001), vp8()), validation.OcrImageTooLarge)
        self.assert_rejected(webp(vp8x(), vp8(8000, 5001)), validation.OcrImageTooLarge)

    def test_jpeg_segment_lengths_components_and_missing_sof(self):
        for image in (b"\xff\xd8\xff\xe0\0\x01", b"\xff\xd8\xff\xe0\xff\xff",
                      b"\xff\xd8\xff\xd9", b"\xff\xd8\xff\xda\0\x02",
                      b"\xff\xd8\xff\xd8", jpeg()[:11] + b"\0" + jpeg()[12:]):
            self.assert_rejected(image)

    def test_jpeg_segment_count_ceiling(self):
        self.assertEqual(validation.parse_ocr_request(request(b"\xff\xd8" + b"\xff\x01" * 1023 + jpeg()[2:])).width, 1)
        self.assert_rejected(b"\xff\xd8" + b"\xff\x01" * 1024 + jpeg()[2:])

    def test_webp_riff_chunk_lengths_padding_and_duplicate_frames(self):
        image = webp(vp8l())
        for malformed in (image + b"\0", image[:4] + struct.pack("<I", 4) + image[8:],
                          image[:16] + struct.pack("<I", 0xffffffff) + image[20:],
                          image[:-1] + b"\x01", webp(vp8(), vp8()),
                          webp(vp8(), vp8x()), webp(vp8x()),
                          webp(vp8x(), chunk(b"ANIM", b""), vp8())):
            self.assert_rejected(malformed)

    def test_webp_bitstream_header_invalid(self):
        for image in (webp(chunk(b"VP8 ", b"\x01\0\0\x9d\x01\x2a\x01\0\x01\0")),
                      webp(chunk(b"VP8 ", bytes(10))),
                      webp(chunk(b"VP8L", b"\x2f\0\0\0\xe0")),
                      webp(chunk(b"VP8L", bytes(5)))):
            self.assert_rejected(image)

    def test_webp_chunk_count_ceiling(self):
        self.assertEqual(validation.parse_ocr_request(request(webp(*([chunk(b"JUNK", b"")] * 2047), vp8()))).width, 1)
        self.assert_rejected(webp(*([chunk(b"JUNK", b"")] * 2048), vp8()))


if __name__ == "__main__":
    unittest.main()
