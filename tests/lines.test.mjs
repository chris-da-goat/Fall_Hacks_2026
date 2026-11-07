import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINES,
  LEVEL_NAME,
  pickLine,
  EXERCISES,
  pickExercise,
  snoozeMinutes,
  snoozeRemark,
  moodForSnoozes,
  CHEERS,
  pickCheer,
} from '../extension/lib/lines.js';

const VARS = { minutes: '6 minutes', site: 'YouTube', task: 'math' };
const PLACEHOLDER = /\{\w+\}/;

test('LEVEL_NAME uses the Hackie escalation names', () => {
  assert.deepEqual(LEVEL_NAME, { 0: 'Watching', 1: 'Nudge', 2: 'Whip', 3: 'Lockdown' });
});

test('every level has lines and pickLine fills every placeholder', () => {
  for (const level of [0, 1, 2, 3]) {
    const pool = LINES[level];
    assert.ok(pool.length > 0, `level ${level} has lines`);
    pool.forEach((_, i) => {
      const line = pickLine(level, VARS, () => i / pool.length);
      assert.ok(!PLACEHOLDER.test(line), `level ${level} line ${i}: ${line}`);
    });
  }
});

test('every level-2 line starts with *CRACK*', () => {
  for (const line of LINES[2]) assert.ok(line.startsWith('*CRACK*'), line);
});

test('level-3 lines do not repeat {minutes} or {site}', () => {
  for (const line of LINES[3]) {
    assert.ok(!line.includes('{minutes}'), line);
    assert.ok(!line.includes('{site}'), line);
  }
});

test('no line mentions the old tomato mascot', () => {
  const remarks = [1, 2, 3, 4, 5, 6, 7].map((n) => snoozeRemark(n, { exercise: 'x', snoozeMin: 2 }));
  const all = [...Object.values(LINES).flat(), ...Object.values(LEVEL_NAME), ...CHEERS, ...remarks];
  for (const line of all) {
    assert.doesNotMatch(line, /tomato/i);
    assert.doesNotMatch(line, /pomo/i);
  }
});

test('EXERCISES is the team list, and pickExercise picks from it', () => {
  assert.deepEqual(EXERCISES, [
    '10 squats',
    '10 push-ups',
    'a 1-minute plank',
    '20 jumping jacks',
    'a quick walk around the room',
    '10 lunges per leg',
    'a big full-body stretch',
  ]);
  assert.equal(pickExercise(() => 0), '10 squats');
  assert.equal(pickExercise(() => 0.9999), 'a big full-body stretch');
  for (let i = 0; i < 20; i++) assert.ok(EXERCISES.includes(pickExercise()));
});

test('snoozeMinutes shrinks 5 -> 3 -> 2 and stays at 2', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map((n) => snoozeMinutes(n, 5)), [5, 3, 2, 2, 2]);
  assert.deepEqual([0, 1, 2].map((n) => snoozeMinutes(n, 10)), [10, 6, 4]);
});

test('snoozeMinutes never drops below 1 minute and tolerates odd counts', () => {
  assert.deepEqual([0, 1, 2].map((n) => snoozeMinutes(n, 1)), [1, 1, 1]);
  assert.deepEqual([0, 1, 2].map((n) => snoozeMinutes(n, 2)), [2, 1, 1]);
  assert.equal(snoozeMinutes(-3, 5), 5);
  assert.equal(snoozeMinutes(undefined, 5), 5);
  assert.equal(snoozeMinutes(1), 3, 'base defaults to 5');
});

test('snoozeRemark is empty with no snoozes', () => {
  assert.equal(snoozeRemark(0, { exercise: '10 squats', snoozeMin: 5 }), '');
  assert.equal(snoozeRemark(0), '');
});

test('snoozeRemark worries for 1-3 snoozes and fills its placeholders', () => {
  assert.equal(
    snoozeRemark(1, { exercise: '10 squats', snoozeMin: 3 }),
    "That's snooze #1… Please do 10 squats. I'm getting stingy: only 3 min this time.",
  );
  for (const n of [1, 2, 3]) {
    const line = snoozeRemark(n, { exercise: '20 jumping jacks', snoozeMin: 2 });
    assert.ok(line.includes(`#${n}`), line);
    assert.ok(line.includes('20 jumping jacks'), line);
    assert.ok(line.includes('2 min'), line);
    assert.ok(!PLACEHOLDER.test(line), line);
  }
});

test('snoozeRemark turns into an angry parent after 3 snoozes', () => {
  const line = snoozeRemark(4, { exercise: '10 push-ups', snoozeMin: 2 });
  assert.equal(line, '4 snoozes?! Young person, put the phone down and do 10 push-ups RIGHT NOW!');
  for (const n of [5, 6, 7, 12]) {
    const l = snoozeRemark(n, { exercise: '10 lunges per leg', snoozeMin: 2 });
    assert.ok(l.startsWith(`${n} snoozes`), l);
    assert.ok(l.includes('10 lunges per leg'), l);
    assert.ok(!PLACEHOLDER.test(l), l);
  }
});

test('moodForSnoozes goes happy -> worried -> angry', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(moodForSnoozes), ['happy', 'worried', 'worried', 'worried', 'angry', 'angry']);
});

test('pickCheer picks one of the cheers', () => {
  assert.ok(CHEERS.length >= 3);
  assert.equal(pickCheer(() => 0), CHEERS[0]);
  assert.equal(pickCheer(() => 0.9999), CHEERS[CHEERS.length - 1]);
  assert.ok(CHEERS.includes(pickCheer()));
});

test('values that start a sentence are capitalized', async () => {
  const { fillLine } = await import('../extension/lib/lines.js');
  assert.equal(fillLine('Hackie has confiscated this tab. {task} is waiting.', { task: 'assignment' }), 'Hackie has confiscated this tab. Assignment is waiting.');
  assert.equal(fillLine('{task} first! Then {task}.', { task: 'math' }), 'Math first! Then math.');
  assert.equal(fillLine('Back to {task}, recruit.', { task: 'my essay' }), 'Back to my essay, recruit.');
});
