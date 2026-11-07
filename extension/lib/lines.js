// What Hackie, the FH26 robot, says. {site}, {minutes}, {task} are filled in by fillLine().
// Snooze remarks use {count}, {exercise} and {snoozeMin} instead.

export const LINES = {
  // Level 0: user clicked the timer chip before any nudge.
  0: [
    "Sensors on. {minutes} on {site} logged so far.",
    "Just counting clock cycles. {minutes} on {site}. No alarms. Yet.",
    "Beep. {minutes} on {site}. I'm watching, recruit.",
  ],
  // Level 1: gentle nudge.
  1: [
    "It looks like you're watching {site}. Would you like help rebooting into {task}?",
    "Beep boop. {minutes} on {site}. {task} won't compile itself.",
    "Psst. Remember {task}? It's still in my memory banks.",
    "Fun fact: {site} will still be online after you finish {task}.",
    "{minutes} of {site}. I'm not mad. My circuits just expected more.",
    "Low-priority alert: {site} detected. Please return to {task}.",
  ],
  // Level 2: whip crack. Every line must start with *CRACK* (the UI turns it into a label).
  2: [
    "*CRACK* {minutes} on {site}! Back to {task}, recruit!",
    "*CRACK* I wasn't soldered together to watch you scroll {site} all day.",
    "*CRACK* ERROR 404: focus not found. Drop {site} and get back to {task}!",
    "*CRACK* Every minute on {site} drains my battery. Back to {task}. Move it!",
    "*CRACK* That's {minutes}. Firmware update installed: you now do {task}. GO!",
  ],
  // Level 3: block screen. The headline already says "{minutes} on {site}", so don't repeat it.
  3: [
    'ENOUGH. This tab is in lockdown. Get back to {task}.',
    'Hackie has confiscated this tab. {task} is waiting, and so am I.',
    'SYSTEM OVERRIDE. Fun has been disabled. Reboot into {task}, recruit.',
    "I'm not angry. I'm running a disappointment.exe. Back to {task}.",
  ],
};

export const LEVEL_NAME = { 0: 'Watching', 1: 'Nudge', 2: 'Whip', 3: 'Lockdown' };

export function fillLine(template, vars) {
  const filled = template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  // A value that starts a sentence ("{task} is waiting", "{exercise}, NOW") gets a capital letter.
  return filled.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_, before, ch) => before + ch.toUpperCase());
}

export function pickLine(level, vars, random = Math.random) {
  const pool = LINES[level] || LINES[1];
  return fillLine(pool[Math.floor(random() * pool.length)], vars);
}

// ---------------------------------------------------------------------------
// Exercise breaks and snoozes (from the team's version of Hackie).

export const EXERCISES = [
  '10 squats',
  '10 push-ups',
  'a 1-minute plank',
  '20 jumping jacks',
  'a quick walk around the room',
  '10 lunges per leg',
  'a big full-body stretch',
];

function pickFrom(pool, random) {
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

export function pickExercise(random = Math.random) {
  return pickFrom(EXERCISES, random);
}

function snoozeIndex(snoozeCount) {
  const n = Math.floor(Number(snoozeCount));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Each snooze buys less time: with baseMin 5 that's 5, 3, then 2 minutes from the third snooze on.
export function snoozeMinutes(snoozeCount, baseMin = 5) {
  const steps = [baseMin, Math.max(1, Math.round(baseMin * 0.6)), Math.max(1, Math.round(baseMin * 0.4))];
  return steps[Math.min(snoozeIndex(snoozeCount), 2)];
}

// 1-3 snoozes: worried parent. More than 3: angry mom.
const SNOOZE_WORRIED = [
  "That's snooze #{count}… Please do {exercise}. I'm getting stingy: only {snoozeMin} min this time.",
  'Snooze #{count}? My worry sensors are beeping. Do {exercise} first, then you get {snoozeMin} min.',
  "Snooze #{count}. I'm not mad, my battery is just low on patience. {exercise}, please. Only {snoozeMin} min.",
];
const SNOOZE_ANGRY = [
  '{count} snoozes?! Young person, put the phone down and do {exercise} RIGHT NOW!',
  "{count} snoozes! I didn't reboot all night for this. {exercise}, NOW. {snoozeMin} min, not a second more!",
  '{count} snoozes?! Error: patience.dll not found. Put the phone down and do {exercise}. NOW!',
];

export function snoozeRemark(snoozeCount, vars = {}) {
  const count = snoozeIndex(snoozeCount);
  if (count === 0) return '';
  const template = count <= 3 ? SNOOZE_WORRIED[(count - 1) % SNOOZE_WORRIED.length] : SNOOZE_ANGRY[(count - 4) % SNOOZE_ANGRY.length];
  return fillLine(template, { ...vars, count });
}

export function moodForSnoozes(snoozeCount) {
  const count = snoozeIndex(snoozeCount);
  if (count === 0) return 'happy';
  return count <= 3 ? 'worried' : 'angry';
}

// After an exercise or going back to work.
export const CHEERS = [
  'Nice! Hackie is proud of you.',
  'Battery recharged. Great work, recruit!',
  "Beep boop! That's what I like to see.",
  'Systems nominal. Back in the zone!',
  'Logged as a win. My circuits are glowing.',
];

export function pickCheer(random = Math.random) {
  return pickFrom(CHEERS, random);
}

// ---------------------------------------------------------------------------
// Escapes that don't work: leaving and coming back during a lockdown, and fake comebacks
// ("Back to work", then straight back to slacking). {site}, {task}, {away} are filled in.

export const LOCKDOWN_STAYS = [
  "Still in lockdown. Leaving and coming back doesn't reset me, recruit. {task} first.",
  'Nice try. The lockdown follows you to every slacking tab until you actually work on {task}.',
  "Refreshing won't save you. The lockdown stays until you do some real work on {task}.",
  'New tab, same lockdown. A few minutes of real work on {task} and I unlock.',
];

export const FAKE_COMEBACK = [
  'You clicked "Back to work" and came RIGHT back to {site}? I saw that.',
  "Back to work for {away}? That's not work, that's a lap. Get back to {task}!",
  'FAKE COMEBACK DETECTED. Real work on {task} first, THEN we talk.',
  "You promised me {task}. {away} later you're on {site} again. Not cool, recruit.",
];

export function lockdownStaysLine(vars, random = Math.random) {
  return fillLine(LOCKDOWN_STAYS[Math.floor(random() * LOCKDOWN_STAYS.length)], vars);
}

export function fakeComebackLine(vars, random = Math.random) {
  return fillLine(FAKE_COMEBACK[Math.floor(random() * FAKE_COMEBACK.length)], vars);
}

// Zero-slack mode lockdowns. {site}, {task} are filled in.
export const ZERO_SLACK = [
  "Zero-slack mode. {site} counts as slacking, so it's locked. {task} is open. Think I'm wrong? Tell me below.",
  'Zero slack means zero slack. This page is locked and {task} is waiting in the next tab.',
  "Nope. Zero-slack mode is on and this is slacking. Back to {task}, or convince me below that it's work.",
];

export function zeroSlackLine(vars, random = Math.random) {
  return fillLine(ZERO_SLACK[Math.floor(random() * ZERO_SLACK.length)], vars);
}
