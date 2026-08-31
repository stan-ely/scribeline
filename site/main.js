/**
 * The page entry point. Bundled to site/dist/main.<hash>.js by
 * scripts/build-site.mjs.
 *
 * This is the first screen that does something: open a recording, see it, play
 * it, click it. There is no transcript yet -- what this slice builds is the
 * timeline the words will be positioned against.
 */

import { el, formatDuration } from '../src/web/dom.js'
import { decodeAudioFile, revokeAudioFile } from '../src/web/audio-file.js'
import { createWaveform } from '../src/web/waveform.js'
import { createPlayer } from '../src/web/player.js'

/**
 * Refuse to run inside a frame.
 *
 * This page handles recordings people have not chosen to publish. Embedded in
 * someone else's document, it becomes a control they can position under their
 * own copy and their own framing, and clickjacking a file picker is a real
 * attack rather than a theoretical one.
 *
 * The header that would prevent this properly is `frame-ancestors`, and it is
 * only honoured as an HTTP response header -- never inside a <meta> tag. GitHub
 * Pages serves no custom headers at all, so on the deploy target this check is
 * not defence in depth, it is the defence. It stays regardless of host.
 */
if (window.top !== window.self) {
  document.documentElement.textContent =
    'scribeline will not run inside a frame. Open it directly.'
  throw new Error('framed')
}

/**
 * Whether the page is cross-origin isolated, and therefore whether
 * `SharedArrayBuffer` -- and threaded whisper.cpp inference -- is available.
 *
 * This is not a capability to check at the point of use. It is decided by
 * response headers before any of our code runs, it cannot be recovered from at
 * runtime, and the difference it makes is roughly an order of magnitude in
 * transcription speed. The app is expected to read this once and choose a
 * single-threaded build when it is false, rather than fail.
 *
 * See the header comment in scripts/build-site.mjs for why it is false on some
 * hosts no matter what this repository does.
 */
export const THREADS_AVAILABLE = globalThis.crossOriginIsolated === true

const app = document.getElementById('app')
if (!app) throw new Error('#app is missing from the page')

const heading = el('h1', null, 'scribeline')

// A real <input type="file"> inside a <label>, rather than a button that calls
// showOpenFilePicker(). The input is the only file-choosing control every
// browser has, it is keyboard-reachable and announced correctly for free, and
// the label is what makes it stylable -- the input's own button cannot be.
const input = el('input', 'chooser-input')
input.type = 'file'
input.accept = 'audio/*'
input.id = 'audio-file'

const chooser = el('label', 'chooser')
chooser.htmlFor = input.id
chooser.append(el('span', null, 'Open a recording'), input)

const status = el('p', 'status', 'No file open.')
// Announced when it changes, because the two things it reports -- a decode
// finishing and a decode failing -- both happen with no visible movement
// anywhere else on the page.
status.setAttribute('role', 'status')

const canvas = el('canvas', 'waveform-canvas')
const playhead = el('div', 'playhead')
const surface = el('div', 'waveform')
surface.append(canvas, playhead)

const audio = el('audio', 'transport')
audio.controls = true
// The waveform is the scrub bar; the native control is here for play, pause,
// volume, and speed. It has no source until a file is opened.
audio.preload = 'metadata'

const footer = el(
  'p',
  'footer',
  THREADS_AVAILABLE
    ? 'Cross-origin isolated: threaded inference will be available.'
    : 'Not cross-origin isolated, so SharedArrayBuffer is unavailable and ' +
      'transcription will run single-threaded. That is the deploy host, not ' +
      'the build.',
)

app.append(heading, chooser, status, surface, audio, footer)

const waveform = createWaveform(canvas)
const player = createPlayer({ audio, surface })

/**
 * The URL of the file currently loaded, so it can be released when the next one
 * replaces it.
 *
 * @type {string | null}
 */
let currentUrl = null

/** @param {File | undefined | null} file */
async function open(file) {
  if (!file) return

  status.textContent = `Decoding ${file.name}…`
  try {
    const decoded = await decodeAudioFile(file)

    // Revoked only once the new file has decoded successfully. Releasing the
    // old URL first would leave a failed decode with nothing loaded and the
    // previous recording gone, which is the worst outcome for someone who
    // picked the wrong file out of a folder.
    revokeAudioFile(currentUrl)
    currentUrl = decoded.url

    audio.src = decoded.url
    player.setDuration(decoded.duration)
    waveform.setBuffer(decoded.audioBuffer)

    status.textContent = `${decoded.name} — ${formatDuration(decoded.duration)}`
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
}

input.addEventListener('change', () => {
  void open(input.files?.[0])
  // Cleared so that choosing the same file twice fires `change` again -- after
  // a failed decode, re-picking the same file is exactly what someone tries.
  input.value = ''
})

// Drop as well as pick. Both handlers are needed: without preventDefault on
// dragover the browser navigates away to the file, replacing the page.
surface.addEventListener('dragover', (event) => {
  event.preventDefault()
  surface.classList.add('is-dropping')
})
surface.addEventListener('dragleave', () => surface.classList.remove('is-dropping'))
surface.addEventListener('drop', (event) => {
  event.preventDefault()
  surface.classList.remove('is-dropping')
  void open(event.dataTransfer?.files[0])
})
