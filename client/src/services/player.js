// Player helpers that must also work in old TV browsers (vendor-prefixed APIs).

export function isFullscreen() {
  return Boolean(
    document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement,
  );
}

/** Enter/leave fullscreen on the <video> element (subtitles keep showing in fullscreen). */
export function toggleFullscreen(videoEl) {
  if (isFullscreen()) {
    const exit =
      document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  const enter =
    videoEl.requestFullscreen ||
    videoEl.webkitRequestFullscreen ||
    videoEl.webkitEnterFullscreen || // iPhone/iPad: native video fullscreen
    videoEl.mozRequestFullScreen ||
    videoEl.msRequestFullscreen;
  if (enter) {
    const result = enter.call(videoEl);
    // Newer browsers return a promise that rejects without a user gesture: ignore that.
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }
}

/** Show subtitle track `index` (-1 = none). textTracks follow the order of the <track> elements. */
export function showSubtitleTrack(videoEl, index) {
  const tracks = videoEl?.textTracks;
  if (!tracks) return;
  for (let i = 0; i < tracks.length; i += 1) {
    tracks[i].mode = i === index ? 'showing' : 'disabled';
  }
}

// Remember the chosen subtitle language on this device ("off" or a language code).
const SUBTITLE_KEY = 'strivo.subtitleLanguage';
export function getSubtitlePreference() {
  try {
    return localStorage.getItem(SUBTITLE_KEY) || 'off';
  } catch {
    return 'off';
  }
}
export function setSubtitlePreference(value) {
  try {
    localStorage.setItem(SUBTITLE_KEY, value);
  } catch {
    /* not persisted */
  }
}
