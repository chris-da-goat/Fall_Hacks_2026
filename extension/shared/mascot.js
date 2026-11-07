// Hackie, the FH26 robot (assets/hackie.gif, drawn by the team). Classic script (not a module)
// so the content script, popup, options and report pages can all share it.
// Exposes globalThis.Hackie.html({ mood, whip, badge }) -> HTML string.
(() => {
  if (globalThis.Hackie) return;

  // The visible robot inside the 64x64 GIF (all 5 frames), from tools/gif.mjs.
  const CROP = { x: 8, y: 7, w: 42, h: 48 };
  const SPRITE_W = (CROP.w / CROP.h) * 100; // sprite box width as % of a square box (87.5%)

  // Mood badges from the team's version, plus the escalation moods.
  const BADGE = {
    happy: '😊', wink: '😉', surprised: '😮', sleepy: '💤', silly: '🤪', cool: '😎', love: '💕',
    curious: '❓', stern: '🤨', worried: '😟', angry: '💢', furious: '🤬',
  };
  const IDLE_MOODS = ['happy', 'wink', 'surprised', 'sleepy', 'silly', 'cool', 'love'];

  const FILTER = {
    angry: 'drop-shadow(0 0 3px rgba(255,42,42,.9))',
    furious: 'drop-shadow(0 0 6px rgba(255,42,42,1)) saturate(1.25)',
  };

  function gifUrl() {
    try {
      return chrome.runtime.getURL('assets/hackie.gif');
    } catch {
      return '../assets/hackie.gif';
    }
  }

  // The whip lives in a 120x120 viewBox laid over the sprite; the hand is on Hackie's left side.
  const WHIP =
    '<svg class="hk-whip-svg" viewBox="0 0 120 120" overflow="visible" aria-hidden="true" ' +
    'style="position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none">' +
    '<g class="hk-whip">' +
    '<path class="hk-lash" d="M9 63 C -8 40, -30 28, -50 42 S -78 72, -104 50" fill="none" stroke="#5a3a22" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M-104 50 l-7 -4 m7 4 l-6 5" stroke="#5a3a22" stroke-width="2" stroke-linecap="round"/>' +
    '<rect x="6" y="60" width="18" height="7.5" rx="3.5" transform="rotate(38 15 64)" fill="#7a4b2a"/>' +
    '<g class="hk-burst" transform="translate(-104 50)" opacity="0">' +
    '<polygon points="0,-22 6,-8 22,-12 10,0 22,12 6,8 0,22 -6,8 -22,12 -10,0 -22,-12 -6,-8" fill="#ffd23f" stroke="#e08a00" stroke-width="1.5"/>' +
    '</g></g></svg>';

  /**
   * Draws Hackie filling a square box (set the box's size; Hackie keeps the 42:48 pixel ratio).
   * Set --hk-badge-size on the box to scale the emoji badge (default 18px).
   * @param {object} [opts]
   * @param {string} [opts.mood]   happy | stern | worried | angry | furious | curious | wink | …
   * @param {boolean} [opts.whip]  Draw the whip.
   * @param {boolean} [opts.badge] Show the emoji mood badge.
   */
  function html({ mood = 'stern', whip = true, badge = true } = {}) {
    const filter = FILTER[mood] || 'none';
    const tilt = mood === 'curious' ? 'rotate(-6deg)' : 'none';
    const imgStyle =
      `position:absolute;left:${(-CROP.x / CROP.w) * 100}%;top:${(-CROP.y / CROP.h) * 100}%;` +
      `width:${(64 / CROP.w) * 100}%;height:${(64 / CROP.h) * 100}%;max-width:none;image-rendering:pixelated;`;
    return (
      `<span class="hk hk-${mood}" style="position:relative;display:block;width:100%;height:100%">` +
      (whip ? WHIP : '') +
      `<span class="hk-sprite" style="position:absolute;top:0;bottom:0;left:${(100 - SPRITE_W) / 2}%;width:${SPRITE_W}%;` +
      `overflow:hidden;filter:${filter};transform:${tilt};transition:transform .2s">` +
      `<img src="${gifUrl()}" alt="" draggable="false" style="${imgStyle}"></span>` +
      (badge && BADGE[mood]
        ? `<span class="hk-badge" aria-hidden="true" style="position:absolute;top:-6%;right:-4%;font-size:var(--hk-badge-size,18px);line-height:1;pointer-events:none">${BADGE[mood]}</span>`
        : '') +
      `</span>`
    );
  }

  // Escalation level -> mood.
  function moodForLevel(level) {
    return ['stern', 'worried', 'angry', 'furious'][level] || 'stern';
  }

  const Hackie = { html, svg: html, moodForLevel, gifUrl, BADGE, IDLE_MOODS };
  globalThis.Hackie = Hackie;
  // Older call sites used the tomato's name; keep them working.
  globalThis.TaskWhipPomo = Hackie;
})();
