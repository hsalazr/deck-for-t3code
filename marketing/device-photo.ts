/**
 * Elgato's own product photo of the Stream Deck XL, with the plugin's key
 * images laid onto its 32 key screens. Elgato's Marketplace guidelines ask for
 * official resources whenever a listing shows their hardware
 * (https://docs.elgato.com/guidelines/products#gallery), so the Marketplace
 * pictures and the gallery video use this instead of a drawn mock-up.
 *
 * The photo is "Stream Deck XL Device Shot No Cable 02" from the Stream Deck XL
 * press kit in the Elgato Media Room (https://www.elgato.com/s/media-room →
 * https://keystone.crsr.ai/en/Stream_Deck_XL/press-kit/). It is © Elgato /
 * Corsair and is not part of this repository or its licence: `xlPhoto()`
 * downloads it once into a cache directory outside the repo.
 *
 * The camera looks down at the deck at a slight angle, so the key screens form
 * a trapezoid, not a rectangle. The four outer screen corners were measured on
 * the 6000×3959 original (the blue and yellow screens give clean edges; the
 * rest of the grid is checked against them, within ~10 px of 6000). A flat
 * 8×4 grid of 144 px keys is mapped onto them with a CSS matrix3d homography.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = "https://res.cloudinary.com/corsairdam/image/upload/v1774600567/Stream_Deck_XL_Device_Shot_No_Cable_02_wbppdl.png";
const CACHE = process.env.ELGATO_CACHE ?? join(tmpdir(), "t3deck-elgato");

/** Size of the original photo, and the box its opaque pixels fill. */
const PHOTO_W = 6000;
const PHOTO_H = 3959;
const BODY = { x: 948, y: 1024, w: 3847, h: 1923 };

/** Outer corners of the key screens (top-left of key 1, top-right of key 8, bottom-left of key 25, bottom-right of key 32), photo pixels. */
const SCREENS: [number, number][] = [[1378, 1360], [4358, 1360], [1314, 2483], [4425, 2483]];

/** The flat grid the keys are drawn in before the homography: 144 px keys, 48 px apart. */
export const KEY = 144;
export const GAP = 48;
const COLUMNS = 8;
const ROWS = 4;
const GRID_W = COLUMNS * KEY + (COLUMNS - 1) * GAP;
const GRID_H = ROWS * KEY + (ROWS - 1) * GAP;
/** How far each key image overhangs its screen, so none of the photo's own key art shows at the edges. */
export const BLEED = 5;

/** Path of the cached photo, downloading it on first use. */
export function xlPhoto(): string {
	const file = join(CACHE, "stream-deck-xl-front.png");
	if (existsSync(file) && statSync(file).size > 1_000_000) return file;
	mkdirSync(CACHE, { recursive: true });
	execFileSync("curl", ["-fsSL", "--retry", "3", "-o", file, URL], { stdio: ["ignore", "ignore", "inherit"] });
	return file;
}

/** Solves the 3×3 homography taking the four `src` points to the four `dst` points (h[8] = 1). */
function homography(src: [number, number][], dst: [number, number][]): number[] {
	const a: number[][] = [];
	const b: number[] = [];
	src.forEach(([x, y], i) => {
		const [u, v] = dst[i];
		a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
		b.push(u);
		a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
		b.push(v);
	});
	for (let i = 0; i < 8; i++) {
		let p = i;
		for (let r = i + 1; r < 8; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
		[a[i], a[p]] = [a[p], a[i]];
		[b[i], b[p]] = [b[p], b[i]];
		for (let r = 0; r < 8; r++) {
			if (r === i) continue;
			const f = a[r][i] / a[i][i];
			for (let c = i; c < 8; c++) a[r][c] -= f * a[i][c];
			b[r] -= f * b[i];
		}
	}
	return [...b.map((v, i) => v / a[i][i]), 1];
}

/** The homography taking the flat key grid onto the photo's screens, in photo pixels scaled by `scale` and offset by the body crop. */
function gridHomography(scale: number): number[] {
	const dst = SCREENS.map(([x, y]): [number, number] => [(x - BODY.x) * scale, (y - BODY.y) * scale]);
	return homography([[0, 0], [GRID_W, 0], [0, GRID_H], [GRID_W, GRID_H]], dst);
}

/** The CSS matrix3d (transform-origin 0 0) for gridHomography. */
function gridTransform(scale: number): string {
	const h = gridHomography(scale);
	const m = [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, h[8]];
	return `matrix3d(${m.map((v) => +v.toPrecision(10)).join(",")})`;
}

/** Height of the cropped photo when drawn `width` CSS pixels wide. */
export const xlPhotoHeight = (width: number): number => Math.round((width * BODY.h) / BODY.w);

/** Top-left of key `index` (reading order) in the flat grid. */
export const keyOrigin = (index: number): [number, number] => [(index % COLUMNS) * (KEY + GAP), Math.floor(index / COLUMNS) * (KEY + GAP)];

/** The flat-grid → page transform for a photo drawn `width` CSS pixels wide, for callers that place their own layers on the keys. */
export const xlGridTransform = (width: number): string => gridTransform(width / BODY.w);

/**
 * Where the flat-grid point (x, y) lands on the photo drawn `width` CSS pixels
 * wide, in that box's pixels: the same mapping as xlGridTransform, for callers
 * that place things over a key (a pointer, a zoom) outside the transformed layer.
 */
export function xlProject(width: number): (x: number, y: number) => [number, number] {
	const h = gridHomography(width / BODY.w);
	return (x, y) => {
		const w = h[6] * x + h[7] * y + h[8];
		return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
	};
}

/** The photo alone, as an absolutely placed <img class="photo"> for a box `width` × xlPhotoHeight(width) CSS pixels with overflow hidden (the box crops it to the device). */
export function xlPhotoImg(width: number): string {
	const scale = width / BODY.w;
	return `<img class="photo" src="file://${xlPhoto()}" style="left:${-BODY.x * scale}px;top:${-BODY.y * scale}px;width:${PHOTO_W * scale}px;height:${PHOTO_H * scale}px">`;
}

/** Shared CSS for xlPhotoDeck. */
export const XL_PHOTO_CSS = `
.xl{position:relative;overflow:visible}
.xl>img.photo{position:absolute;display:block;max-width:none;pointer-events:none}
.xl>.grid{position:absolute;left:0;top:0;width:${GRID_W}px;height:${GRID_H}px;transform-origin:0 0}
.xl .k{position:absolute;width:${KEY + 2 * BLEED}px;height:${KEY + 2 * BLEED}px;border-radius:${14 + BLEED}px;overflow:hidden;background:#050506}
.xl .k>svg,.xl .k>img{display:block;width:${KEY}px;height:${KEY}px;margin:${BLEED}px;border-radius:14px}
.xl .k::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(160deg,#ffffff14 0%,#ffffff05 38%,transparent 55%);box-shadow:inset 0 0 0 1px #ffffff12}
`;

/**
 * Elgato's Stream Deck XL photo, `width` CSS pixels wide (cropped to the
 * device), with `keys` (32 SVG or <img> strings, reading order) on its screens.
 * Include XL_PHOTO_CSS once on the page.
 */
export function xlPhotoDeck(keys: string[], width: number): string {
	const cells = keys
		.slice(0, COLUMNS * ROWS)
		.map((k, i) => {
			const [x, y] = keyOrigin(i);
			return `<div class="k" style="left:${x - BLEED}px;top:${y - BLEED}px">${k}</div>`;
		})
		.join("");
	return `<div class="xl" style="width:${width}px;height:${xlPhotoHeight(width)}px;overflow:hidden">${xlPhotoImg(width)}<div class="grid" style="transform:${xlGridTransform(width)}">${cells}</div></div>`;
}
