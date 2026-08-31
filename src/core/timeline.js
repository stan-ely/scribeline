/**
 * The mapping between a moment in the audio and a horizontal position on the
 * waveform.
 *
 * Four lines of arithmetic in their own module for two reasons. It is the only
 * part of click-to-seek that can be tested without a browser -- everything else
 * in that interaction is a pointer event and a `currentTime` assignment. And it
 * is the pair of functions that has to stop agreeing with each other for a
 * click to land somewhere other than where it was aimed, so having exactly one
 * of each is worth a file.
 *
 * When zoom arrives it arrives here, as a visible window `[from, to)` these two
 * functions take instead of the whole duration. Putting the mapping inside the
 * canvas painter would mean the painter and the seek handler each grew their
 * own copy of it.
 *
 * Isomorphic: no DOM, no fs. Checked under both tsconfig projects.
 */

/**
 * Where on a `width`-pixel waveform the moment `time` falls.
 *
 * Clamped to `[0, width]`. A time past the end is what an `<audio>` element
 * reports for a moment after it has stopped, and the playhead belongs at the
 * end of the waveform then, not past it.
 *
 * A zero `width` or `duration` gives 0, never `NaN`. Both are the normal state
 * for the first frame or two: `width` is zero before layout has run, and
 * `duration` is zero until metadata loads. `NaN` here does not throw -- it
 * reaches the stylesheet as `left: NaNpx`, which browsers drop, leaving the
 * playhead pinned to the left edge and looking like a positioning bug several
 * layers away from this line.
 *
 * @param {number} time seconds
 * @param {number} width pixels
 * @param {number} duration seconds
 * @returns {number} pixels
 */
export function xAtTime(time, width, duration) {
  if (!(duration > 0) || !(width > 0)) return 0
  const clamped = Math.min(Math.max(time, 0), duration)
  return (clamped / duration) * width
}

/**
 * Which moment a click at `x` on a `width`-pixel waveform means.
 *
 * Clamped to `[0, duration]`, because a drag that leaves the element still has
 * to mean a time inside the recording -- and assigning an out-of-range
 * `currentTime` is silently ignored by some browsers and clamped by others,
 * which is a difference not worth inheriting.
 *
 * @param {number} x pixels, relative to the waveform's left edge
 * @param {number} width pixels
 * @param {number} duration seconds
 * @returns {number} seconds
 */
export function timeAtX(x, width, duration) {
  if (!(duration > 0) || !(width > 0)) return 0
  const clamped = Math.min(Math.max(x, 0), width)
  return (clamped / width) * duration
}

/**
 * The same position as a 0-1 fraction, which is what the playhead's CSS custom
 * property carries.
 *
 * A fraction rather than a pixel count because the element is positioned with
 * `calc(var(--playhead) * 100%)`: the browser then re-resolves the position
 * against the current width on every layout, so a window resize moves the
 * playhead correctly without any JavaScript running. Writing pixels would mean
 * a resize listener whose only job is to fix up a number that did not need to
 * be a number.
 *
 * @param {number} time seconds
 * @param {number} duration seconds
 * @returns {number} 0-1
 */
export function fractionAtTime(time, duration) {
  if (!(duration > 0)) return 0
  return Math.min(Math.max(time, 0), duration) / duration
}
