// Device carousel (Thread Actions section). The slides are a CSS scroll-snap list, so
// swiping and scrolling work without this file; it adds the prev/next buttons, keeps the
// current dot marked (aria-current), moves one slide per Left/Right arrow while the
// carousel has focus, and wraps around at either end. No autoplay.
//
// Start on a given slide: link to #slide-2 (the page also scrolls to it), or add
// ?slide=2 to the URL (stays where the page would be; handy for screenshots).
(() => {
  const root = document.querySelector(".carousel");
  if (!root) return;
  const list = root.querySelector(".slides");
  const slides = [...list.querySelectorAll(".slide")];
  const dots = [...root.querySelectorAll(".dot")];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  const current = () => Math.max(0, Math.min(slides.length - 1, Math.round(list.scrollLeft / list.clientWidth)));
  let shown = 0;
  const mark = () => {
    const i = (shown = current());
    dots.forEach((d, n) => (n === i ? d.setAttribute("aria-current", "true") : d.removeAttribute("aria-current")));
  };
  const go = (i, instant = false) => {
    const n = (shown = (i + slides.length) % slides.length);
    list.scrollTo({ left: n * list.clientWidth, behavior: instant || reduced.matches ? "instant" : "smooth" });
    dots.forEach((d, k) => (k === n ? d.setAttribute("aria-current", "true") : d.removeAttribute("aria-current")));
  };

  root.querySelector(".prev").addEventListener("click", () => go(current() - 1));
  root.querySelector(".next").addEventListener("click", () => go(current() + 1));
  dots.forEach((d, i) =>
    d.addEventListener("click", (e) => {
      e.preventDefault();
      go(i);
    }),
  );
  root.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    go(current() + (e.key === "ArrowRight" ? 1 : -1));
  });

  let frame = 0;
  list.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(mark);
  }, { passive: true });
  // Keep the same slide in view when the width changes (rotation, resize).
  new ResizeObserver(() => list.scrollTo({ left: shown * list.clientWidth, behavior: "instant" })).observe(list);

  const fromHash = /^#slide-(\d)$/.exec(location.hash);
  const fromQuery = new URLSearchParams(location.search).get("slide");
  const start = Number(fromHash?.[1] ?? fromQuery ?? 1) - 1;
  shown = start >= 0 && start < slides.length ? start : 0;
  go(shown, true);
  root.classList.add("is-ready");
})();
