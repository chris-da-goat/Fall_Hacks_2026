// Hackie, the FH26 robot, drawn from the team's art in extension/assets/ (the one place Hackie's
// art lives): hackie.gif (idle), sprites/angry-1..6.png (cycled while angry) and
// sprites/hover-*.png (a face whose eyes follow the mouse). Classic script (not a module) so the
// content script, popup, options and report pages, and the service worker, can all share it.
// Exposes globalThis.Hackie.html({ mood, whip, badge }) -> HTML string.
(() => {
  if (globalThis.Hackie) return;

  // All of Hackie's art, by role. Add new art to extension/assets/ and list it here.
  const ART = {
    idle: 'assets/hackie.gif',
    look: 'assets/sprites/hover-base.png',
    eyeL: 'assets/sprites/hover-eye-left.png',
    eyeR: 'assets/sprites/hover-eye-right.png',
    angry: [1, 2, 3, 4, 5, 6].map((i) => `assets/sprites/angry-${i}.png`),
  };
  const ART_FILES = [ART.idle, ART.look, ART.eyeL, ART.eyeR, ...ART.angry];
  // The team's font (Inter ExtraBold). On web pages it arrives with the art as a data: URL.
  const FONT = 'assets/fonts/inter-latin-800-normal.woff2';
  const FONT_FAMILY = 'HackieInter';

  // The team's V3 crop of the 64x64 sprites (a little room at the top and sides for steam puffs).
  const CROP = { x: 4, y: 3, w: 50, h: 48 };
  const ANGRY_FRAME_MS = 380; // the team's pace for flipping through the angry pictures
  // Eyes of the hover sprite: centre in sprite pixels, and how far (in sprite pixels) they may slide.
  const EYES = { left: { x: 24.5, y: 34.5 }, right: { x: 41.5, y: 35.5 }, maxX: 2, maxY: 1 };

  // Mood badges from the team's version. Angry, furious and curious have real art instead.
  const BADGE = {
    happy: '😊', wink: '😉', surprised: '😮', sleepy: '💤', silly: '🤪', cool: '😎', love: '💕',
    curious: '❓', stern: '🤨', worried: '😟', angry: '💢', furious: '🤬',
  };
  const ART_MOODS = new Set(['angry', 'furious', 'curious']);
  const IDLE_MOODS = ['happy', 'wink', 'surprised', 'sleepy', 'silly', 'cool', 'love'];

  const FILTER = {
    angry: 'drop-shadow(0 0 3px rgba(255,42,42,.9))',
    furious: 'drop-shadow(0 0 6px rgba(255,42,42,1)) saturate(1.25)',
  };

  // On web pages the art comes in as data: URLs from the service worker (see useArt): pages never
  // load chrome-extension:// files, which some sites (YouTube's service worker) log as unsafe.
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  let data = {};
  const inExtensionPage = () => {
    try {
      return location.protocol === 'chrome-extension:';
    } catch {
      return false;
    }
  };

  /** Hand Hackie the art as {path: dataUrl} (web pages). */
  function useArt(map) {
    data = map && typeof map === 'object' ? { ...map } : {};
  }
  const hasArt = () => inExtensionPage() || ART_FILES.every((p) => data[p]);

  function artUrl(path) {
    if (data[path]) return data[path];
    if (inExtensionPage()) {
      try {
        return chrome.runtime.getURL(path);
      } catch {
        return `../${path}`;
      }
    }
    return BLANK;
  }
  const gifUrl = () => artUrl(ART.idle);

  /**
   * Install Inter ExtraBold as "HackieInter" for this document (works inside shadow roots too).
   * Uses the bytes, not a URL, so the page's CSP and its service worker never see a request.
   * @returns {Promise<boolean>} true once the font is ready.
   */
  let fontPromise = null;
  function installFont() {
    if (fontPromise) return fontPromise;
    fontPromise = (async () => {
      try {
        if (typeof FontFace === 'undefined' || !globalThis.document?.fonts) return false;
        let bytes = null;
        const url = data[FONT];
        if (url && url.startsWith('data:')) {
          const bin = atob(url.slice(url.indexOf(',') + 1));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else if (inExtensionPage()) {
          bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL(FONT))).arrayBuffer());
        }
        if (!bytes) return false;
        const face = new FontFace(FONT_FAMILY, bytes.buffer, { weight: '100 900', style: 'normal' });
        await face.load();
        document.fonts.add(face);
        return true;
      } catch {
        return false;
      }
    })();
    return fontPromise;
  }

  // The whip lives in a 120x120 viewBox laid over the sprite; the hand is on Hackie's left side.
  const WHIP =
    '<svg class="hk-whip-svg" viewBox="0 0 120 120" overflow="visible" aria-hidden="true" ' +
    'style="position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none">' +
    '<g class="hk-whip" transform="translate(4 12)">' +
    '<path class="hk-lash" d="M9 63 C -8 40, -30 28, -50 42 S -78 72, -104 50" fill="none" stroke="#5a3a22" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M-104 50 l-7 -4 m7 4 l-6 5" stroke="#5a3a22" stroke-width="2" stroke-linecap="round"/>' +
    '<rect x="6" y="60" width="18" height="7.5" rx="3.5" transform="rotate(38 15 64)" fill="#7a4b2a"/>' +
    '<g class="hk-burst" transform="translate(-104 50)" opacity="0">' +
    '<polygon points="0,-22 6,-8 22,-12 10,0 22,12 6,8 0,22 -6,8 -22,12 -10,0 -22,-12 -6,-8" fill="#ffd23f" stroke="#e08a00" stroke-width="1.5"/>' +
    '</g></g></svg>';

  // The sprite box: the crop fitted into the square box, centred.
  const BOX = (() => {
    const wide = CROP.w >= CROP.h;
    const w = wide ? 100 : (CROP.w / CROP.h) * 100;
    const h = wide ? (CROP.h / CROP.w) * 100 : 100;
    return `left:${(100 - w) / 2}%;top:${(100 - h) / 2}%;width:${w}%;height:${h}%;`;
  })();
  const LAYER =
    `position:absolute;left:${(-CROP.x / CROP.w) * 100}%;top:${(-CROP.y / CROP.h) * 100}%;` +
    `width:${(64 / CROP.w) * 100}%;height:${(64 / CROP.h) * 100}%;max-width:none;image-rendering:pixelated;` +
    '-webkit-user-drag:none;user-select:none;';
  const layer = (src, cls = '', extra = '') => `<img class="hk-layer${cls ? ` ${cls}` : ''}" src="${src}" alt="" draggable="false" style="${LAYER}${extra}">`;

  const ANGRY_MS = ANGRY_FRAME_MS * ART.angry.length;
  const ANGRY_CSS =
    `<style>@keyframes hk-af{0%{opacity:1}${(100 / ART.angry.length).toFixed(3)}%,100%{opacity:0}}` +
    `.hk-af{animation:hk-af ${ANGRY_MS}ms step-end infinite}` +
    '@media (prefers-reduced-motion: reduce){.hk-af{animation:none}}</style>';

  function layers(mood) {
    if (mood === 'angry' || mood === 'furious') {
      // The team's angry pictures, one at a time (frame i shows during [i*F, (i+1)*F) of the cycle).
      return (
        ANGRY_CSS +
        ART.angry
          .map((p, i) => layer(artUrl(p), 'hk-af', `opacity:${i ? 0 : 1};animation-delay:${i * ANGRY_FRAME_MS - ANGRY_MS}ms;`))
          .join('')
      );
    }
    if (mood === 'curious') {
      return layer(artUrl(ART.look)) + layer(artUrl(ART.eyeL), 'hk-eye-l') + layer(artUrl(ART.eyeR), 'hk-eye-r');
    }
    return layer(artUrl(ART.idle));
  }

  /**
   * Draws Hackie filling a square box (set the box's size; Hackie keeps the sprite's pixel ratio).
   * Set --hk-badge-size on the box to scale the emoji badge (default 18px).
   * @param {object} [opts]
   * @param {string} [opts.mood]   happy | stern | worried | angry | furious | curious | wink | …
   * @param {boolean} [opts.whip]  Draw the whip.
   * @param {boolean} [opts.badge] Show the emoji mood badge (moods without their own art).
   */
  function html({ mood = 'stern', whip = true, badge = true } = {}) {
    const filter = FILTER[mood] || 'none';
    return (
      `<span class="hk hk-${mood}" style="position:relative;display:block;width:100%;height:100%">` +
      (whip ? WHIP : '') +
      `<span class="hk-sprite" style="position:absolute;${BOX}overflow:hidden;filter:${filter};transition:transform .2s">` +
      layers(mood) +
      `</span>` +
      (badge && BADGE[mood] && !ART_MOODS.has(mood)
        ? `<span class="hk-badge" aria-hidden="true" style="position:absolute;top:-6%;right:-4%;font-size:var(--hk-badge-size,18px);line-height:1;pointer-events:none">${BADGE[mood]}</span>`
        : '') +
      `</span>`
    );
  }

  /**
   * Curious Hackie's eyes follow a point on screen (client coordinates), in whole sprite pixels so
   * the pixel art stays crisp. `el` is anything containing Hackie.html({ mood: 'curious' }).
   */
  function lookAt(el, x, y) {
    const sprite = el?.querySelector?.('.hk-sprite');
    const left = el?.querySelector?.('.hk-eye-l');
    const right = el?.querySelector?.('.hk-eye-r');
    if (!sprite || !left || !right) return;
    const rect = sprite.getBoundingClientRect();
    const px = rect.width / CROP.w; // screen pixels per sprite pixel
    if (!px) return;
    const slide = (eye) => {
      const dx = x - (rect.left + (eye.x - CROP.x) * px);
      const dy = y - (rect.top + (eye.y - CROP.y) * px);
      const dist = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, dist / (25 * px)); // eyes settle in the middle when the point is right on them
      return [Math.round((dx / dist) * EYES.maxX * k), Math.round((dy / dist) * EYES.maxY * k)];
    };
    for (const [img, eye] of [[left, EYES.left], [right, EYES.right]]) {
      const [sx, sy] = slide(eye);
      const t = `translate(${(sx * 100) / 64}%, ${(sy * 100) / 64}%)`;
      if (img.style.transform !== t) img.style.transform = t;
    }
  }

  // Escalation level -> mood.
  function moodForLevel(level) {
    return ['stern', 'worried', 'angry', 'furious'][level] || 'stern';
  }

  const Hackie = { html, svg: html, moodForLevel, lookAt, useArt, hasArt, artUrl, gifUrl, installFont, ART, ART_FILES, FONT, FONT_FAMILY, CROP, EYES, BADGE, IDLE_MOODS };
  globalThis.Hackie = Hackie;
  // Older call sites used the tomato's name; keep them working.
  globalThis.TaskWhipPomo = Hackie;
})();
