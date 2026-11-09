# Elgato device overlays

`stream-deck-xl.png`, `stream-deck.png` (MK.2), `stream-deck-neo.png` and `stream-deck-mini.png` are the black device previews from Elgato's official [Stream Deck Templates](https://www.figma.com/community/file/1315040482142393672/stream-deck-templates) Figma file, with their key screens (and the Neo's info bar) made see-through. They are exported at 2×, except the XL at 4×, so the demo video can zoom into it. `marketing/device-template.ts` draws the plugin's keys under them for every picture that shows a Stream Deck: the Marketplace thumbnail and gallery 2 and the site's hero still (`marketing/render-assets.ts`), the demo and gallery video (`marketing/demo/render-demo.ts`), and the site's device carousel (`marketing/render-devices.ts`).

Elgato's Marketplace guidelines point makers to this file for gallery images ([guidelines](https://docs.elgato.com/guidelines/products#gallery)), and the file itself says its device previews can be exported as PNG for marketing material and the Marketplace product gallery.

## Licence

The template is © Elgato and published on Figma Community under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). These overlays are adapted from it: the key screens are cut out, nothing else is changed. They are not covered by this repository's GPL licence. Wherever pictures made from them are shown, credit the template. The site footer does: "Stream Deck device pictures adapted from Elgato's Stream Deck Templates, CC BY 4.0". The Marketplace pictures go to Elgato itself, whose guidelines point makers to the file.

## How they were made

In the template, each key is a 108×108 slot (radius 20) holding a `Content` instance, the key image. A `Bevel` group sits over it: a 6 px 90% black ring with a background blur, and two white inner-shadow reflections blended with Screen. Over any content, that stack acts as one plain "over" layer, because Screen with pure white equals normal blending at the same opacity. So it can be recovered exactly from two renders:

1. In a copy of the file, place an instance of each `Color=Black` device (XL `307:1517`, MK.2 `307:1155`, Neo `683:8091`, Mini `307:1866`) in one frame with no fill, and export it as PNG at 2× (the XL instance on its own at 4×). Every `Content` fill is black, as in the template.
2. Set every `Content` fill in those instances to white, including the Neo's `Infobar` content, and export the same frame again.
3. For each device, run:

   ```
   python3 -I extract-overlay.py black.png white.png <out>.png <x> <y> <w> <h>
   ```

   The script needs numpy and ffmpeg. It works out alpha = 1 − (white − black) and colour = black / alpha. `x y w h` is the device's box in the export, in pixels.

   Figma's export has no transparency: around the device, outside its rounded body, it comes out plain black. The script cuts that surround out and gives the body's edge anti-aliased alpha, so the overlay sits cleanly on any background. Over black, the overlay equals Figma's render to within rounding.

Composited over a test key in headless Chrome, the result matched Figma's own render of the same key at 44.8 dB PSNR. The only difference is the bevel ring's background blur: under the overlay, the 10% of the key that shows through the ring is sharp, not blurred.

Template units are the file's 1×. The overlays are 2× those (the XL 4×), and the slot positions are in `device-template.ts`.
