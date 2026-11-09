/**
 * Elgato's own product photos of the Stream Deck XL, the 15-key Stream Deck
 * (MK.2), the Stream Deck Neo and the Stream Deck Mini, with the plugin's key
 * images laid onto their key screens. Elgato's Marketplace guidelines ask for
 * official resources whenever a listing shows their hardware
 * (https://docs.elgato.com/guidelines/products#gallery), so the Marketplace
 * pictures, the gallery video and the site's device carousel use these instead
 * of a drawn mock-up.
 *
 * The photos are device shots from the press kits in the Elgato Media Room
 * (https://www.elgato.com/s/media-room, whose kits live at
 * https://keystone.crsr.ai/en/<Stream_Deck_XL|Stream_Deck_MK_2|Stream_Deck_Neo|Stream_Deck_Mini>/press-kit/;
 * the page is a React app, its data is at /api/public/en/<slug>/press-kit/).
 * They are © Elgato / Corsair and are not part of this repository or its
 * licence: `devicePhoto()` downloads each once into a cache directory outside
 * the repo ($ELGATO_CACHE, default <tmpdir>/t3deck-elgato).
 *
 * The camera looks down at each deck at a slight angle, so the key screens form
 * a trapezoid, not a rectangle. The outer screen corners were measured on the
 * originals (see PhotoDevice); a flat grid of 144 px keys is mapped onto them
 * with a CSS matrix3d homography.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEDIA = "https://res.cloudinary.com/corsairdam/image/upload";
const CACHE = process.env.ELGATO_CACHE ?? join(tmpdir(), "t3deck-elgato");

/**
 * One of Elgato's product photos, and where its key screens are. The corners
 * (outer corners of the first and last key screens, photo pixels) were measured
 * on the original from the screens' edges (lines fitted to the coloured screens,
 * then a least-squares homography over every key), and checked by laying the
 * keys on the photo. `gap` is the space between key screens in the flat grid
 * (144 px keys), horizontally and vertically.
 */
export interface PhotoDevice {
	/** Cache file name and picture name. */
	id: string;
	/** Where the press-kit photo is (below https://res.cloudinary.com/corsairdam/image/upload/). */
	path: string;
	/** Size of the original photo, and the box its opaque pixels fill. */
	photoW: number;
	photoH: number;
	body: { x: number; y: number; w: number; h: number };
	/** Outer corners of the key screens (top-left of the first key, top-right of the last in row 1, bottom-left of the first in the last row, bottom-right of the last), photo pixels. */
	screens: [number, number][];
	columns: number;
	rows: number;
	gap: [number, number];
}

/** Stream Deck XL: "Device Shot No Cable 02" from the XL press kit (https://keystone.crsr.ai/en/Stream_Deck_XL/press-kit/). */
export const XL: PhotoDevice = {
	id: "stream-deck-xl",
	path: "v1774600567/Stream_Deck_XL_Device_Shot_No_Cable_02_wbppdl.png",
	photoW: 6000,
	photoH: 3959,
	body: { x: 948, y: 1024, w: 3847, h: 1923 },
	screens: [[1378, 1360], [4358, 1360], [1314, 2483], [4425, 2483]],
	columns: 8,
	rows: 4,
	gap: [48, 48],
};

/** The 15-key Stream Deck (MK.2): "Device Shot 02 No Cable Shadow" from the MK.2 press kit. */
export const MK2: PhotoDevice = {
	id: "stream-deck",
	path: "v1774609007/Stream_Deck_MK.2_Device_Shot_02_No_Cable_Shadow_u0zfei.png",
	photoW: 6000,
	photoH: 4000,
	body: { x: 856, y: 768, w: 4424, h: 2784 },
	screens: [[1461, 1262], [4682, 1267], [1356, 2758], [4780, 2765]],
	columns: 5,
	rows: 3,
	gap: [66, 66],
};

/** Stream Deck Neo (white): "Front A" from the Neo press kit. Its info bar shows Elgato's own clock. */
export const NEO: PhotoDevice = {
	id: "stream-deck-neo",
	path: "v1781083056/Stream_Deck_Neo_Front_A_vmvjxh.png",
	photoW: 8000,
	photoH: 8000,
	body: { x: 2264, y: 2736, w: 3480, h: 2240 },
	screens: [[2835, 3065], [5174, 3062], [2802, 3892], [5201, 3892]],
	columns: 4,
	rows: 2,
	gap: [27, 41],
};

/** Stream Deck Mini: "Device 03" from the Mini press kit. */
export const MINI: PhotoDevice = {
	id: "stream-deck-mini",
	path: "v1774561722/Stream_Deck_Mini_Device_03_yrecr0.png",
	photoW: 4000,
	photoH: 2667,
	body: { x: 904, y: 760, w: 2200, h: 1352 },
	screens: [[1361, 1006], [2661, 1002], [1333, 1606], [2680, 1607]],
	columns: 3,
	rows: 2,
	gap: [62, 62],
};

/** The flat grid the keys are drawn in before the homography: 144 px keys. */
export const KEY = 144;
/** How far each key image overhangs its screen, so none of the photo's own key art shows at the edges. */
export const BLEED = 5;
/** XL's gap, for the demo video's flat layout. */
export const GAP = XL.gap[0];

const gridW = (d: PhotoDevice): number => d.columns * KEY + (d.columns - 1) * d.gap[0];
const gridH = (d: PhotoDevice): number => d.rows * KEY + (d.rows - 1) * d.gap[1];

/** Path of a device's cached photo, downloading it on first use. */
export function devicePhoto(d: PhotoDevice): string {
	const file = join(CACHE, `${d.id}-front.png`);
	if (existsSync(file) && statSync(file).size > 1_000_000) return file;
	mkdirSync(CACHE, { recursive: true });
	execFileSync("curl", ["-fsSL", "--retry", "3", "-o", file, `${MEDIA}/${d.path}`], { stdio: ["ignore", "ignore", "inherit"] });
	return file;
}

/** Path of the cached XL photo, downloading it on first use. */
export const xlPhoto = (): string => devicePhoto(XL);

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
function gridHomography(d: PhotoDevice, scale: number): number[] {
	const dst = d.screens.map(([x, y]): [number, number] => [(x - d.body.x) * scale, (y - d.body.y) * scale]);
	return homography([[0, 0], [gridW(d), 0], [0, gridH(d)], [gridW(d), gridH(d)]], dst);
}

/** The CSS matrix3d (transform-origin 0 0) for gridHomography. */
function gridTransform(d: PhotoDevice, scale: number): string {
	const h = gridHomography(d, scale);
	const m = [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, h[8]];
	return `matrix3d(${m.map((v) => +v.toPrecision(10)).join(",")})`;
}

/** Height of the cropped photo when drawn `width` CSS pixels wide. */
export const devicePhotoHeight = (d: PhotoDevice, width: number): number => Math.round((width * d.body.h) / d.body.w);
export const xlPhotoHeight = (width: number): number => devicePhotoHeight(XL, width);

/** Top-left of key `index` (reading order) in a device's flat grid. */
export const deviceKeyOrigin = (d: PhotoDevice, index: number): [number, number] => [
	(index % d.columns) * (KEY + d.gap[0]),
	Math.floor(index / d.columns) * (KEY + d.gap[1]),
];
export const keyOrigin = (index: number): [number, number] => deviceKeyOrigin(XL, index);

/** The flat-grid → page transform for a photo drawn `width` CSS pixels wide, for callers that place their own layers on the keys. */
export const deviceGridTransform = (d: PhotoDevice, width: number): string => gridTransform(d, width / d.body.w);
export const xlGridTransform = (width: number): string => deviceGridTransform(XL, width);

/**
 * Where the flat-grid point (x, y) lands on the photo drawn `width` CSS pixels
 * wide, in that box's pixels: the same mapping as deviceGridTransform, for callers
 * that place things over a key (a pointer, a zoom) outside the transformed layer.
 */
export function deviceProject(d: PhotoDevice, width: number): (x: number, y: number) => [number, number] {
	const h = gridHomography(d, width / d.body.w);
	return (x, y) => {
		const w = h[6] * x + h[7] * y + h[8];
		return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
	};
}
export const xlProject = (width: number): ((x: number, y: number) => [number, number]) => deviceProject(XL, width);

/** The photo alone, as an absolutely placed <img class="photo"> for a box `width` × devicePhotoHeight(width) CSS pixels with overflow hidden (the box crops it to the device). */
export function devicePhotoImg(d: PhotoDevice, width: number): string {
	const scale = width / d.body.w;
	return `<img class="photo" src="file://${devicePhoto(d)}" style="left:${-d.body.x * scale}px;top:${-d.body.y * scale}px;width:${d.photoW * scale}px;height:${d.photoH * scale}px">`;
}
export const xlPhotoImg = (width: number): string => devicePhotoImg(XL, width);

/** Shared CSS for xlPhotoDeck and devicePhotoDeck (each deck sets its own grid size inline). */
export const XL_PHOTO_CSS = `
.xl{position:relative;overflow:visible}
.xl>img.photo{position:absolute;display:block;max-width:none;pointer-events:none}
.xl>.grid{position:absolute;left:0;top:0;width:${gridW(XL)}px;height:${gridH(XL)}px;transform-origin:0 0}
.xl .k{position:absolute;width:${KEY + 2 * BLEED}px;height:${KEY + 2 * BLEED}px;border-radius:${14 + BLEED}px;overflow:hidden;background:#050506}
.xl .k>svg,.xl .k>img{display:block;width:${KEY}px;height:${KEY}px;margin:${BLEED}px;border-radius:14px}
.xl .k::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(160deg,#ffffff14 0%,#ffffff05 38%,transparent 55%);box-shadow:inset 0 0 0 1px #ffffff12}
`;

/**
 * A device's photo, `width` CSS pixels wide (cropped to the device), with `keys`
 * (SVG or <img> strings, reading order) on its screens. Include XL_PHOTO_CSS
 * once on the page.
 */
export function devicePhotoDeck(d: PhotoDevice, keys: string[], width: number): string {
	const cells = keys
		.slice(0, d.columns * d.rows)
		.map((k, i) => {
			const [x, y] = deviceKeyOrigin(d, i);
			return `<div class="k" style="left:${x - BLEED}px;top:${y - BLEED}px">${k}</div>`;
		})
		.join("");
	return `<div class="xl" style="width:${width}px;height:${devicePhotoHeight(d, width)}px;overflow:hidden">${devicePhotoImg(d, width)}<div class="grid" style="width:${gridW(d)}px;height:${gridH(d)}px;transform:${deviceGridTransform(d, width)}">${cells}</div></div>`;
}
export const xlPhotoDeck = (keys: string[], width: number): string => devicePhotoDeck(XL, keys, width);
