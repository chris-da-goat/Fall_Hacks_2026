// How angry Hackie is, and which of the user's clicks he may refuse.
//
// Calm or annoyed: the click just works. Angry: the AI arbiter decides (it reads the page and
// memory). Furious: refused outright (the AI only writes the angry speech).
// Pure module, covered by tests/anger.test.mjs.

export const ANGER = ['calm', 'annoyed', 'angry', 'furious'];

// Clicks Hackie can refuse when angry. "back" (going back to work) is never refused.
export const OVERRIDABLE = {
  snooze: 'a few more minutes',
  beg: 'more time during a lockdown',
  isWork: 'to mark this page as work ("It\'s for my task")',
  dismiss: 'to dismiss Hackie',
  exercise: 'credit for an exercise break ("I did it!")',
  resetMood: 'to reset Hackie\'s mood',
  break: 'a 15-minute break',
  pause: 'to pause tracking',
  restore: 'to reopen the tabs Hackie closed',
  demoLower: 'to lower the slack streak with the demo slider',
};

const EXERCISE_COOLDOWN_MS = 10 * 60e3;

/**
 * @param {object} s
 * @param {number} [s.snoozeCount]   Consecutive snoozes.
 * @param {number} [s.lockdownBegs]  Begs during lockdowns.
 * @param {number} [s.level]         Current warning level 0-3.
 * @param {string} [s.habit]         'none' | 'habit' | 'strong' for the current site.
 * @param {boolean} [s.overBudget]
 * @param {number} [s.lastEnforcedAt] When Hackie last closed tabs (ms).
 * @param {number} [s.closeAfterBegs]
 * @param {number} [s.now]
 * @returns {{level: number, label: string, reasons: string[]}}
 */
export function angerLevel({ snoozeCount = 0, lockdownBegs = 0, level = 0, habit = 'none', overBudget = false, lastEnforcedAt = 0, closeAfterBegs = 2, now = Date.now() } = {}) {
  const reasons = [];
  let anger = 0;
  const bump = (to, why) => {
    if (to > anger) anger = to;
    reasons.push(why);
  };
  if (snoozeCount >= 1) bump(1, `${snoozeCount} snooze${snoozeCount > 1 ? 's' : ''} in a row`);
  if (level >= 2) bump(1, level >= 3 ? 'reached lockdown' : 'reached the whip');
  if (snoozeCount >= 3) bump(2, 'kept snoozing');
  if (lockdownBegs >= 1) bump(2, `begged ${lockdownBegs} time${lockdownBegs > 1 ? 's' : ''} during lockdowns`);
  if (level >= 2 && (habit === 'strong' || overBudget)) bump(2, habit === 'strong' ? 'on a strong slacking habit site' : 'over the daily slack budget');
  if (lastEnforcedAt && now - lastEnforcedAt < 15 * 60e3) bump(2, 'just had to close your tabs');
  if (snoozeCount > 3) bump(3, 'snoozed more than 3 times');
  if (lockdownBegs >= Math.max(1, closeAfterBegs)) bump(3, 'begged too many times');
  return { level: anger, label: ANGER[anger], reasons };
}

/**
 * The rule-based verdict, used when Hackie is furious (always), and when angry with no AI
 * available. Returns {allow, needsAI}: needsAI means "angry, let the AI decide".
 * @param {string} action  A key of OVERRIDABLE.
 * @param {{level: number}} anger
 * @param {object} [ctx]   { lastExerciseAt, restoreLockedUntil, now, aiAvailable, enabled }
 */
export function policyVerdict(action, anger, { lastExerciseAt = 0, restoreLockedUntil = 0, now = Date.now(), aiAvailable = false, enabled = true } = {}) {
  if (!(action in OVERRIDABLE)) return { allow: true, needsAI: false };
  // The restore lock applies whatever the mood (unless overrides are turned off).
  if (action === 'restore' && enabled && restoreLockedUntil > now) return { allow: false, needsAI: false, rule: 'restore-locked' };
  if (!enabled || anger.level <= 1) return { allow: true, needsAI: false };
  if (action === 'exercise' && lastExerciseAt && now - lastExerciseAt < EXERCISE_COOLDOWN_MS) {
    return { allow: false, needsAI: false, rule: 'exercise-cooldown' };
  }
  if (anger.level >= 3) {
    // Furious: no snoozes, begs, breaks, pauses, resets, dismissals or "it's for my task".
    // A real exercise break is still allowed (once per cooldown).
    if (action === 'exercise') return { allow: true, needsAI: false };
    return { allow: false, needsAI: false, rule: 'furious' };
  }
  // Angry: the AI decides; without AI, refuse the easy escapes and allow the rest.
  if (aiAvailable) return { allow: null, needsAI: true };
  const refuse = ['snooze', 'beg', 'break', 'pause', 'resetMood', 'dismiss', 'demoLower'];
  return { allow: !refuse.includes(action), needsAI: false, rule: 'angry-no-ai' };
}

const DENIALS = {
  snooze: ['DENIED. No more snoozes, recruit. You had your chance.', 'Another snooze? ABSOLUTELY NOT. Eyes on the task!'],
  beg: ['BEGGING DENIED. The lockdown stays. Go work.', 'You can beg all day. The answer is NO.'],
  isWork: ["Nice try. That page has NOTHING to do with your task. Override REJECTED.", "'For my task'? I read the page. Denied."],
  dismiss: ["You don't get to wave me away. I'm staying right here.", 'Close me? HA. Not while you slack.'],
  exercise: ['You "exercised" minutes ago. I am not falling for that twice.', 'Suspiciously fast workout. Credit DENIED.'],
  resetMood: ["Reset MY mood? You don't get to reset my mood. Earn it.", 'Mood reset DENIED. I am staying furious until you work.'],
  break: ['A break? From WHAT? You have been on break all day. Denied.', 'No breaks for slackers. Back to work.'],
  pause: ['Pause tracking? So you can slack in secret? NOPE.', "Tracking stays on. I'm watching, recruit."],
  restore: ['Those tabs stay closed. Restore is locked. Go do your work.', 'I closed them for a reason. Restore DENIED for now.'],
  demoLower: ['Rolling back your slack streak? Cute. Denied.', 'Nice try with the slider. The streak stays.'],
};

export function denialLine(action, random = Math.random) {
  const pool = DENIALS[action] || ['DENIED.'];
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
