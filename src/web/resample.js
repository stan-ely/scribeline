/**
 * Getting decoded audio into the one format whisper.cpp accepts.
 *
 * Whisper is trained on 16 kHz mono and the C API takes nothing else -- there
 * is no sample rate parameter to whisper_full, so audio at any other rate is
 * not rejected, it is transcribed as though it were 16 kHz. A 48 kHz recording
 * handed over unconverted comes back as a third of a transcript at three times
 * the speed, with timings to match. The failure looks like a bad model.
 *
 * Browser-only. Checked under tsconfig.json alone.
 */

import { mixToMono } from '../core/peaks.js'

/** What whisper.cpp requires, and the only rate it can be told about. */
export const WHISPER_SAMPLE_RATE = 16000

/**
 * An AudioContext that decodes straight to 16 kHz.
 *
 * `decodeAudioData` resamples to its context's rate, so asking for a 16 kHz
 * context makes the browser's own decoder do the conversion -- which is both
 * faster and better than anything worth writing here.
 *
 * IT ALSO DECIDES HOW MUCH MEMORY AN HOUR OF AUDIO COSTS. The same recording
 * decoded at the output device's 48 kHz in stereo is six times the samples, and
 * this is a page people open hour-long files in. The waveform does not care:
 * peaks are computed per pixel column, and no display has enough columns for
 * the difference to be visible.
 *
 * Some browsers refuse a context outside their output device's supported range,
 * which is why this can return one at the default rate instead -- callers must
 * handle both, and `toWhisperSamples` does.
 *
 * @returns {AudioContext}
 */
export function createDecoderContext() {
  try {
    return new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE })
  } catch {
    return new AudioContext()
  }
}

/**
 * A decoded recording as the mono 16 kHz samples whisper wants.
 *
 * Returns the samples directly when the buffer is already at the right rate,
 * which is the normal path: `decodeAudioFile` decodes into a 16 kHz context, so
 * the resample below runs only on browsers that refused one.
 *
 * @param {AudioBuffer} buffer
 * @returns {Promise<Float32Array>}
 */
export async function toWhisperSamples(buffer) {
  const source = buffer.sampleRate === WHISPER_SAMPLE_RATE ? buffer : await resample(buffer)

  const channels = []
  for (let c = 0; c < source.numberOfChannels; c++) channels.push(source.getChannelData(c))
  // Averaged, not channel 0 -- a two-microphone interview is commonly recorded
  // with one speaker per channel, and transcribing the first would silently
  // drop one of the two people. Shared with the waveform, which needs the same
  // mixdown for the same reason.
  const mono = mixToMono(channels)

  // A COPY WHEN THE MIX IS NOT ONE. `mixToMono` returns the single channel
  // unchanged for mono audio -- deliberately, to avoid a pointless megabyte of
  // memcpy -- and `getChannelData` hands back a view onto the AudioBuffer's own
  // storage. These samples are transferred to the worker, and transferring
  // detaches the buffer they live in: the AudioBuffer would be emptied out from
  // under the waveform, which then redraws as silence on the next resize, and
  // a second transcription of the same file would find nothing there.
  return mono === channels[0] ? mono.slice() : mono
}

/**
 * Resample through an OfflineAudioContext.
 *
 * The fallback, not the path. An OfflineAudioContext renders through the same
 * resampler `decodeAudioData` would have used, so the result is identical to
 * the fast path -- it just costs a second pass over the audio.
 *
 * @param {AudioBuffer} buffer
 * @returns {Promise<AudioBuffer>}
 */
async function resample(buffer) {
  const frames = Math.ceil(buffer.duration * WHISPER_SAMPLE_RATE)
  const context = new OfflineAudioContext(buffer.numberOfChannels, frames, WHISPER_SAMPLE_RATE)

  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()

  return context.startRendering()
}
