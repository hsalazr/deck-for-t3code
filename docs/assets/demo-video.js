// Hero demo: phones get the square cut (bigger keys and captions), wider screens the 16:9 one.
// Runs right after the <video> element, before it has loaded much. Without JavaScript the
// 16:9 video plays everywhere.
(() => {
  const video = document.querySelector(".hero-media video");
  if (!video || !window.matchMedia("(max-width: 640px)").matches) return;
  video.closest(".hero-media").classList.add("is-square");
  video.poster = "assets/demo-square-poster.png";
  video.querySelector('source[type="video/webm"]').src = "assets/demo-square.webm";
  video.querySelector('source[type="video/mp4"]').src = "assets/demo-square.mp4";
  video.load();
})();
