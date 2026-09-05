/**
 * The transcript document's behaviour.
 *
 * These are the operations the editor will call from a pointer handler, so the
 * cases that matter most are the degenerate ones: a drag that lands where it
 * started, a drag that runs past the end of a segment, a playhead sitting in
 * silence. Each of those has an obvious wrong answer -- throw, empty a segment,
 * highlight the nearest word -- and the assertion messages say which.
 *
 * Offline and instant. Nothing here touches the network, the DOM, or the disk.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  segmentStart,
  segmentEnd,
  totalWords,
  splitSegment,
  mergeSegments,
  moveBoundary,
  setWordText,
  insertWord,
  deleteWord,
  wordAt,
} from '../src/core/transcript.js'

/**
 * Build a transcript from a compact literal, so a test reads as the behaviour
 * it is checking rather than as data entry.
 *
 * Each segment is a list of `[text, start, end]` triples. Deliberately not
 * exported into a shared module: a fixture helper that grows features is a
 * second implementation of the thing under test.
 *
 * @param {[string, number, number][][]} segments
 * @param {number} [duration]
 * @returns {import('../src/core/transcript.js').Transcript}
 */
function make(segments, duration = 100) {
  return {
    duration,
    segments: segments.map((words) => ({
      words: words.map(([text, start, end]) => ({ text, start, end })),
    })),
  }
}

/** Two segments, three words each, with a half-second gap between them. */
const sample = () =>
  make([
    [
      ['the', 0, 0.4],
      ['quick', 0.4, 0.9],
      ['fox', 0.9, 1.5],
    ],
    [
      ['jumped', 2.0, 2.6],
      ['over', 2.6, 3.0],
      ['it', 3.0, 3.3],
    ],
  ])

test('a segment borrows its bounds from its first and last word', () => {
  const t = sample()
  assert.equal(segmentStart(t.segments[0]), 0)
  assert.equal(segmentEnd(t.segments[0]), 1.5)
  assert.equal(totalWords(t), 6)
})

test('an empty segment reports null bounds, not NaN or zero', () => {
  // NaN would propagate into a timecode; 0 is a plausible-looking lie that
  // sorts to the front of the document.
  const empty = { words: [] }
  assert.equal(segmentStart(empty), null, 'segmentStart must refuse rather than guess')
  assert.equal(segmentEnd(empty), null, 'segmentEnd must refuse rather than guess')
})

test('splitting divides a segment before the named word', () => {
  const t = splitSegment(sample(), 0, 1)

  assert.equal(t.segments.length, 3)
  assert.deepEqual(
    t.segments[0].words.map((w) => w.text),
    ['the'],
  )
  assert.deepEqual(
    t.segments[1].words.map((w) => w.text),
    ['quick', 'fox'],
  )
  assert.equal(segmentEnd(t.segments[0]), 0.4, 'the new bounds follow the words that moved')
  assert.equal(segmentStart(t.segments[1]), 0.4)
})

test('a split at either edge is a no-op, not an empty segment', () => {
  // The caller is a mouse. A drag that lands back where it started should be
  // inert, and an emptied segment would have no bounds to derive at all.
  const t = sample()
  assert.equal(splitSegment(t, 0, 0), t, 'a split before the first word changes nothing')
  assert.equal(splitSegment(t, 0, 3), t, 'a split after the last word changes nothing')
  assert.equal(splitSegment(t, 9, 1), t, 'a split in a segment that does not exist changes nothing')
})

test('merging joins a segment with the one after it', () => {
  const t = mergeSegments(sample(), 0)

  assert.equal(t.segments.length, 1)
  assert.equal(totalWords(t), 6)
  assert.equal(segmentStart(t.segments[0]), 0)
  assert.equal(segmentEnd(t.segments[0]), 3.3)
})

test('merging at the last index is a no-op', () => {
  const t = sample()
  assert.equal(mergeSegments(t, 1), t, 'there is no segment after the last one to merge with')
})

test('split then merge at the same place restores the document', () => {
  const before = sample()
  const after = mergeSegments(splitSegment(before, 0, 2), 0)
  assert.deepEqual(after, before, 'the round trip must be exact, not merely equivalent')
})

test('moving a boundary hands words across it without retiming them', () => {
  const t = moveBoundary(sample(), 0, -1)

  assert.deepEqual(
    t.segments[0].words.map((w) => w.text),
    ['the', 'quick'],
  )
  assert.deepEqual(
    t.segments[1].words.map((w) => w.text),
    ['fox', 'jumped', 'over', 'it'],
  )
  assert.equal(
    segmentStart(t.segments[1]),
    0.9,
    "the second segment now starts at the moved word's own start -- the timings did not change, the membership did",
  )
})

test('a boundary drag is clamped rather than emptying a segment', () => {
  const t = sample()

  const back = moveBoundary(t, 0, -50)
  assert.equal(back.segments[0].words.length, 1, 'at most all but one word may leave a segment')
  assert.equal(back.segments[1].words.length, 5)

  const forward = moveBoundary(t, 0, 50)
  assert.equal(forward.segments[0].words.length, 5)
  assert.equal(forward.segments[1].words.length, 1)
})

test('a zero or out-of-range boundary move changes nothing', () => {
  const t = sample()
  assert.equal(moveBoundary(t, 0, 0), t)
  assert.equal(moveBoundary(t, 1, 1), t, 'the last segment has no boundary after it')
})

test('editing a word changes its text and leaves its timings alone', () => {
  const t = setWordText(sample(), 1, 0, 'jumps')

  assert.equal(t.segments[1].words[0].text, 'jumps')
  assert.equal(t.segments[1].words[0].start, 2.0, 'the model timed this word; an edit to the spelling must not move it')
  assert.equal(t.segments[1].words[0].end, 2.6)
})

test('inserting a word in the middle takes the previous word\'s end as its timing', () => {
  const t = insertWord(sample(), 0, 1, 'very')

  assert.deepEqual(
    t.segments[0].words.map((w) => w.text),
    ['the', 'very', 'quick', 'fox'],
  )
  assert.equal(t.segments[0].words[1].start, 0.4, "the previous word's own end")
  assert.equal(t.segments[0].words[1].end, 0.4, 'zero-length: nothing timed it')
})

test('inserting at the front of a segment takes the next word\'s start as its timing', () => {
  const t = insertWord(sample(), 0, 0, 'well')

  assert.deepEqual(
    t.segments[0].words.map((w) => w.text),
    ['well', 'the', 'quick', 'fox'],
  )
  assert.equal(t.segments[0].words[0].start, 0, "the next word's own start")
  assert.equal(t.segments[0].words[0].end, 0)
})

test('inserting after the last word of a segment takes its end as its timing', () => {
  const t = insertWord(sample(), 0, 3, 'indeed')

  assert.deepEqual(
    t.segments[0].words.map((w) => w.text),
    ['the', 'quick', 'fox', 'indeed'],
  )
  assert.equal(t.segments[0].words[3].start, 1.5)
  assert.equal(t.segments[0].words[3].end, 1.5)
})

test('inserting empty text, or at an out-of-range position, is a no-op', () => {
  const t = sample()
  assert.equal(insertWord(t, 0, 1, ''), t, 'nothing was typed')
  assert.equal(insertWord(t, 0, -1, 'x'), t, 'before the start of the segment')
  assert.equal(insertWord(t, 0, 4, 'x'), t, 'past the end of the segment')
  assert.equal(insertWord(t, 9, 0, 'x'), t, 'a segment that does not exist')
})

test('deleting a word removes it and leaves the rest of the segment alone', () => {
  const t = deleteWord(sample(), 0, 1)

  assert.deepEqual(
    t.segments[0].words.map((w) => w.text),
    ['the', 'fox'],
  )
  assert.equal(t.segments.length, 2, 'the segment survives with its remaining words')
})

test('deleting a segment\'s only word removes the segment instead of emptying it', () => {
  const t = deleteWord(splitSegment(sample(), 0, 1), 0, 0)

  assert.deepEqual(
    t.segments.map((s) => s.words.map((w) => w.text)),
    [
      ['quick', 'fox'],
      ['jumped', 'over', 'it'],
    ],
    'the one-word segment is gone, not left empty',
  )
})

test('deleting at an out-of-range position is a no-op', () => {
  const t = sample()
  assert.equal(deleteWord(t, 0, 3), t, 'past the last word')
  assert.equal(deleteWord(t, 0, -1), t)
  assert.equal(deleteWord(t, 9, 0), t, 'a segment that does not exist')
})

test('no operation mutates the transcript it was given', () => {
  // Undo is a stack of the objects these functions already returned. That only
  // works if the earlier ones are still what they were.
  const t = sample()
  const snapshot = structuredClone(t)

  splitSegment(t, 0, 1)
  mergeSegments(t, 0)
  moveBoundary(t, 0, -1)
  setWordText(t, 0, 0, 'THE')
  insertWord(t, 0, 1, 'very')
  deleteWord(t, 0, 1)

  assert.deepEqual(t, snapshot, 'the input was modified in place by one of the operations')
})

test('wordAt finds the word being spoken', () => {
  const t = sample()

  assert.deepEqual(wordAt(t, 0), { segmentIndex: 0, wordIndex: 0 }, 'the very first instant')
  assert.deepEqual(wordAt(t, 0.5), { segmentIndex: 0, wordIndex: 1 })
  assert.deepEqual(wordAt(t, 3.2), { segmentIndex: 1, wordIndex: 2 }, 'the last word')
})

test('a time exactly on a word boundary belongs to the later word', () => {
  // The interval is half-open. A closed one would match both words that share
  // the number, and the answer would depend on the search order.
  assert.deepEqual(wordAt(sample(), 0.4), { segmentIndex: 0, wordIndex: 1 })
})

test('a playhead in silence matches no word', () => {
  // Most of a recording is the gaps. Returning the nearest word instead would
  // leave one highlighted through a pause.
  const t = sample()
  assert.equal(wordAt(t, 1.7), null, 'the gap between the two segments')
  assert.equal(wordAt(t, 50), null, 'past the last word but inside the audio')
  assert.equal(wordAt(t, -1), null, 'before the beginning')
})

test('wordAt refuses to guess when it meets an empty segment', () => {
  const t = make([[['a', 0, 1]]])
  t.segments.push({ words: [] })
  assert.equal(wordAt(t, 5), null, 'an empty segment has no side to recurse into')
})

test('wordAt is correct across a document too large to scan', () => {
  // The binary search is the point of the function -- it runs once an
  // animation frame -- so it is worth checking against something long enough
  // that an off-by-one in the descent would show.
  /** @type {[string, number, number][][]} */
  const segments = []
  for (let s = 0; s < 200; s++) {
    /** @type {[string, number, number][]} */
    const words = []
    for (let w = 0; w < 10; w++) {
      const start = s * 10 + w
      words.push([`w${s}_${w}`, start, start + 0.5])
    }
    segments.push(words)
  }
  const t = make(segments, 2000)

  for (let s = 0; s < 200; s += 37) {
    for (let w = 0; w < 10; w += 3) {
      const at = wordAt(t, s * 10 + w + 0.25)
      assert.deepEqual(at, { segmentIndex: s, wordIndex: w })
    }
  }

  assert.equal(wordAt(t, 0.75), null, 'the half-second gap after the first word')
})
