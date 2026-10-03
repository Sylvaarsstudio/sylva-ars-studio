(() => {
  const ambientVideos = Array.from(document.querySelectorAll('[data-ambient-video]'));
  if (ambientVideos.length === 0 || !window.matchMedia) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function syncAmbientPlayback() {
    for (const video of ambientVideos) {
      if (reducedMotion.matches) {
        video.pause();
        video.removeAttribute('autoplay');
      } else {
        video.setAttribute('autoplay', '');
        const playback = video.play();
        if (playback) playback.catch(() => {});
      }
    }
  }

  syncAmbientPlayback();
  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener('change', syncAmbientPlayback);
  } else {
    reducedMotion.addListener(syncAmbientPlayback);
  }
})();
