import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angerLevel, policyVerdict, denialLine, OVERRIDABLE, ANGER } from '../extension/lib/anger.js';

const NOW = 1_800_000_000_000;

test('calm by default, annoyed after a snooze or at the whip', () => {
  assert.equal(angerLevel({ now: NOW }).level, 0);
  assert.equal(angerLevel({ now: NOW }).label, 'calm');
  assert.equal(angerLevel({ snoozeCount: 1, now: NOW }).level, 1);
  assert.equal(angerLevel({ level: 2, now: NOW }).level, 1);
  assert.match(angerLevel({ level: 3, now: NOW }).reasons.join(), /lockdown/);
});

test('angry: three snoozes, one beg, a strong habit at the whip, over budget, or tabs just closed', () => {
  assert.equal(angerLevel({ snoozeCount: 3, now: NOW }).level, 2);
  assert.equal(angerLevel({ lockdownBegs: 1, now: NOW }).level, 2);
  assert.equal(angerLevel({ level: 2, habit: 'strong', now: NOW }).level, 2);
  assert.equal(angerLevel({ level: 2, overBudget: true, now: NOW }).level, 2);
  assert.equal(angerLevel({ level: 1, habit: 'strong', now: NOW }).level, 0, 'a habit alone is not enough below the whip');
  assert.equal(angerLevel({ lastEnforcedAt: NOW - 5 * 60e3, now: NOW }).level, 2);
  assert.equal(angerLevel({ lastEnforcedAt: NOW - 20 * 60e3, now: NOW }).level, 0, 'calms down 15 minutes after closing tabs');
});

test('furious: more than three snoozes, or begging as often as it takes to get tabs closed', () => {
  assert.equal(angerLevel({ snoozeCount: 4, now: NOW }).level, 3);
  assert.equal(angerLevel({ lockdownBegs: 2, closeAfterBegs: 2, now: NOW }).level, 3);
  assert.equal(angerLevel({ lockdownBegs: 2, closeAfterBegs: 3, now: NOW }).level, 2);
  const f = angerLevel({ snoozeCount: 5, lockdownBegs: 2, now: NOW });
  assert.equal(f.label, 'furious');
  assert.ok(f.reasons.length >= 3, f.reasons.join());
});

test('labels line up with levels', () => {
  assert.deepEqual(ANGER, ['calm', 'annoyed', 'angry', 'furious']);
});

const calm = { level: 0 };
const annoyed = { level: 1 };
const angry = { level: 2 };
const furious = { level: 3 };

test('calm or annoyed: every click goes through', () => {
  for (const action of Object.keys(OVERRIDABLE)) {
    if (action === 'restore') continue;
    assert.equal(policyVerdict(action, calm, { now: NOW }).allow, true, action);
    assert.equal(policyVerdict(action, annoyed, { now: NOW, aiAvailable: true }).allow, true, action);
  }
});

test('going back to work (or anything unknown) is never refused', () => {
  assert.deepEqual(policyVerdict('back', furious, { now: NOW }), { allow: true, needsAI: false });
  assert.equal(policyVerdict('somethingElse', furious, { now: NOW }).allow, true);
});

test('angry with AI: the arbiter decides', () => {
  for (const action of ['snooze', 'beg', 'isWork', 'dismiss', 'exercise', 'break', 'pause', 'resetMood', 'demoLower']) {
    const v = policyVerdict(action, angry, { now: NOW, aiAvailable: true });
    assert.equal(v.needsAI, true, action);
    assert.equal(v.allow, null, action);
  }
});

test('angry without AI: easy escapes refused, the rest allowed', () => {
  for (const action of ['snooze', 'beg', 'break', 'pause', 'resetMood', 'dismiss', 'demoLower']) {
    assert.equal(policyVerdict(action, angry, { now: NOW }).allow, false, action);
  }
  assert.equal(policyVerdict('isWork', angry, { now: NOW }).allow, true);
  assert.equal(policyVerdict('exercise', angry, { now: NOW }).allow, true);
});

test('furious: refused outright, the AI only writes the speech; a real exercise still counts', () => {
  for (const action of ['snooze', 'beg', 'isWork', 'dismiss', 'break', 'pause', 'resetMood', 'demoLower']) {
    const v = policyVerdict(action, furious, { now: NOW, aiAvailable: true });
    assert.equal(v.allow, false, action);
    assert.equal(v.needsAI, false, action);
    assert.equal(v.rule, 'furious');
  }
  assert.equal(policyVerdict('exercise', furious, { now: NOW, aiAvailable: true }).allow, true);
});

test('exercise cooldown: no second "I did it!" within 10 minutes when angry', () => {
  const v = policyVerdict('exercise', furious, { now: NOW, lastExerciseAt: NOW - 3 * 60e3 });
  assert.equal(v.allow, false);
  assert.equal(v.rule, 'exercise-cooldown');
  assert.equal(policyVerdict('exercise', angry, { now: NOW, lastExerciseAt: NOW - 3 * 60e3, aiAvailable: true }).allow, false);
  assert.equal(policyVerdict('exercise', furious, { now: NOW, lastExerciseAt: NOW - 11 * 60e3 }).allow, true);
  assert.equal(policyVerdict('exercise', calm, { now: NOW, lastExerciseAt: NOW - 60e3 }).allow, true, 'calm Hackie does not count');
});

test('restore lock applies whatever the mood, until it expires', () => {
  const locked = policyVerdict('restore', calm, { now: NOW, restoreLockedUntil: NOW + 60e3 });
  assert.equal(locked.allow, false);
  assert.equal(locked.rule, 'restore-locked');
  assert.equal(policyVerdict('restore', calm, { now: NOW, restoreLockedUntil: NOW - 1 }).allow, true);
});

test('overrides turned off: nothing is refused, not even restore', () => {
  for (const action of Object.keys(OVERRIDABLE)) {
    assert.equal(policyVerdict(action, furious, { now: NOW, enabled: false, restoreLockedUntil: NOW + 60e3 }).allow, true, action);
  }
});

test('denial lines exist for every refusable click', () => {
  for (const action of Object.keys(OVERRIDABLE)) {
    const line = denialLine(action, () => 0.99);
    assert.ok(line.length > 10, action);
    assert.equal(denialLine(action, () => 0), denialLine(action, () => 0));
  }
  assert.equal(denialLine('nope'), 'DENIED.');
});
