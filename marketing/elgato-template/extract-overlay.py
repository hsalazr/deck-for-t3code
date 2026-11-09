"""Derive a see-through device overlay from two Figma renders: key slots black vs white.

For a layer stack that acts as one normal 'over' composite on top of the slot content:
  black = O*a,  white = O*a + (1-a)  =>  a = 1 - (white - black),  O = black / a

Figma's export has no transparency: around the device, outside its rounded body, it is
plain black. That surround is cut out here. Every pixel outside the body becomes
transparent, and the body's anti-aliased edge gets its coverage as alpha (estimated from
how dark the edge pixel is next to the body just inside it), so the overlay sits cleanly
on any background. Over black, the result is the Figma render exactly.

Usage: python3 -I extract-overlay.py <black.png> <white.png> <out.png> <x> <y> <w> <h>
Needs numpy and ffmpeg. <x> <y> <w> <h> is the device's box in the renders, in pixels.
"""
import subprocess
import sys

import numpy as np


def load(path, x, y, w, h):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-vf", f"crop={w}:{h}:{x}:{y}",
                          "-f", "rawvideo", "-pix_fmt", "rgba", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 4).astype(np.float64)


def save(path, arr):
    h, w, _ = arr.shape
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}",
                    "-i", "-", "-frames:v", "1", "-pix_fmt", "rgba", path], input=arr.astype(np.uint8).tobytes(), check=True)


def dilate(mask, radius):
    """Grows a mask by `radius` pixels in every direction (the image border is not part of it)."""
    out = mask
    for _ in range(radius):
        p = np.pad(out, 1)
        out = (p[:-2, :-2] | p[:-2, 1:-1] | p[:-2, 2:] | p[1:-1, :-2] | p[1:-1, 1:-1] | p[1:-1, 2:]
               | p[2:, :-2] | p[2:, 1:-1] | p[2:, 2:])
    return out


def box_sum(values, radius):
    """Sum of `values` over the (2*radius+1)-square window around every pixel."""
    p = np.pad(values, radius + 1)[:-1, :-1].cumsum(axis=0).cumsum(axis=1)
    n = 2 * radius + 1
    return p[n:, n:] - p[:-n, n:] - p[n:, :-n] + p[:-n, :-n]


def surround(black):
    """The pixels outside the device's body: plain black, and reachable in a straight line from an edge of the box."""
    solid = black[..., :3].max(axis=2) > 0
    h, w = solid.shape
    xs, ys = np.arange(w)[None, :], np.arange(h)[:, None]
    first = np.where(solid.any(axis=1), solid.argmax(axis=1), w)
    last = np.where(solid.any(axis=1), w - 1 - solid[:, ::-1].argmax(axis=1), -1)
    by_row = (xs < first[:, None]) | (xs > last[:, None])
    top = np.where(solid.any(axis=0), solid.argmax(axis=0), h)
    bottom = np.where(solid.any(axis=0), h - 1 - solid[::-1, :].argmax(axis=0), -1)
    by_column = (ys < top[None, :]) | (ys > bottom[None, :])
    return by_row | by_column, int((by_row != by_column).sum())


def edge_coverage(black, outside):
    """Coverage (0 to 1) of the body's edge pixels: 1 everywhere else inside, 0 outside."""
    lum = black[..., :3].mean(axis=2)
    band = dilate(outside, 2) & ~outside
    deep = ~outside & ~band
    count = box_sum(deep.astype(np.float64), 4)
    ref = np.where(count > 0, box_sum(lum * deep, 4) / np.maximum(count, 1), 0.0)
    # A full edge pixel can be up to 10% darker than the body next to it (the body has a grain).
    estimate = np.where(ref > 4, np.clip(lum / np.maximum(ref, 1e-6) / 0.9, 0.0, 1.0), 1.0)
    coverage = np.where(band, estimate, 1.0)
    coverage[outside] = 0.0
    return coverage, band


black_path, white_path, out = sys.argv[1:4]
x, y, w, h = map(int, sys.argv[4:8])
B, W = load(black_path, x, y, w, h), load(white_path, x, y, w, h)
assert np.array_equal(B[..., 3], W[..., 3]), "sheet alpha differs between renders"

# The slots: see-through where the white render is lighter than the black one.
d = (W[..., :3] - B[..., :3]) / 255.0
spread = d.max(axis=2) - d.min(axis=2)
a = np.clip(1.0 - d.mean(axis=2), 0.0, 1.0)

# The surround: transparent, with the body's edge anti-aliased.
outside, mismatch = surround(B)
coverage, band = edge_coverage(B, outside)
assert not (outside & (a < 0.999)).any(), "a key slot touches the surround"

alpha = a * coverage * (B[..., 3] / 255.0)
color = np.where(alpha[..., None] > 1e-3, B[..., :3] / 255.0 / np.maximum(alpha[..., None], 1e-3), 0.0)
res = np.dstack([np.clip(np.rint(color * 255.0), 0, 255), np.clip(np.rint(alpha * 255.0), 0, 255)])
save(out, res)

over_black = res[..., :3] * res[..., 3:4] / 255.0
window = a < 0.999
print(f"{out}: {w}x{h}, see-through px {window.sum()} ({window.mean()*100:.1f}%), fully clear px {(a < 0.01).sum()}, "
      f"max channel spread {spread.max():.3f}, surround px {outside.sum()}, edge px {band.sum()} "
      f"(row/column scans differ on {mismatch}), max error over black {np.abs(over_black - B[..., :3]).max():.1f}")
