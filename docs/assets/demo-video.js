// Hero demo. Runs right after the <video> element, before it has loaded much.
// - Phones get the square cut (bigger keys and captions), wider screens the 16:9 one.
// - With "Reduce motion" on, the video doesn't autoplay: it shows its first frame
//   and a play button, so the visitor chooses to watch it.
// Without JavaScript the 16:9 video autoplays, or with Reduce motion only the
// still image shows (style.css hides the video).
(() => {
  const video = document.querySelector(".hero-media video");
  if (!video) return;
  const media = video.closest(".hero-media");

  if (window.matchMedia("(max-width: 640px)").matches) {
    media.classList.add("is-square");
    video.poster = "assets/demo-square-poster.png";
    video.querySelector('source[type="video/webm"]').src = "assets/demo-square.webm";
    video.querySelector('source[type="video/mp4"]').src = "assets/demo-square.mp4";
    video.load();
  }

  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  video.removeAttribute("autoplay");
  video.autoplay = false;
  video.pause();
  media.classList.add("is-opt-in");

  const play = document.createElement("button");
  play.type = "button";
  play.className = "demo-play";
  play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg><span>Play demo</span>';
  play.addEventListener("click", () => {
    play.remove();
    // Once it plays, the native controls let the visitor pause it again.
    video.controls = true;
    video.removeAttribute("aria-hidden");
    video.removeAttribute("tabindex");
    video.setAttribute("aria-label", "Demo of Deck for T3 Code on a Stream Deck");
    video.play().catch(() => undefined);
  });
  media.append(play);
})();
