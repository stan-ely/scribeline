/**
 * Turning a file the user picked into something the page can draw and play.
 *
 * Browser-only. Checked under tsconfig.json alone.
 */

import { createDecoderContext } from './resample.js'

/**
 * A decoded recording: the samples, and a URL an <audio> element can play.
 *
 * @typedef {{ audioBuffer: AudioBuffer, url: string, duration: number, name: string }} DecodedAudio
 */

/**
 * Decode a picked file.
 *
 * TWO REPRESENTATIONS OF THE SAME AUDIO, on purpose. The AudioBuffer is for
 * the waveform, which needs samples. The blob URL is for an <audio> element,
 * which gives native transport, seeking, media keys, and a `currentTime`
 * already denominated in the seconds src/core/ speaks -- none of which an
 * AudioBufferSourceNode provides without being reimplemented. `media-src blob:`
 * exists in the generated CSP for exactly this.
 *
 * The URL is created from the File itself and NOT from the ArrayBuffer read out
 * of it, because `decodeAudioData` DETACHES the buffer it is given. A blob made
 * from that same buffer afterwards is empty, and the failure is a silent one:
 * the waveform draws correctly and the player reports zero duration.
 *
 * The AudioContext is closed as soon as the decode is done. It is only ever a
 * decoder here -- playback goes through the <audio> element -- and an open
 * context holds an audio output device, which on some systems is audible as the
 * speakers refusing to sleep.
 *
 * @param {File} file
 * @returns {Promise<DecodedAudio>}
 */
export async function decodeAudioFile(file) {
  const bytes = await file.arrayBuffer()
  // Decoded straight to whisper's 16 kHz rather than the output device's rate.
  // `decodeAudioData` resamples to its context, so this makes the browser's own
  // decoder do a conversion that would otherwise be a second pass over the
  // audio later -- and it holds a sixth of the memory of the same recording at
  // 48 kHz stereo, which matters on the hour-long files this page is for. The
  // waveform is unaffected: peaks are one measurement per pixel column, and no
  // display has enough columns to know the difference.
  const context = createDecoderContext()

  let audioBuffer
  try {
    audioBuffer = await context.decodeAudioData(bytes)
  } catch (cause) {
    // decodeAudioData rejects with a DOMException whose message is usually the
    // empty string, so surfacing it directly gives the user a status line that
    // says nothing. Name the file and say what was wrong with it.
    throw new Error(
      `${file.name} could not be decoded. It may not be an audio file, or it may use a format this browser cannot play.`,
      { cause },
    )
  } finally {
    await context.close()
  }

  return {
    audioBuffer,
    url: URL.createObjectURL(file),
    duration: audioBuffer.duration,
    name: file.name,
  }
}

/**
 * Release a URL from `decodeAudioFile`.
 *
 * Must be called when a second file replaces the first. An object URL is a
 * reference the browser holds for the life of the document, so without this
 * every file opened keeps its entire contents resident -- and this is a page
 * people will open hour-long recordings in, one after another, looking for the
 * right one.
 *
 * @param {string | null} url
 */
export function revokeAudioFile(url) {
  if (url) URL.revokeObjectURL(url)
}
