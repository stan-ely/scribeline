/**
 * Sample reduction.
 *
 * The failures worth catching here are the ones that still draw a picture. A
 * waveform computed with a rounded stride, or one that mixes a stereo pair by
 * dropping a channel, does not error -- it renders a plausible-looking
 * recording that is not the one in the file. So the assertions are about where
 * known signal ends up, not about whether an array came back.
 *
 * Offline and instant.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mixToMono, computePeaks } from '../src/core/peaks.js'

/**
 * @param {number} length
 * @param {(i: number) => number} fn
 * @returns {Float32Array}
 */
function samples(length, fn) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = fn(i)
  return out
}

test('a sine reduces to symmetric columns', () => {
  // 100 cycles over 10000 samples, so every one of 100 columns covers a whole
  // cycle and should reach both extremes.
  const sine = samples(10_000, (i) => Math.sin((i / 100) * 2 * Math.PI))
  const { min, max } = computePeaks(sine, 100)

  for (let i = 0; i < 100; i++) {
    assert.ok(max[i] > 0.99, `column ${i} peaked at ${max[i]}, not near +1`)
    assert.ok(min[i] < -0.99, `column ${i} troughed at ${min[i]}, not near -1`)
  }
})

test('an offset signal keeps its offset instead of being centred', () => {
  // The whole reason both bounds are kept. A single-magnitude reduction would
  // draw this as a symmetric band about zero.
  const offset = samples(1000, () => 0.5)
  const { min, max } = computePeaks(offset, 10)

  assert.ok(
    Array.from(min).every((v) => Math.abs(v - 0.5) < 1e-6),
    'the lower bound was not 0.5, so the offset was averaged away',
  )
  assert.ok(Array.from(max).every((v) => Math.abs(v - 0.5) < 1e-6))
})

test('silence draws as silence', () => {
  const { min, max } = computePeaks(new Float32Array(1000), 20)
  assert.ok(Array.from(min).every((v) => v === 0))
  assert.ok(Array.from(max).every((v) => v === 0))
})

test('the last column reaches the last sample', () => {
  // A stride computed by integer division loses the tail, and the loss is
  // invisible: the waveform simply ends early, in a picture that has no
  // reference to compare against. Signal in the final sample only is the
  // sharpest way to ask.
  const tail = samples(44_100 * 60, (i) => (i === 44_100 * 60 - 1 ? 1 : 0))
  const { max } = computePeaks(tail, 1000)

  assert.equal(max[999], 1, 'the final sample never landed in a column')
  assert.equal(max[998], 0, 'it landed in the wrong column')
})

test('an empty column is flat, not full height', () => {
  // More columns than samples happens with a short clip in a wide window. A
  // min/max reduction over nothing returns +/-Infinity, and a column drawn from
  // those is a full-height bar -- so this renders as a solid block rather than
  // as a two-second sound.
  // Five samples over twenty columns: each sample lands in one column and the
  // three between them cover nothing, so the empty ones are interleaved rather
  // than trailing.
  const { min, max } = computePeaks(samples(5, () => 1), 20)

  assert.ok(
    Array.from(max).every(Number.isFinite),
    'an empty column produced a non-finite bound',
  )
  assert.ok(Array.from(min).every(Number.isFinite))
  assert.equal(max[0], 0, 'a column covering no samples was not flat')
  assert.equal(max[3], 1, 'the column that does cover a sample lost it')
})

test('degenerate inputs return empty rather than throwing', () => {
  assert.equal(computePeaks(samples(100, () => 1), 0).min.length, 0)
  assert.equal(computePeaks(samples(100, () => 1), -5).min.length, 0)
  assert.equal(computePeaks(new Float32Array(0), 10).min.length, 10)
})

test('mixToMono keeps both speakers of a hard-panned pair', () => {
  // One speaker per channel is how a two-microphone interview is commonly
  // recorded. Taking channel 0 would draw a waveform in which one of the two
  // people never says anything, which looks like a quiet recording rather than
  // like a bug.
  const left = samples(8, (i) => (i < 4 ? 1 : 0))
  const right = samples(8, (i) => (i < 4 ? 0 : 1))
  const mono = mixToMono([left, right])

  assert.deepEqual(Array.from(mono), [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
})

test('mixToMono returns a single channel as-is', () => {
  const only = samples(4, (i) => i / 4)
  assert.equal(mixToMono([only]), only, 'a mono file was copied for no reason')
})

test('mixToMono of no channels is empty, not a crash', () => {
  assert.equal(mixToMono([]).length, 0)
})

test('mixToMono stops at the shortest channel', () => {
  // Decoded files always have equal channels; hand-assembled audio does not,
  // and reading past a Float32Array gives undefined, which turns the running
  // sum into NaN for every remaining sample.
  const mono = mixToMono([samples(6, () => 1), samples(3, () => 1)])

  assert.equal(mono.length, 3)
  assert.ok(Array.from(mono).every(Number.isFinite), 'the short channel produced NaN')
})
