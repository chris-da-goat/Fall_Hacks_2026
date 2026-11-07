// Get Up Clippy - content script (runs on YouTube + Instagram)
// Clippy patrols the edges of the screen, changes expressions at random,
// and gets angrier the more you hit "5 more min".

const DEFAULT_LIMIT_MIN = 20;
const SNOOZE_SEC = 300;     // length of "5 more min"
const FLUSH_EVERY = 5;      // seconds between storage writes
const EXERCISES = [
  "10 squats", "10 push-ups", "a 1-minute plank", "20 jumping jacks",
  "a quick walk around the room", "10 lunges per leg", "a big full-body stretch"
];

// Random expressions used while Clippy is just floating around
const EXPRESSIONS = ["happy", "wink", "surprised", "sleepy", "silly", "cool", "love"];
const EXPRESSION_EVERY_MS = 6000;
const FACE_LABEL = {
  happy: "Happy 😊", wink: "Winking 😉", surprised: "Surprised 😮", sleepy: "Sleepy 😴",
  silly: "Silly 🤪", cool: "Feeling cool 😎", love: "In love 😍",
  worried: "Worried 😟", angry: "Angry mom 😡"
};

// Patrol settings
const CLIP_W = 70, CLIP_H = 110;
const EDGE_MARGIN = 8;      // how close to the screen edge he hugs
const SPEED = 45;           // px per second along the edge

// ---------- shared state (kept in chrome.storage so all tabs agree) ----------
let state = { nagging: false, snoozeUntil: 0, snoozeCount: 0 };
let cheerUntil = 0;          // show a "nice job" bubble until this time
let nagMinutes = DEFAULT_LIMIT_MIN;
let curExercise = EXERCISES[0];
let expr = "happy";          // current random expression
let lastKey = "";
let sideSig = "";
let pos = { x: 0, y: 0 };
let pending = 0;
let panelOpen = false;       // is the info panel showing?
let cache = { usage: {}, sinceNag: 0, limitMin: DEFAULT_LIMIT_MIN }; // mirrors storage for the panel

function alive() { return !!(chrome.runtime && chrome.runtime.id); }

function setState(patch) {
  Object.assign(state, patch);
  chrome.storage.local.set(patch);
  render();
}

chrome.storage.onChanged.addListener((changes) => {
  for (const k of ["nagging", "snoozeUntil", "snoozeCount"]) {
    if (changes[k]) state[k] = changes[k].newValue ?? (k === "nagging" ? false : 0);
  }
  if (changes.usage) cache.usage = changes.usage.newValue || {};
  if (changes.sinceNag) cache.sinceNag = changes.sinceNag.newValue || 0;
  if (changes.limitMin) cache.limitMin = changes.limitMin.newValue || DEFAULT_LIMIT_MIN;
  render();
});

// Popup "Test Clippy" button
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TEST_CLIPPY") { nagMinutes = 20; setState({ nagging: true, snoozeUntil: 0 }); }
});

// ---------- mascot faces ----------
const EYES = `<circle cx="22" cy="30" r="6" fill="#fff" stroke="#333"/><circle cx="38" cy="30" r="6" fill="#fff" stroke="#333"/>`;
const BROWS = `<path d="M15 20 q7 -6 14 0 M31 20 q7 -6 14 0" stroke="#333" stroke-width="2" fill="none"/>`;
const SMILE = `<path d="M24 44 q6 6 12 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>`;

const FACES = {
  happy: `${EYES}<circle cx="23" cy="31" r="2.5"/><circle cx="39" cy="31" r="2.5"/>${BROWS}${SMILE}`,

  wink: `<path d="M16 31 q6 -5 12 0" stroke="#333" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="38" cy="30" r="6" fill="#fff" stroke="#333"/><circle cx="39" cy="31" r="2.5"/>
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

  silly: `${EYES}<circle cx="26" cy="31" r="2.5"/><circle cx="34" cy="31" r="2.5"/>${BROWS}
    <path d="M23 44 q7 7 14 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M28 47 q3 10 7 0 z" fill="#ff7a8a" stroke="#333" stroke-width="1"/>`,

  cool: `<rect x="11" y="25" width="17" height="11" rx="3" fill="#222"/><rect x="32" y="25" width="17" height="11" rx="3" fill="#222"/>
    <path d="M28 29 h4" stroke="#222" stroke-width="2"/>
    <path d="M24 45 q6 4 13 -2" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>`,

  love: `<text x="14" y="37" font-size="16" fill="#e0245e">♥</text><text x="31" y="37" font-size="16" fill="#e0245e">♥</text>
    <path d="M23 44 q7 8 14 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>`,

  // used for the nag after 1-3 snoozes
  worried: `${EYES}<circle cx="20" cy="32" r="2.5"/><circle cx="36" cy="32" r="2.5"/>
    <path d="M15 22 L29 17 M31 17 L45 22" stroke="#333" stroke-width="2" fill="none"/>
    <path d="M24 46 q3 -3 6 0 t6 0" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M54 16 q4 6 0 9 q-4 -3 0 -9z" fill="#5bc0eb"/>`,

  // after 4+ snoozes
  angry: `<circle cx="14" cy="40" r="4.5" fill="#ff6b6b" opacity=".6"/><circle cx="46" cy="40" r="4.5" fill="#ff6b6b" opacity=".6"/>
    <circle cx="22" cy="31" r="6" fill="#fff" stroke="#333"/><circle cx="38" cy="31" r="6" fill="#fff" stroke="#333"/>
    <circle cx="22" cy="32" r="2"/><circle cx="38" cy="32" r="2"/>
    <path d="M14 21 L29 27 M31 27 L46 21" stroke="#222" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <path d="M23 49 q7 -8 14 0" stroke="#333" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <text x="46" y="14" font-size="15">💢</text>`
};

function faceSvg(face) {
  const wire = `<path d="M45 20 V70 a18 18 0 0 1 -36 0 V25 a12 12 0 0 1 24 0 V68 a6 6 0 0 1 -12 0 V30"
        fill="none" stroke="#9aa0a6" stroke-width="6" stroke-linecap="round"/>`;
  const bun = face === "angry"
    ? `<circle cx="21" cy="9" r="8" fill="#8b5a2b"/><path d="M14 9 q7 -5 14 0" stroke="#5c3a1a" stroke-width="2" fill="none"/>` : "";
  return `<svg width="${CLIP_W}" height="${CLIP_H}" viewBox="0 0 70 110" xmlns="http://www.w3.org/2000/svg">${bun}${wire}${FACES[face]}</svg>`;
}

// ---------- patrol path: a loop around the edges of the viewport ----------
function bounds() {
  return {
    minX: EDGE_MARGIN, minY: EDGE_MARGIN,
    maxX: Math.max(EDGE_MARGIN + 1, innerWidth - CLIP_W - EDGE_MARGIN),
    maxY: Math.max(EDGE_MARGIN + 1, innerHeight - CLIP_H - EDGE_MARGIN)
  };
}
function perimeterLength() {
  const b = bounds();
  return 2 * ((b.maxX - b.minX) + (b.maxY - b.minY));
}
function perimeterPoint(u) { // u in [0,1): position along the rectangle's outline
  const b = bounds(), w = b.maxX - b.minX, h = b.maxY - b.minY;
  let s = (((u % 1) + 1) % 1) * 2 * (w + h);
  if (s < w) return { x: b.minX + s, y: b.minY };            // top edge, going right
  s -= w;
  if (s < h) return { x: b.maxX, y: b.minY + s };            // right edge, going down
  s -= h;
  if (s < w) return { x: b.maxX - s, y: b.maxY };            // bottom edge, going left
  s -= w;
  return { x: b.minX, y: b.maxY - s };                       // left edge, going up
}

let u = 0.5;          // start at the bottom-right corner
let dir = 1;          // walking direction around the loop
let pauseUntil = 0;

// ---------- DOM (built once) ----------
const host = document.createElement("div");
host.id = "get-up-clippy-host";
pos = perimeterPoint(u);
host.style.cssText = `position:fixed;left:0;top:0;width:${CLIP_W}px;height:${CLIP_H}px;
  z-index:2147483647;pointer-events:none;transform:translate(${pos.x}px,${pos.y}px);`;
const root = host.attachShadow({ mode: "open" }); // site CSS can't touch us
root.innerHTML = `
  <style>
    .clip { width:70px; height:110px; animation: bob 1.4s ease-in-out infinite; pointer-events:auto; cursor:pointer; }
    .clip.angry { animation: shake .35s linear infinite; }
    @keyframes bob { 50% { transform: translateY(-6px); } }
    @keyframes shake { 0%,100% { transform: translateX(0) rotate(0); }
      25% { transform: translateX(-2px) rotate(-3deg); } 75% { transform: translateX(2px) rotate(3deg); } }
    .side { position:absolute; top:10px; left:80px; pointer-events:auto; font-family:sans-serif; }
    .bubble { width:max-content; max-width:230px; background:#ffffe1; color:#000; border:1px solid #000;
      border-radius:10px; padding:10px 12px; font-size:14px; line-height:1.4; box-shadow:2px 2px 0 rgba(0,0,0,.3); }
    .bubble.angry { background:#ffd6d6; }
    .btns { margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; }
    button { cursor:pointer; border:1px solid #000; background:#eee; border-radius:4px; padding:4px 8px; font-size:13px; }
    button:hover { background:#ddd; }
    .pill { width:max-content; background:#ffffe1; color:#000; border:1px solid #000; border-radius:14px;
      padding:4px 10px; font-size:14px; font-weight:bold; white-space:nowrap; box-shadow:2px 2px 0 rgba(0,0,0,.3); }
    .pill.angry { background:#ffd6d6; }
    .panel { display:none; width:230px; box-sizing:border-box; background:#ffffe1; color:#000; border:1px solid #000;
      border-radius:10px; padding:10px 12px; font-size:13px; line-height:1.4; box-shadow:2px 2px 0 rgba(0,0,0,.3); }
    .ph { display:flex; justify-content:space-between; align-items:center; font-size:14px; }
    .ph button { padding:0 6px; }
    .row { display:flex; justify-content:space-between; gap:10px; margin-top:7px; }
    .row b { text-align:right; }
    .note { margin-top:8px; font-size:12px; color:#555; }
  </style>
  <div class="clip" id="clip"></div>
  <div class="side" id="side"></div>
  <div class="side panel" id="panel">
    <div class="ph"><b>📎 Clippy's report</b><button id="x">✕</button></div>
    <div class="row"><span>🕒 Scrolling today</span><b id="p-today"></b></div>
    <div class="row"><span>⏱ Since last break</span><b id="p-since"></b></div>
    <div class="row"><span>⏳ Snooze countdown</span><b id="p-cd"></b></div>
    <div class="row"><span>🙂 Clippy's mood</span><b id="p-mood"></b></div>
    <div class="note" id="p-note"></div>
  </div>`;
document.body.appendChild(host);
const clipEl = root.getElementById("clip");
const sideEl = root.getElementById("side");
const panelEl = root.getElementById("panel");

// Keep the bubble/pill/panel on whichever side has room and on-screen vertically
function updateSide(mode) {
  const el = panelOpen ? panelEl : sideEl;
  if (!panelOpen && mode === "idle") return;
  const w = panelOpen ? 240 : mode === "snooze" ? 100 : 250;
  const h = panelOpen ? 200 : mode === "nag" ? 170 : 50;
  const onRight = pos.x + 80 + w <= innerWidth;
  const anchorBottom = pos.y + 10 + h > innerHeight;
  const sig = `${panelOpen}${onRight}${anchorBottom}`;
  if (sig === sideSig) return;
  sideSig = sig;
  el.style.left = onRight ? "80px" : "auto";
  el.style.right = onRight ? "auto" : "80px";
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
function getMood() { // escalation level, used for the nag bubble
  const n = state.snoozeCount;
  return n > 3 ? "angry" : n >= 1 ? "worried" : "happy";
}
function getFace(mode) {
  if (mode === "nag") return getMood();             // face matches the message
  if (state.snoozeCount > 3) return "angry";        // angry mom stays until you exercise
  if (mode === "cheer") return "happy";
  return expr;                                      // otherwise: random expression
}

function nagText(mood) {
  const n = state.snoozeCount, ex = `<b>${curExercise}</b>`;
  if (mood === "angry")
    return { msg: `💢 ${n} snoozes?! Young person, put the phone down and do ${ex} RIGHT NOW!`,
             ok: "Fine, I'm doing it", later: "Just 5 more 😬" };
  if (mood === "worried")
    return { msg: `That's snooze #${n}... 😟<br>Please do ${ex}. Your body will thank you.`,
             ok: "OK, I did it", later: "5 more min..." };
  return { msg: `It looks like you've been scrolling for ${nagMinutes}+ minutes. 👀<br>Want to do ${ex}?`,
           ok: "I did it!", later: "5 more min" };
}

// ---------- info panel (click Clippy to open) ----------
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
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
  const mode = getMode(), face = getFace(mode), n = state.snoozeCount;
  const q = (id) => root.getElementById(id);

  const today = (cache.usage[new Date().toDateString()] || 0) + pending;
  q("p-today").textContent = fmtDur(today);

  if (mode === "nag") q("p-since").textContent = "limit reached";
  else if (mode === "snooze") q("p-since").textContent = "paused";
  else q("p-since").textContent = `${fmtDur(cache.sinceNag + pending)} / ${cache.limitMin} min`;

  if (mode === "nag") q("p-cd").textContent = "⏰ waiting for you!";
  else if (mode === "snooze") q("p-cd").textContent = fmtDur((state.snoozeUntil - Date.now()) / 1000).replace(/^(\d+)m (\d+)s$/, "$1:$2");
  else q("p-cd").textContent = "none";

  q("p-mood").textContent = FACE_LABEL[face];
  q("p-note").textContent = n > 3 ? `${n} snoozes in a row. She's had enough!`
    : n === 3 ? "3 snoozes in a row. One more and she loses it..."
    : n > 0 ? `${n} snooze${n > 1 ? "s" : ""} in a row.` : "No snoozes yet. Good job!";
}

clipEl.addEventListener("click", () => setPanel(!panelOpen));
root.getElementById("x").addEventListener("click", () => setPanel(false));
document.addEventListener("mousedown", (e) => {          // click anywhere else to close
  if (panelOpen && !e.composedPath().includes(host)) setPanel(false);
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panelOpen) setPanel(false); });

// ---------- render ----------
function render() {
  const mode = getMode(), face = getFace(mode), mood = getMood();
  const key = mode + face + state.snoozeCount;

  if (key !== lastKey) {              // only rebuild when something actually changed
    lastKey = key;
    sideSig = "";
    clipEl.className = "clip " + (face === "angry" ? "angry" : "");
    clipEl.innerHTML = faceSvg(face);

    if (mode === "nag") {
      curExercise = EXERCISES[Math.floor(Math.random() * EXERCISES.length)];
      const t = nagText(mood);
      sideEl.innerHTML = `<div class="bubble ${mood === "angry" ? "angry" : ""}">${t.msg}
        <div class="btns"><button id="ok">${t.ok}</button><button id="later">${t.later}</button></div></div>`;
      root.getElementById("ok").onclick = onDone;
      root.getElementById("later").onclick = onSnooze;
    } else if (mode === "snooze") {
      sideEl.innerHTML = `<div class="pill ${state.snoozeCount > 3 ? "angry" : ""}">⏳ <span id="cd"></span></div>`;
    } else if (mode === "cheer") {
      sideEl.innerHTML = `<div class="bubble">Nice! 🎉 Clippy is proud of you.</div>`;
    } else {
      sideEl.innerHTML = "";
    }
    updateSide(mode);
  }

  if (mode === "snooze") {            // live countdown
    const left = Math.max(0, Math.ceil((state.snoozeUntil - Date.now()) / 1000));
    const cd = root.getElementById("cd");
    if (cd) cd.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
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
  setState({ nagging: false, snoozeUntil: Date.now() + SNOOZE_SEC * 1000,
             snoozeCount: state.snoozeCount + 1 });
}

// ---------- animation loop: walk along the screen edges ----------
let lastFrame = performance.now();
function frame(now) {
  if (!alive()) { host.remove(); return; }       // extension was reloaded
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const mode = getMode();

  if (mode !== "nag" && !panelOpen && now >= pauseUntil) {     // hold still while the nag bubble is open
    u += (dir * SPEED * dt) / perimeterLength();
    if (Math.random() < dt / 12) dir *= -1;      // sometimes turn around
    if (Math.random() < dt / 10) pauseUntil = now + 1500 + Math.random() * 2500; // sometimes rest
  }

  pos = perimeterPoint(u);
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
  if (!alive()) { clearInterval(timer); host.remove(); return; }

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
    const d = await chrome.storage.local.get(["usage", "sinceNag", "limitMin", "nagging", "snoozeUntil"]);
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
  } catch (e) { /* orphaned after reload */ }
}, 1000);

// ---------- start ----------
chrome.storage.local.get(["nagging", "snoozeUntil", "snoozeCount", "limitMin", "usage", "sinceNag"]).then((s) => {
  state = { nagging: !!s.nagging, snoozeUntil: s.snoozeUntil || 0, snoozeCount: s.snoozeCount || 0 };
  nagMinutes = s.limitMin || DEFAULT_LIMIT_MIN;
  cache = { usage: s.usage || {}, sinceNag: s.sinceNag || 0, limitMin: nagMinutes };
  render();
});
