/**
 * Reducing a few million audio samples to the few hundred numbers a waveform is
 * actually drawn from.
 *
 * A minute of 44.1 kHz stereo is about five million floats and a waveform is
 * about a thousand pixels wide, so the drawing code never sees a sample -- it
 * sees one vertical extent per column, computed here. Keeping that reduction in
 * core rather than inside the canvas painter is what makes it testable: it is
 * arithmetic over a Float32Array, it runs offline in milliseconds, and it is
 * where the bugs that matter live. What is left in src/web/waveform.js is the
 * part that puts pixels on a screen.
 *
 * Isomorphic: no DOM, no fs. Checked under both tsconfig projects.
 */

/**
 * One vertical extent per column: the lowest and highest sample each column
 * covers.
 *
 * MIN AND MAX, not a single magnitude per column. A waveform drawn from one
 * number per column is symmetric by construction -- it mirrors whatever it is
 * given about the axis, so an asymmetric signal, a DC offset, or a clipped
 * positive half all draw as the same tidy blob. Keeping both bounds costs one
 * extra array and draws the recording that exists rather than a smoothed
 * portrait of it.
 *
 * Two parallel Float32Arrays rather than an array of `{min, max}` objects: this
 * is one allocation per file instead of one per column, and the drawing loop
 * reads it straight through.
 *
 * @typedef {{ min: Float32Array, max: Float32Array }} Peaks
 */

/**
 * Average several channels down to one.
 *
 * AVERAGED, not channel 0. A two-microphone interview is very commonly recorded
 * with one speaker hard-panned to each channel, and taking the first channel
 * would draw a waveform in which one of the two people is silent -- which looks
 * like a correct waveform of a quiet recording rather than like a bug.
 *
 * Returns the single channel unchanged when there is only one, because the
 * common case is mono and copying it would be a megabyte of memcpy to produce
 * an identical array.
 *
 * @param {readonly Float32Array[]} channels
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]

  // The shortest channel, not the first: channels of a decoded file are always
  // the same length, but this function is also fed hand-built arrays by the
  // tests and by anything that assembles audio itself, and reading past the end
  // of a Float32Array yields undefined, which turns the whole sum into NaN.
  let length = channels[0].length
  for (const channel of channels) length = Math.min(length, channel.length)

  const mono = new Float32Array(length)
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i]
  }
  const scale = 1 / channels.length
  for (let i = 0; i < length; i++) mono[i] *= scale
  return mono
}

/**
 * Reduce samples to `bucketCount` min/max pairs, one per column of the
 * waveform.
 *
 * Bucket edges are computed as `Math.floor(i * length / bucketCount)` rather
 * than by stepping a rounded stride. A stride of `Math.floor(length /
 * bucketCount)` accumulates its rounding error across every bucket: at an hour
 * and 44.1 kHz that is tens of thousands of samples left over, and the waveform
 * draws as a recording that ends before the audio does -- with the playhead
 * then running off the end of a picture that looked right.
 *
 * A bucket that covers no samples yields `0, 0`. It happens whenever
 * `bucketCount` exceeds the sample count, which is a real case: a very short
 * clip in a wide window. The natural min/max reduction over an empty range
 * returns `+Infinity` and `-Infinity`, and a column drawn from those is a
 * full-height bar -- so short files would render as a solid block.
 *
 * @param {Float32Array} samples
 * @param {number} bucketCount
 * @returns {Peaks}
 */
export function computePeaks(samples, bucketCount) {
  const count = Math.max(0, Math.floor(bucketCount))
  const min = new Float32Array(count)
  const max = new Float32Array(count)
  if (count === 0 || samples.length === 0) return { min, max }

  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * samples.length) / count)
    const end = Math.floor(((i + 1) * samples.length) / count)

    // Seeded from the first sample rather than from ±Infinity, so an empty
    // bucket keeps the zeroes the arrays were allocated with.
    if (start >= end) continue

    let lo = samples[start]
    let hi = samples[start]
    for (let j = start + 1; j < end; j++) {
      const sample = samples[j]
      if (sample < lo) lo = sample
      else if (sample > hi) hi = sample
    }
    min[i] = lo
    max[i] = hi
  }

  return { min, max }
}
