/**
 * Elgato's own device previews of the Stream Deck XL, the 15-key Stream Deck
 * (MK.2), the Stream Deck Neo and the Stream Deck Mini, with the plugin's key
 * images showing through their key screens. They come from Elgato's official
 * "Stream Deck Templates" Figma file
 * (https://www.figma.com/community/file/1315040482142393672/stream-deck-templates),
 * which Elgato's Marketplace guidelines point makers to for gallery images
 * (https://docs.elgato.com/guidelines/products#gallery), so the Marketplace
 * pictures, the demo video and the site use these instead of a drawn mock-up.
 * The file is © Elgato,
 * published on Figma Community under CC BY 4.0
 * (https://creativecommons.org/licenses/by/4.0/); credit it wherever the
 * pictures are shown.
 *
 * Each overlay in marketing/elgato-template/ is one device's black preview,
 * exported from Figma at 2× (the XL at 4×, so the demo video can zoom into
 * it), with its key screens see-through: under the
 * overlay goes the key image, and on top stay Elgato's own glass bevel,
 * reflections and corner rounding, exactly as the Figma file draws them over
 * its key slots. marketing/elgato-template/README.md says how the overlays
 * were made.
 *
 * Geometry is in template units (the Figma file's 1×): every key slot is
 * 108 units square, a 144 px key image scaled down, as in the template.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(resolve(dirname(fileURLToPath(import.meta.url))), "elgato-template");

/** Side of a key slot, template units. */
export const SLOT = 108;

/** One device preview from the template, and where its key slots are. */
export interface TemplateDevice {
	/** Overlay file name (marketing/elgato-template/<id>.png) and picture name. */
	id: string;
	/** Size of the device, template units. The overlay is that at 2× in pixels (the XL's at 4×). */
	w: number;
	h: number;
	/** Top-left of the first key slot, and the distance from one slot to the next. */
	origin: [number, number];
	pitch: [number, number];
	columns: number;
	rows: number;
	/** The Neo's info bar screen, which the overlay also leaves see-through. */
	infoBar?: { x: number; y: number; w: number; h: number };
}

/** "Device / Stream Deck XL", Color=Black. */
export const XL: TemplateDevice = { id: "stream-deck-xl", w: 1220, h: 752, origin: [108, 148], pitch: [128, 128], columns: 8, rows: 4 };
/** "Device / Stream Deck MK.2", Color=Black. */
export const MK2: TemplateDevice = { id: "stream-deck", w: 780, h: 554, origin: [80, 112], pitch: [128, 128], columns: 5, rows: 3 };
/** "Device / Stream Deck Neo", Color=Black. */
export const NEO: TemplateDevice = {
	id: "stream-deck-neo", w: 720, h: 520, origin: [108, 96], pitch: [132, 132], columns: 4, rows: 2,
	infoBar: { x: 236, y: 368, w: 248, h: 58 },
};
/** "Device / Stream Deck Mini", Color=Black. */
export const MINI: TemplateDevice = { id: "stream-deck-mini", w: 556, h: 402, origin: [96, 80], pitch: [128, 128], columns: 3, rows: 2 };

/** Path of a device's overlay. */
export function templateOverlay(d: TemplateDevice): string {
	const file = join(DIR, `${d.id}.png`);
	if (!existsSync(file)) throw new Error(`missing ${file}; see marketing/elgato-template/README.md`);
	return file;
}

/** Height of a device drawn `width` CSS pixels wide (not rounded, so keys and overlay stay aligned). */
export const templateHeight = (d: TemplateDevice, width: number): number => (width * d.h) / d.w;

/** Top-left of key slot `index` (reading order), template units. */
export const templateKeyOrigin = (d: TemplateDevice, index: number): [number, number] => [
	d.origin[0] + (index % d.columns) * d.pitch[0],
	d.origin[1] + Math.floor(index / d.columns) * d.pitch[1],
];

/** Key images are drawn at 144 px; a slot is that, scaled to SLOT units. */
export const KEY = 144;

/**
 * Space between keys in a flat grid of KEY px keys that lands exactly on the
 * device's slots (the demo video lays its keys out flat, then maps the grid
 * onto the device with templateGridTransform).
 */
export const templateGap = (d: TemplateDevice): number => ((d.pitch[0] - SLOT) * KEY) / SLOT;

/** Where the flat-grid point (x, y) lands on a device drawn `width` CSS pixels wide, in that box's pixels. */
export function templateProject(d: TemplateDevice, width: number): (x: number, y: number) => [number, number] {
	const u = width / d.w;
	const k = (SLOT / KEY) * u;
	return (x, y) => [d.origin[0] * u + k * x, d.origin[1] * u + k * y];
}

/** The flat-grid → box transform (CSS, transform-origin 0 0) for a device drawn `width` CSS pixels wide. */
export function templateGridTransform(d: TemplateDevice, width: number): string {
	const u = width / d.w;
	const k = (SLOT / KEY) * u;
	return `matrix(${k},0,0,${k},${d.origin[0] * u},${d.origin[1] * u})`;
}

/** The overlay alone, for callers that lay out their own keys: place it over them, in a box `width` × templateHeight(width). */
export const templateOverlayImg = (d: TemplateDevice, width: number): string =>
	`<img class="overlay" src="file://${templateOverlay(d)}" style="position:absolute;left:0;top:0;display:block;max-width:none;width:${width}px;height:${templateHeight(d, width)}px">`;

/** Shared CSS for templateDeck. */
export const TEMPLATE_CSS = `
.td{position:relative;overflow:hidden}
.td>.slots{position:absolute;left:0;top:0;transform-origin:0 0}
.td .k,.td .bar{position:absolute;overflow:hidden;background:#000}
.td .k{width:${SLOT}px;height:${SLOT}px}
.td .k>svg,.td .k>img{display:block;width:${SLOT}px;height:${SLOT}px}
.td>img.overlay{position:absolute;left:0;top:0;display:block;max-width:none;pointer-events:none}
`;

/**
 * A device preview `width` CSS pixels wide, with `keys` (SVG or <img> strings,
 * reading order) in its key slots. Slots past the end of `keys` stay dark, and
 * so does the Neo's info bar. Include TEMPLATE_CSS once on the page.
 */
export function templateDeck(d: TemplateDevice, keys: string[], width: number): string {
	const height = templateHeight(d, width);
	const cells = Array.from({ length: d.columns * d.rows }, (_, i) => {
		const [x, y] = templateKeyOrigin(d, i);
		return `<div class="k" style="left:${x}px;top:${y}px">${keys[i] ?? ""}</div>`;
	}).join("");
	const bar = d.infoBar ? `<div class="bar" style="left:${d.infoBar.x}px;top:${d.infoBar.y}px;width:${d.infoBar.w}px;height:${d.infoBar.h}px"></div>` : "";
	return `<div class="td" style="width:${width}px;height:${height}px"><div class="slots" style="width:${d.w}px;height:${d.h}px;transform:scale(${width / d.w})">${cells}${bar}</div><img class="overlay" src="file://${templateOverlay(d)}" style="width:${width}px;height:${height}px"></div>`;
}
