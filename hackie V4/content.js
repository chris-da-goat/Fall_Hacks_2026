// Hackie - content script (runs on YouTube + Instagram)
// Hackie patrols the edges of the screen, changes expressions at random,
// and gets angrier the more you hit "5 more min".

const DEFAULT_LIMIT_MIN = 20;
const SNOOZE_MINUTES = [5, 3, 2]; // 1st nag: 5 min, 2nd: 3 min, 3rd and later: 2 min (the minimum)
const FLUSH_EVERY = 5; // seconds between storage writes
const EXERCISES = [
  "10 squats",
  "10 push-ups",
  "a 1-minute plank",
  "20 jumping jacks",
  "a quick walk around the room",
  "10 lunges per leg",
  "a big full-body stretch",
];

// Random expressions used while Clippy is just floating around
const EXPRESSIONS = [
  "happy",
  "wink",
  "surprised",
  "sleepy",
  "silly",
  "cool",
  "love",
];
const EXPRESSION_EVERY_MS = 6000;
const FACE_LABEL = {
  happy: "Happy",
  surprised: "Surprised",
  sleepy: "Sleepy",
  silly: "Silly",
  cool: "Feeling cool",
  curious: "Curious",
  worried: "Worried",
  angry: "Angry",
};

// Patrol settings
const SCALE = 2; // pixel-art zoom (2 keeps the pixels crisp)
const CROP = { x: 4, y: 3, w: 50, h: 48 }; // visible part of the 64x64 sprites (a little extra room at the top/sides for steam puffs)
const CLIP_W = CROP.w * SCALE,
  CLIP_H = CROP.h * SCALE;
const SIDE_OFFSET = CLIP_W + 10; // how far bubbles sit from the icon
const ICON_URL = chrome.runtime.getURL("clippy.gif");
const SPRITE = (name) => chrome.runtime.getURL("sprites/" + name);
const ANGRY_FRAMES = 6; // sprites/angry-1.png ... angry-6.png, cycled while he is angry
const ANGRY_FRAME_MS = 380; // how long each angry picture stays up
// Eyes of the mouse-tracking sprite (sprites/hover-*.png): centre in sprite pixels, and how far they may slide
const EYE_TRACK = {
  left: { x: 24.5, y: 34.5 },
  right: { x: 41.5, y: 35.5 },
  maxX: 2,
  maxY: 1,
};
const EDGE_MARGIN = 8; // how close to the screen edge he hugs
const PANEL_COLOR = "#247287"; // report panel color (same as the popup)
const SPEED = 20; // px per second along the edge (slow stroll)
const HOVER_RADIUS = 130; // mouse this close to Clippy -> he stops and looks at it
const DRAG_THRESHOLD = 5; // px you must move the mouse before a click turns into a drag
const GLIDE_MS = 350; // after you drop him, how long he takes to slide back to the nearest edge

// ---------- shared state (kept in chrome.storage so all tabs agree) ----------
let state = { nagging: false, snoozeUntil: 0, snoozeCount: 0 };
let cheerUntil = 0; // show a "nice job" bubble until this time
let nagMinutes = DEFAULT_LIMIT_MIN;
let curExercise = EXERCISES[0];
let expr = "happy"; // current random expression
let lastKey = "";
let sideSig = "";
let pos = { x: 0, y: 0 };
let pending = 0;
let panelOpen = false; // is the info panel showing?
let draggingBar = false; // is the test slider being dragged?
let hovering = false; // is the mouse near Clippy?
let mouse = { x: -9999, y: -9999 };
let speedFactor = 1; // 1 = walking, 0 = standing still (eases between the two)
let dragging = false; // is Clippy being dragged around by the mouse?
let dragStart = null; // where the mouse went down (to tell a click from a drag)
let lastDragEnd = 0; // when the last drag ended (so that drag doesn't also count as a click)
let glide = null; // slide back to the patrol edge after a drop
let angryFrame = 0,
  angryTick = 0; // which angry picture is showing, and when it last changed
let eyeSig = "0,0,0,0"; // where the tracking eyes currently are (to skip needless updates)
let cache = { usage: {}, sinceNag: 0, limitMin: DEFAULT_LIMIT_MIN }; // mirrors storage for the panel

function alive() {
  return !!(chrome.runtime && chrome.runtime.id);
}

// How many minutes the "more minutes" button will give on THIS nag
function nextSnoozeMin() {
  return SNOOZE_MINUTES[Math.min(state.snoozeCount, SNOOZE_MINUTES.length - 1)];
}

// If the watch-time counter has reached the limit (e.g. from the test slider), start nagging now
function maybeNag() {
  const busy = state.nagging || state.snoozeUntil > Date.now();
  if (!busy && cache.sinceNag >= cache.limitMin * 60) {
    nagMinutes = cache.limitMin;
    cache.sinceNag = 0;
    pending = 0;
    chrome.storage.local.set({ sinceNag: 0 });
    setState({ nagging: true });
  }
}

function setState(patch) {
  Object.assign(state, patch);
  chrome.storage.local.set(patch);
  render();
}

chrome.storage.onChanged.addListener((changes) => {
  for (const k of ["nagging", "snoozeUntil", "snoozeCount"]) {
    if (changes[k])
      state[k] = changes[k].newValue ?? (k === "nagging" ? false : 0);
  }
  if (changes.usage) cache.usage = changes.usage.newValue || {};
  if (changes.sinceNag) cache.sinceNag = changes.sinceNag.newValue || 0;
  if (changes.limitMin)
    cache.limitMin = changes.limitMin.newValue || DEFAULT_LIMIT_MIN;
  maybeNag();
  render();
});

// ---------- mascot faces ----------
const EYES = `<circle cx="22" cy="30" r="6" fill="#fff" stroke="#333"/><circle cx="38" cy="30" r="6" fill="#fff" stroke="#333"/>`;
const BROWS = `<path d="M15 20 q7 -6 14 0 M31 20 q7 -6 14 0" stroke="#333" stroke-width="2" fill="none"/>`;
const SMILE = `<path d="M24 44 q6 6 12 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>`;

// A pupil tagged with class="pupil" can be moved to look at the mouse.
// (cx,cy) = resting position, (ex,ey) = centre of the eye it sits in.
const pup = (cx, cy, ex, ey, r = 2.5) =>
  `<circle class="pupil" data-ex="${ex}" data-ey="${ey}" cx="${cx}" cy="${cy}" r="${r}"/>`;

const FACES = {
  happy: `${EYES}${pup(23, 31, 22, 30)}${pup(39, 31, 38, 30)}${BROWS}${SMILE}`,

  wink: `<path d="M16 31 q6 -5 12 0" stroke="#333" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="38" cy="30" r="6" fill="#fff" stroke="#333"/>${pup(39, 31, 38, 30)}
    <path d="M31 20 q7 -6 14 0" stroke="#333" stroke-width="2" fill="none"/>
    <path d="M23 44 q7 7 14 -1" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>`,

  surprised: `<circle cx="22" cy="30" r="7.5" fill="#fff" stroke="#333"/><circle cx="38" cy="30" r="7.5" fill="#fff" stroke="#333"/>
    <circle cx="22" cy="30" r="2" /><circle cx="38" cy="30" r="2"/>
    <path d="M14 16 q7 -6 14 0 M32 16 q7 -6 14 0" stroke="#333" stroke-width="2" fill="none"/>
    <ellipse cx="30" cy="47" rx="4" ry="5.5" fill="#333"/>`,

  sleepy: `<path d="M16 31 q6 5 12 0 M32 31 q6 5 12 0" stroke="#333" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path d="M27 46 q3 3 6 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>
    <text x="47" y="18" font-size="13" font-weight="bold" fill="#555">z</text>
    <text x="55" y="9" font-size="9" font-weight="bold" fill="#555">z</text>`,

  silly: `${EYES}${pup(26, 31, 22, 30)}${pup(34, 31, 38, 30)}${BROWS}
    <path d="M23 44 q7 7 14 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M28 47 q3 10 7 0 z" fill="#ff7a8a" stroke="#333" stroke-width="1"/>`,

  cool: `<rect x="11" y="25" width="17" height="11" rx="3" fill="#222"/><rect x="32" y="25" width="17" height="11" rx="3" fill="#222"/>
    <path d="M28 29 h4" stroke="#222" stroke-width="2"/>
    <path d="M24 45 q6 4 13 -2" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>`,

  love: `<text x="14" y="37" font-size="16" fill="#e0245e">♥</text><text x="31" y="37" font-size="16" fill="#e0245e">♥</text>
    <path d="M23 44 q7 8 14 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>`,

  // shown while the mouse is near Clippy
  curious: `<circle cx="22" cy="30" r="7" fill="#fff" stroke="#333"/><circle cx="38" cy="30" r="7" fill="#fff" stroke="#333"/>
    ${pup(22, 30, 22, 30, 3)}${pup(38, 30, 38, 30, 3)}
    <path d="M14 23 L29 23" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M31 17 q7 -8 14 -2" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>
    <ellipse cx="31" cy="46" rx="3" ry="3.5" fill="#333"/>
    <text x="48" y="15" font-size="14" font-weight="bold" fill="#e08a00">?</text>`,

  // used for the nag after 1-3 snoozes
  worried: `${EYES}${pup(20, 32, 22, 30)}${pup(36, 32, 38, 30)}
    <path d="M15 22 L29 17 M31 17 L45 22" stroke="#333" stroke-width="2" fill="none"/>
    <path d="M24 46 q3 -3 6 0 t6 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M54 16 q4 6 0 9 q-4 -3 0 -9z" fill="#5bc0eb"/>`,

  // after 4+ snoozes
  angry: `<circle cx="14" cy="40" r="4.5" fill="#ff6b6b" opacity=".6"/><circle cx="46" cy="40" r="4.5" fill="#ff6b6b" opacity=".6"/>
    <circle cx="22" cy="31" r="6" fill="#fff" stroke="#333"/><circle cx="38" cy="31" r="6" fill="#fff" stroke="#333"/>
    ${pup(22, 32, 22, 31, 2)}${pup(38, 32, 38, 31, 2)}
    <path d="M14 21 L29 27 M31 27 L46 21" stroke="#222" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <path d="M23 49 q7 -8 14 0" stroke="#333" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <text x="46" y="14" font-size="15">💢</text>`,
};

function faceSvg(face) {
  const wire = `<path d="M45 20 V70 a18 18 0 0 1 -36 0 V25 a12 12 0 0 1 24 0 V68 a6 6 0 0 1 -12 0 V30"
        fill="none" stroke="#9aa0a6" stroke-width="6" stroke-linecap="round"/>`;
  const bun =
    face === "angry"
      ? `<circle cx="21" cy="9" r="8" fill="#8b5a2b"/><path d="M14 9 q7 -5 14 0" stroke="#5c3a1a" stroke-width="2" fill="none"/>`
      : "";
  return `<svg width="${CLIP_W}" height="${CLIP_H}" viewBox="0 0 70 110" xmlns="http://www.w3.org/2000/svg">${bun}${wire}${FACES[face]}</svg>`;
}

// ---------- patrol path: a loop around the edges of the viewport ----------
function bounds() {
  return {
    minX: EDGE_MARGIN,
    minY: EDGE_MARGIN,
    maxX: Math.max(EDGE_MARGIN + 1, innerWidth - CLIP_W - EDGE_MARGIN),
    maxY: Math.max(EDGE_MARGIN + 1, innerHeight - CLIP_H - EDGE_MARGIN),
  };
}
function perimeterLength() {
  const b = bounds();
  return 2 * (b.maxX - b.minX + (b.maxY - b.minY));
}
function perimeterPoint(u) {
  // u in [0,1): position along the rectangle's outline
  const b = bounds(),
    w = b.maxX - b.minX,
    h = b.maxY - b.minY;
  let s = (((u % 1) + 1) % 1) * 2 * (w + h);
  if (s < w) return { x: b.minX + s, y: b.minY }; // top edge, going right
  s -= w;
  if (s < h) return { x: b.maxX, y: b.minY + s }; // right edge, going down
  s -= h;
  if (s < w) return { x: b.maxX - s, y: b.maxY }; // bottom edge, going left
  s -= w;
  return { x: b.minX, y: b.maxY - s }; // left edge, going up
}

function nearestU(p) {
  // the spot on the patrol loop that is closest to a point (used after a drop)
  const b = bounds(),
    w = b.maxX - b.minX,
    h = b.maxY - b.minY;
  const x = Math.min(b.maxX, Math.max(b.minX, p.x)),
    y = Math.min(b.maxY, Math.max(b.minY, p.y));
  const dTop = y - b.minY,
    dRight = b.maxX - x,
    dBottom = b.maxY - y,
    dLeft = x - b.minX;
  const m = Math.min(dTop, dRight, dBottom, dLeft);
  let s;
  if (m === dTop)
    s = x - b.minX; // top edge, going right
  else if (m === dRight)
    s = w + (y - b.minY); // right edge, going down
  else if (m === dBottom)
    s = w + h + (b.maxX - x); // bottom edge, going left
  else s = 2 * w + h + (b.maxY - y); // left edge, going up
  return s / (2 * (w + h));
}

let u = 0.5; // start at the bottom-right corner
let dir = 1; // walking direction around the loop
let pauseUntil = 0;

// ---------- DOM (built once) ----------
try {
  const fontStyle = document.createElement("style");
  fontStyle.textContent = `@font-face { font-family:"ClippyInter"; font-weight:800; font-style:normal; font-display:swap;
    src:url("${chrome.runtime.getURL("fonts/inter-latin-800-normal.woff2")}") format("woff2"); }`;
  (document.head || document.documentElement).appendChild(fontStyle);
} catch (e) {
  /* falls back to the system font */
}

const host = document.createElement("div");
host.id = "hackie-host";
pos = perimeterPoint(u);
host.style.cssText = `position:fixed;left:0;top:0;width:${CLIP_W}px;height:${CLIP_H}px;
  z-index:2147483647;pointer-events:none;transform:translate(${pos.x}px,${pos.y}px);`;
const root = host.attachShadow({ mode: "open" }); // site CSS can't touch us
root.innerHTML = `
  <style>
    .clip { position:relative; width:${CLIP_W}px; height:${CLIP_H}px; animation: bob 1.4s ease-in-out infinite; pointer-events:auto; cursor:grab;
      touch-action:none; user-select:none; -webkit-user-select:none; }
    .sprite { position:relative; width:${CLIP_W}px; height:${CLIP_H}px; overflow:hidden; transition: transform .2s; }
    .sprite img { position:absolute; left:${-CROP.x * SCALE}px; top:${-CROP.y * SCALE}px; width:${64 * SCALE}px; height:${64 * SCALE}px;
      image-rendering:pixelated; max-width:none; -webkit-user-drag:none; user-select:none; }
    /* sprite layers: idle gif | eye-tracking look (mouse near) | angry pictures (cycled) */
    .sprite .lk, .sprite .af { display:none; }
    .clip.looking:not(.angry) .idle { display:none; }
    .clip.looking:not(.angry) .lk { display:block; }
    .clip.angry .idle { display:none; }
    ${Array.from({ length: ANGRY_FRAMES }, (_, i) => `.clip.angry[data-af="${i}"] .af${i} { display:block; }`).join("\n    ")}
    .clip.angry .sprite { filter: drop-shadow(0 0 4px #ff2a2a); }
    .clip.angry { animation: shake .35s linear infinite; }
    .clip[data-grabbed] { cursor:grabbing; animation:none; }   /* while being dragged */
    @keyframes bob { 50% { transform: translateY(-6px); } }
    @keyframes shake { 0%,100% { transform: translateX(0) rotate(0); }
      25% { transform: translateX(-2px) rotate(-3deg); } 75% { transform: translateX(2px) rotate(3deg); } }
    .side { position:absolute; top:10px; left:${SIDE_OFFSET}px; pointer-events:auto; font-family:sans-serif; }
    /* break popup + snooze countdown: same teal, white Inter ExtraBold as the popup and report */
    .bubble { width:max-content; max-width:260px; background:${PANEL_COLOR}; color:#fff; border:0;
      border-radius:12px; padding:12px 14px; font-family:"ClippyInter", Inter, system-ui, sans-serif; font-weight:800;
      font-size:14px; line-height:1.4; box-shadow:none; }
    .btns { margin-top:10px; display:flex; gap:6px; flex-wrap:wrap; }
    button { cursor:pointer; border:0; background:rgba(255,255,255,.2); color:#fff; font:inherit; font-size:13px;
      border-radius:6px; padding:5px 10px; }
    button:hover { background:rgba(255,255,255,.35); }
    .pill { width:max-content; background:${PANEL_COLOR}; color:#fff; border:0; border-radius:14px;
      padding:5px 12px; font-family:"ClippyInter", Inter, system-ui, sans-serif; font-weight:800; font-size:14px;
      white-space:nowrap; box-shadow:none; }
    /* report panel: teal rounded rectangle, white Inter ExtraBold */
    .panel { display:none; width:262px; box-sizing:border-box; background:${PANEL_COLOR}; color:#fff; border:0;
      border-radius:12px; padding:12px 14px; font-family:"ClippyInter", Inter, system-ui, sans-serif; font-weight:800;
      font-size:13px; line-height:1.4; box-shadow:none; }
    .panel button { border:0; background:none; color:#fff; font:inherit; padding:0 4px; border-radius:4px; }
    .panel button:hover { background:rgba(255,255,255,.2); }
    .ph { display:flex; justify-content:space-between; align-items:center; font-size:14px; }
    .row { display:flex; justify-content:space-between; gap:10px; margin-top:7px; }
    .row b { text-align:right; }
    .note { margin-top:8px; font-size:12px; color:rgba(255,255,255,.85); }
    .test { margin-top:10px; border-top:1px dashed rgba(255,255,255,.6); padding-top:6px; font-size:12px; }
    .test input { width:100%; margin:4px 0 0; accent-color:#fff; }
  </style>
  <div class="clip" id="clip" data-af="0"><div class="sprite">
    <img class="idle" src="${ICON_URL}" alt="" draggable="false">
    <img class="lk" src="${SPRITE("hover-base.png")}" alt="" draggable="false">
    <img class="lk" id="eye-l" src="${SPRITE("hover-eye-left.png")}" alt="" draggable="false">
    <img class="lk" id="eye-r" src="${SPRITE("hover-eye-right.png")}" alt="" draggable="false">
    ${Array.from({ length: ANGRY_FRAMES }, (_, i) => `<img class="af af${i}" src="${SPRITE("angry-" + (i + 1) + ".png")}" alt="" draggable="false">`).join("\n    ")}
  </div></div>
  <div class="side" id="side"></div>
  <div class="side panel" id="panel">
    <div class="ph"><b>Hackie's report</b><button id="x">✕</button></div>
    <div class="row"><span>Scrolling today</span><b id="p-today"></b></div>
    <div class="row"><span>Since last break</span><b id="p-since"></b></div>
    <div class="row"><span>Snooze countdown</span><b id="p-cd"></b></div>
    <div class="row"><span>Hackie's mood</span><b id="p-mood"></b></div>
    <div class="note" id="p-note"></div>
  </div>`;
document.body.appendChild(host);
const clipEl = root.getElementById("clip");
const eyeL = root.getElementById("eye-l"),
  eyeR = root.getElementById("eye-r");
const sideEl = root.getElementById("side");
const panelEl = root.getElementById("panel");

// Keep the bubble/pill/panel on whichever side has room and on-screen vertically
function updateSide(mode) {
  const el = panelOpen ? panelEl : sideEl;
  if (!panelOpen && mode === "idle") return;
  const w = panelOpen ? 272 : mode === "snooze" ? 100 : 285;
  const h = panelOpen ? 270 : mode === "nag" ? 200 : 50;
  const onRight = pos.x + SIDE_OFFSET + w <= innerWidth;
  const anchorBottom = pos.y + 10 + h > innerHeight;
  const sig = `${panelOpen}${onRight}${anchorBottom}`;
  if (sig === sideSig) return;
  sideSig = sig;
  el.style.left = onRight ? SIDE_OFFSET + "px" : "auto";
  el.style.right = onRight ? "auto" : SIDE_OFFSET + "px";
  el.style.top = anchorBottom ? "auto" : "10px";
  el.style.bottom = anchorBottom ? "10px" : "auto";
}

// ---------- mode + face ----------
function getMode() {
  if (state.nagging) return "nag";
  if (state.snoozeUntil > Date.now()) return "snooze";
  if (cheerUntil > Date.now()) return "cheer";
  return "idle";
}
function getMood() {
  // escalation level, used for the nag bubble
  const n = state.snoozeCount;
  return n > 3 ? "angry" : n >= 1 ? "worried" : "happy";
}
function getFace(mode) {
  if (mode === "nag") return getMood(); // face matches the message
  if (state.snoozeCount > 3) return "angry"; // angry stays until you exercise
  if (hovering) return "curious"; // mouse nearby
  if (mode === "cheer") return "happy";
  return expr; // otherwise: random expression
}

function nagText(mood) {
  const n = state.snoozeCount,
    m = nextSnoozeMin(),
    ex = `<b>${curExercise}</b>`;
  if (mood === "angry")
    return {
      msg: `${n} snoozes?! Young person, put the phone down and do ${ex} RIGHT NOW! I'm only giving you ${m} more min.`,
      ok: "Fine, I'm doing it",
      later: `Just ${m} more`,
    };
  if (mood === "worried")
    return {
      msg: `That's snooze #${n}...<br>Please do ${ex}. I'm getting stingy: only ${m} min this time.`,
      ok: "OK, I did it",
      later: `${m} more min...`,
    };
  return {
    msg: `It looks like you've been scrolling for ${nagMinutes}+ minutes.<br>Want to do ${ex}?`,
    ok: "I did it!",
    later: `${m} more min`,
  };
}

// ---------- info panel (click Clippy to open) ----------
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    r = sec % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(r).padStart(2, "0")}s`;
}

function setPanel(open) {
  panelOpen = open;
  panelEl.style.display = open ? "block" : "none";
  sideEl.style.display = open ? "none" : "block";
  sideSig = "";
  updateSide(getMode());
  updatePanel();
}

function updatePanel() {
  if (!panelOpen) return;
  const mode = getMode(),
    face = getFace(mode),
    n = state.snoozeCount;
  const q = (id) => root.getElementById(id);

  const today = (cache.usage[new Date().toDateString()] || 0) + pending;
  q("p-today").textContent = fmtDur(today);

  if (mode === "nag") q("p-since").textContent = "limit reached";
  else if (mode === "snooze") q("p-since").textContent = "paused";
  else
    q("p-since").textContent =
      `${fmtDur(cache.sinceNag + pending)} / ${cache.limitMin} min`;

  if (mode === "nag") q("p-cd").textContent = "waiting for you!";
  else if (mode === "snooze")
    q("p-cd").textContent = fmtDur(
      (state.snoozeUntil - Date.now()) / 1000,
    ).replace(/^(\d+)m (\d+)s$/, "$1:$2");
  else q("p-cd").textContent = "none";

  q("p-mood").textContent = FACE_LABEL[face];
  q("p-note").textContent =
    n > 3
      ? `${n} snoozes in a row. She's had enough!`
      : n === 3
        ? "3 snoozes in a row. One more and she loses it..."
        : n > 0
          ? `${n} snooze${n > 1 ? "s" : ""} in a row.`
          : "No snoozes yet. Good job!";
  q("p-note").textContent += ` Next snooze: ${nextSnoozeMin()} min.`;
}

clipEl.addEventListener("click", () => {
  if (performance.now() - lastDragEnd < 300) return; // that was the end of a drag, not a click
  setPanel(!panelOpen);
});

// ---------- drag Clippy anywhere on the screen ----------
// Press and move > DRAG_THRESHOLD px to pick him up; let go and he slides back to the nearest edge and keeps patrolling.
clipEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragStart = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
  clipEl.setPointerCapture(e.pointerId);
});
clipEl.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const dx = e.clientX - dragStart.x,
    dy = e.clientY - dragStart.y;
  if (!dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
    glide = null;
    clipEl.dataset.grabbed = "1";
  }
  pos = {
    x: Math.min(
      Math.max(0, innerWidth - CLIP_W),
      Math.max(0, dragStart.px + dx),
    ),
    y: Math.min(
      Math.max(0, innerHeight - CLIP_H),
      Math.max(0, dragStart.py + dy),
    ),
  };
  host.style.transform = `translate(${pos.x}px,${pos.y}px)`;
});
function endDrag(e) {
  if (!dragStart) return;
  try {
    clipEl.releasePointerCapture(e.pointerId);
  } catch (err) {
    /* already released */
  }
  if (dragging) {
    dragging = false;
    delete clipEl.dataset.grabbed;
    lastDragEnd = performance.now();
    u = nearestU(pos);
    glide = { from: { x: pos.x, y: pos.y }, t0: performance.now() };
  }
  dragStart = null;
}
clipEl.addEventListener("pointerup", endDrag);
clipEl.addEventListener("pointercancel", endDrag);
const barEl = root.getElementById("p-bar");

root.getElementById("x").addEventListener("click", () => setPanel(false));
document.addEventListener(
  "mousedown",
  (e) => {
    // click anywhere else to close
    if (panelOpen && !e.composedPath().includes(host)) setPanel(false);
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panelOpen) setPanel(false);
});

// ---------- render ----------
function render() {
  const mode = getMode(),
    face = getFace(mode),
    mood = getMood();
  const key = mode + face + state.snoozeCount;

  if (key !== lastKey) {
    // only rebuild when something actually changed
    lastKey = key;
    sideSig = "";
    clipEl.className = "clip " + face;

    if (mode === "nag") {
      curExercise = EXERCISES[Math.floor(Math.random() * EXERCISES.length)];
      const t = nagText(mood);
      sideEl.innerHTML = `<div class="bubble ${mood === "angry" ? "angry" : ""}">${t.msg}
        <div class="btns"><button id="ok">${t.ok}</button><button id="later">${t.later}</button></div></div>`;
      root.getElementById("ok").onclick = onDone;
      root.getElementById("later").onclick = onSnooze;
    } else if (mode === "snooze") {
      sideEl.innerHTML = `<div class="pill ${state.snoozeCount > 3 ? "angry" : ""}"><span id="cd"></span></div>`;
    } else if (mode === "cheer") {
      sideEl.innerHTML = `<div class="bubble">Nice! Hackie is proud of you.</div>`;
    } else {
      sideEl.innerHTML = "";
    }
    updateSide(mode);
  }

  if (mode === "snooze") {
    // live countdown
    const left = Math.max(
      0,
      Math.ceil((state.snoozeUntil - Date.now()) / 1000),
    );
    const cd = root.getElementById("cd");
    if (cd)
      cd.textContent =
        Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  }
  updatePanel();
}

async function onDone() {
  const { exercises = 0 } = await chrome.storage.local.get("exercises");
  chrome.storage.local.set({ exercises: exercises + 1, sinceNag: 0 });
  cheerUntil = Date.now() + 4000;
  setState({ nagging: false, snoozeUntil: 0, snoozeCount: 0 });
}

function onSnooze() {
  chrome.storage.local.set({ sinceNag: 0 });
  setState({
    nagging: false,
    snoozeUntil: Date.now() + nextSnoozeMin() * 60 * 1000,
    snoozeCount: state.snoozeCount + 1,
  });
}

// ---------- looking at the mouse ----------
window.addEventListener(
  "mousemove",
  (e) => {
    mouse = { x: e.clientX, y: e.clientY };
  },
  { capture: true, passive: true },
);
document.documentElement.addEventListener("mouseleave", () => {
  mouse = { x: -9999, y: -9999 };
});

// The eyes of the "looking" sprite slide toward the mouse, in whole sprite pixels so the pixel art stays crisp.
function setEyes([lx, ly], [rx, ry]) {
  const sig = `${lx},${ly},${rx},${ry}`;
  if (sig === eyeSig) return;
  eyeSig = sig;
  eyeL.style.transform = `translate(${lx * SCALE}px,${ly * SCALE}px)`;
  eyeR.style.transform = `translate(${rx * SCALE}px,${ry * SCALE}px)`;
}
function lookAt() {
  const slide = (eye) => {
    const ex = pos.x + (eye.x - CROP.x) * SCALE,
      ey = pos.y + (eye.y - CROP.y) * SCALE; // eye centre on screen
    const dx = mouse.x - ex,
      dy = mouse.y - ey,
      dist = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, dist / 50); // eyes settle in the middle when the mouse is right on them
    return [
      Math.round((dx / dist) * EYE_TRACK.maxX * k),
      Math.round((dy / dist) * EYE_TRACK.maxY * k),
    ];
  };
  setEyes(slide(EYE_TRACK.left), slide(EYE_TRACK.right));
}
function resetPupils() {
  setEyes([0, 0], [0, 0]);
} // eyes back to the middle

// ---------- animation loop: walk along the screen edges ----------
let lastFrame = performance.now();
function frame(now) {
  if (!alive()) {
    host.remove();
    return;
  } // extension was reloaded
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const mode = getMode();

  // is the mouse close to Clippy?
  const near =
    Math.hypot(mouse.x - (pos.x + CLIP_W / 2), mouse.y - (pos.y + CLIP_H / 2)) <
    HOVER_RADIUS;
  if (near !== hovering) {
    hovering = near;
    render();
    if (!near) resetPupils();
  }
  const angry = clipEl.classList.contains("angry");
  clipEl.classList.toggle("looking", hovering && !angry); // mouse near: switch to the eye-tracking sprite (not while angry)
  if (hovering && !angry) lookAt();
  if (angry && now - angryTick > ANGRY_FRAME_MS) {
    // angry: flip through the angry pictures
    angryTick = now;
    angryFrame = (angryFrame + 1) % ANGRY_FRAMES;
    clipEl.dataset.af = angryFrame;
  }

  // walk, or ease to a stop when something wants his attention
  const still =
    mode === "nag" || panelOpen || hovering || dragging || now < pauseUntil;
  speedFactor += ((still ? 0 : 1) - speedFactor) * Math.min(1, dt * 6);
  if (speedFactor > 0.01 && !dragging && !glide)
    u += (dir * SPEED * speedFactor * dt) / perimeterLength();
  if (!still) {
    if (Math.random() < dt / 12) dir *= -1; // sometimes turn around
    if (Math.random() < dt / 10) pauseUntil = now + 1500 + Math.random() * 2500; // sometimes rest
  }

  if (!dragging) {
    // while dragging, the mouse decides where he is
    const target = perimeterPoint(u);
    if (glide) {
      // just dropped: slide back to the patrol edge
      const t = Math.min(1, (now - glide.t0) / GLIDE_MS),
        ease = 1 - Math.pow(1 - t, 3);
      pos = {
        x: glide.from.x + (target.x - glide.from.x) * ease,
        y: glide.from.y + (target.y - glide.from.y) * ease,
      };
      if (t >= 1) glide = null;
    } else pos = target;
  }
  host.style.transform = `translate(${pos.x}px,${pos.y}px)`;
  updateSide(mode);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- random expression every few seconds ----------
setInterval(() => {
  if (!alive() || getMode() === "nag") return;
  const options = EXPRESSIONS.filter((e) => e !== expr);
  expr = options[Math.floor(Math.random() * options.length)];
  render();
}, EXPRESSION_EVERY_MS);

// ---------- timer: runs every second ----------
const timer = setInterval(async () => {
  if (!alive()) {
    clearInterval(timer);
    host.remove();
    return;
  }

  // snooze finished -> nag again
  if (state.snoozeUntil && Date.now() >= state.snoozeUntil) {
    setState({ snoozeUntil: 0, nagging: true });
  } else {
    render(); // updates countdown / ends the cheer bubble
  }

  if (document.visibilityState !== "visible") return; // don't count background tabs
  pending++;
  if (pending < FLUSH_EVERY) return;
  const add = pending;
  pending = 0;

  try {
    const d = await chrome.storage.local.get([
      "usage",
      "sinceNag",
      "limitMin",
      "nagging",
      "snoozeUntil",
    ]);
    const usage = d.usage || {};
    const day = new Date().toDateString();
    usage[day] = (usage[day] || 0) + add;

    const busy = d.nagging || (d.snoozeUntil && d.snoozeUntil > Date.now());
    let sinceNag = (d.sinceNag || 0) + (busy ? 0 : add);
    const limitMin = d.limitMin || DEFAULT_LIMIT_MIN;

    if (!busy && sinceNag >= limitMin * 60) {
      nagMinutes = limitMin;
      await chrome.storage.local.set({ usage, sinceNag: 0, nagging: true });
    } else {
      await chrome.storage.local.set({ usage, sinceNag });
    }
  } catch (e) {
    /* orphaned after reload */
  }
}, 1000);

// ---------- start ----------
chrome.storage.local
  .get([
    "nagging",
    "snoozeUntil",
    "snoozeCount",
    "limitMin",
    "usage",
    "sinceNag",
  ])
  .then((s) => {
    state = {
      nagging: !!s.nagging,
      snoozeUntil: s.snoozeUntil || 0,
      snoozeCount: s.snoozeCount || 0,
    };
    nagMinutes = s.limitMin || DEFAULT_LIMIT_MIN;
    cache = {
      usage: s.usage || {},
      sinceNag: s.sinceNag || 0,
      limitMin: nagMinutes,
    };
    render();
  });
