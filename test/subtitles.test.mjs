/**
 * SRT and VTT output.
 *
 * The failures worth catching here are the silent ones. A subtitle file with
 * the wrong millisecond separator, a missing WEBVTT header, or a timecode of
 * 00:00:59,1000 is not rejected with an error the user can act on -- the player
 * shows nothing, or shows the file as if it were empty. So the assertions are
 * about the exact bytes, not about the shape.
 *
 * Offline and instant.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toSRT, toVTT } from '../src/core/subtitles.js'

/**
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

test('SRT separates the milliseconds with a comma', () => {
  const srt = toSRT(sample())
  assert.match(srt, /00:00:00,000 --> 00:00:01,500/)
  assert.ok(!srt.includes('00:00:00.000'), 'a full stop here is the VTT form and SRT parsers reject it')
})

test('VTT separates the milliseconds with a full stop', () => {
  const vtt = toVTT(sample())
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.500/)
  assert.ok(!vtt.includes('00:00:00,000'), 'a comma here is the SRT form and browsers reject it')
})

test('VTT begins with the mandatory header', () => {
  // A VTT without this line is discarded by every browser, with no error the
  // user can see.
  assert.ok(toVTT(sample()).startsWith('WEBVTT\n'), 'the WEBVTT header is missing')
})

test('SRT numbers its cues from one, in order', () => {
  const srt = toSRT(sample())
  const numbers = srt.split('\r\n').filter((l) => /^\d+$/.test(l))
  assert.deepEqual(numbers, ['1', '2'])
})

test('SRT is the exact document, CRLF and all', () => {
  // Written out in full rather than probed, because the blank line between
  // cues and the line endings are as much a part of the format as the
  // timecodes, and a test that only greps would not notice losing them.
  const expected =
    '1\r\n' +
    '00:00:00,000 --> 00:00:01,500\r\n' +
    'the quick fox\r\n' +
    '\r\n' +
    '2\r\n' +
    '00:00:02,000 --> 00:00:03,300\r\n' +
    'jumped over it\r\n'

  assert.equal(toSRT(sample()), expected)
})

test('VTT is the exact document, LF and all', () => {
  const expected =
    'WEBVTT\n' +
    '\n' +
    '00:00:00.000 --> 00:00:01.500\n' +
    'the quick fox\n' +
    '\n' +
    '00:00:02.000 --> 00:00:03.300\n' +
    'jumped over it\n'

  assert.equal(toVTT(sample()), expected)
})

test('hours are always emitted, at two digits', () => {
  // Both formats permit dropping the hour field and enough players mis-parse
  // the short form that emitting it is free insurance.
  const t = make([[['late', 3661.5, 3662.25]]], 4000)
  assert.match(toSRT(t), /01:01:01,500 --> 01:01:02,250/)
})

test('a time that rounds up a whole second does not produce 1000 milliseconds', () => {
  // 59.9996 decomposed before rounding gives 00:00:59,1000, which is not a
  // time. Rounding to milliseconds first is what prevents it.
  const t = make([[['edge', 59.9996, 60.0004]]])
  assert.match(toSRT(t), /00:01:00,000 --> 00:01:00,000/)
})

test('a long cue wraps between words and never exceeds two lines', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve'
    .split(' ')
    .map((w, i) => /** @type {[string, number, number]} */ ([w, i, i + 1]))

  const lines = toVTT(make([words]))
    .split('\n')
    .filter((l) => l && l !== 'WEBVTT' && !l.includes('-->'))

  assert.equal(lines.length, 2, 'a third line covers faces; the fix for a long cue is splitting it, not growing it')
  assert.ok(lines[0].length <= 42, `first line is ${lines[0].length} characters`)
  assert.equal(lines.join(' '), words.map((w) => w[0]).join(' '), 'wrapping must not lose or add text')
})

test('a word longer than the limit is left whole rather than cut', () => {
  const t = make([[['https://example.com/a-very-long-path-indeed-truly', 0, 2]]])
  assert.match(toVTT(t), /https:\/\/example\.com\/a-very-long-path-indeed-truly/)
})

test('words keep whichever spacing convention they arrived with', () => {
  // whisper emits words with a leading space attached. Either form has to
  // produce the same line.
  const spaced = make([
    [
      [' the', 0, 0.4],
      [' quick', 0.4, 0.9],
    ],
  ])
  assert.ok(toVTT(spaced).includes('the quick\n'), 'leading spaces were not collapsed')
})

test('an empty segment produces no cue at all', () => {
  // It should not exist -- transcript.js preserves non-emptiness -- but an
  // empty cue is a parse error in some players and a flicker in the rest.
  const t = make([[['a', 0, 1]]])
  t.segments.push({ words: [] })
  t.segments.push({ words: [{ text: 'b', start: 2, end: 3 }] })

  const numbers = toSRT(t)
    .split('\r\n')
    .filter((l) => /^\d+$/.test(l))
  assert.deepEqual(numbers, ['1', '2'], 'the empty segment was numbered as a cue')
})

test('an empty transcript is still a valid file', () => {
  const t = make([])
  assert.equal(toSRT(t), '')
  assert.equal(toVTT(t), 'WEBVTT\n\n', 'a VTT with no cues still needs its header')
})
