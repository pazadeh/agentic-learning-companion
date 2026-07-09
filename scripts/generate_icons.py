#!/usr/bin/env python3
"""Generate placeholder PWA icons (no third-party deps).

Draws the app's indigo rounded-square tile with a white "play" triangle to evoke
audio playback, at the sizes referenced by ``frontend/public/manifest.json``.
Re-run any time to regenerate.

Usage: python3 scripts/generate_icons.py
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "frontend" / "public"

INDIGO = (79, 70, 229)  # #4f46e5 — matches manifest theme_color
WHITE = (255, 255, 255)


def _point_in_triangle(px, py, a, b, c) -> bool:
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def _render_rgba(size: int) -> bytes:
    radius = size * 0.20
    cx = cy = size * 0.5
    half_w = size * 0.13
    half_h = size * 0.15
    # Play triangle vertices (slightly offset right so it looks centered).
    a = (cx - half_w * 0.8, cy - half_h)
    b = (cx - half_w * 0.8, cy + half_h)
    c = (cx + half_w * 1.2, cy)

    raw = bytearray()
    for y in range(size):
        raw.append(0)  # PNG filter type "none" for this scanline
        for x in range(size):
            px, py = x + 0.5, y + 0.5

            # Rounded corners -> transparent outside the corner radius.
            transparent = False
            for corner_x, corner_y in (
                (radius, radius),
                (size - radius, radius),
                (radius, size - radius),
                (size - radius, size - radius),
            ):
                in_corner_box = (
                    (px < radius and py < radius and corner_x == radius and corner_y == radius)
                    or (px > size - radius and py < radius and corner_x == size - radius and corner_y == radius)
                    or (px < radius and py > size - radius and corner_x == radius and corner_y == size - radius)
                    or (px > size - radius and py > size - radius and corner_x == size - radius and corner_y == size - radius)
                )
                if in_corner_box:
                    dx, dy = px - corner_x, py - corner_y
                    if dx * dx + dy * dy > radius * radius:
                        transparent = True
                        break

            if transparent:
                raw.extend((0, 0, 0, 0))
            elif _point_in_triangle(px, py, a, b, c):
                raw.extend((*WHITE, 255))
            else:
                raw.extend((*INDIGO, 255))
    return bytes(raw)


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _write_png(path: Path, size: int) -> None:
    rgba = _render_rgba(size)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(rgba, 9))
        + _chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"wrote {path} ({size}x{size}, {len(png)} bytes)")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    _write_png(OUT_DIR / "icon-192.png", 192)
    _write_png(OUT_DIR / "icon-512.png", 512)


if __name__ == "__main__":
    main()
