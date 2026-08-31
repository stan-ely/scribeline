/**
 * Time to pixels and back.
 *
 * Small enough to read at a glance and worth testing anyway: these two
 * functions disagreeing is a click landing somewhere other than where it was
 * aimed, and the degenerate cases below are the normal state of the page for
 * the first frame or two after a file is opened.
 *
 * Offline and instant.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { xAtTime, timeAtX, fractionAtTime } from '../src/core/timeline.js'

test('a time maps to its proportional position', () => {
  assert.equal(xAtTime(0, 800, 60), 0)
  assert.equal(xAtTime(30, 800, 60), 400)
  assert.equal(xAtTime(60, 800, 60), 800)
})

test('a click maps back to the time it was aimed at', () => {
  for (const time of [0, 0.5, 12.25, 59, 60]) {
    const back = timeAtX(xAtTime(time, 1000, 60), 1000, 60)
    assert.ok(Math.abs(back - time) < 1e-9, `${time}s round-tripped to ${back}s`)
  }
})

test('a time past the end sits at the end, not past it', () => {
  // An <audio> element reports a currentTime fractionally past duration once
  // it has stopped, and the playhead belongs at the right edge then.
  assert.equal(xAtTime(61, 800, 60), 800)
  assert.equal(xAtTime(-1, 800, 60), 0)
})

test('a drag that leaves the element still means a time inside the recording', () => {
  // Out-of-range currentTime is silently ignored by some browsers and clamped
  // by others; clamping here means the behaviour is ours rather than inherited.
  assert.equal(timeAtX(-40, 800, 60), 0)
  assert.equal(timeAtX(9000, 800, 60), 60)
})

test('zero width or duration gives zero, never NaN', () => {
  // Both are the ordinary state before layout has run and before metadata has
  // loaded. NaN does not throw here -- it reaches the stylesheet as
  // `left: NaNpx`, which the browser drops, leaving the playhead pinned left
  // and looking like a positioning bug several layers from the division.
  for (const value of [xAtTime(5, 0, 60), xAtTime(5, 800, 0), timeAtX(5, 0, 60), timeAtX(5, 800, 0)]) {
    assert.equal(value, 0)
  }

  assert.equal(fractionAtTime(5, 0), 0)
  assert.ok(Number.isFinite(fractionAtTime(5, NaN)), 'a NaN duration produced a NaN fraction')
})

test('the playhead fraction stays within 0 and 1', () => {
  assert.equal(fractionAtTime(0, 60), 0)
  assert.equal(fractionAtTime(15, 60), 0.25)
  assert.equal(fractionAtTime(60, 60), 1)
  assert.equal(fractionAtTime(99, 60), 1, 'a fraction above 1 puts the playhead outside the waveform')
})
