/**
 * The deck's keys use saturated colours, because a Stream Deck's LCD washes
 * them out. On a screen (the site's pictures, the demo animation) those same
 * colours look harsh, and the softer originals read more like light from a
 * real key. Every marketing picture goes through `soften` before it's drawn.
 */
const SOFTER: [RegExp, string][] = [
	[/#00E069/gi, "#3DD68C"], // green: done, headroom
	[/#FF242F/gi, "#F0524F"], // red: failed, high
	[/#297EFF/gi, "#5B9CFF"], // blue: working, on pace
];

export function soften(svg: string): string {
	return SOFTER.reduce((s, [from, to]) => s.replace(from, to), svg);
}
