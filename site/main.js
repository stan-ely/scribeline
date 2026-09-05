/**
 * The page entry point. Bundled to site/dist/main.<hash>.js by
 * scripts/build-site.mjs.
 *
 * Audio in, subtitle file out. Open a recording, see it, play it, click it,
 * transcribe it, and download the SRT or VTT. The transcript is not drawn on
 * the page yet -- that is the next slice, and this one exists to make the
 * engine underneath it trustworthy first.
 */

import { el, formatDuration } from '../src/web/dom.js'
import { decodeAudioFile, revokeAudioFile } from '../src/web/audio-file.js'
import { createWaveform } from '../src/web/waveform.js'
import { createPlayer } from '../src/web/player.js'
import { toWhisperSamples } from '../src/web/resample.js'
import { createEngineClient } from '../src/web/engine-client.js'
import { MODELS, DEFAULT_MODEL } from '../src/core/engine.js'
import { downloadModel, isModelCached } from '../src/core/download.js'
import { toSRT, toVTT } from '../src/core/subtitles.js'

/** @typedef {import('../src/core/transcript.js').Transcript} Transcript */

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
 * transcription speed. The app reads it once and loads a single-threaded engine
 * build when it is false, rather than failing.
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

// --- The engine's controls -------------------------------------------------

const modelSelect = el('select', 'model-select')
modelSelect.id = 'model'
for (const [id, model] of Object.entries(MODELS)) {
  const option = el('option', null, `${model.label} — ${megabytes(model.bytes)}`)
  option.value = id
  modelSelect.append(option)
}
modelSelect.value = DEFAULT_MODEL

const modelLabel = el('label', 'field-label', 'Model')
modelLabel.htmlFor = modelSelect.id

const transcribeButton = el('button', 'action', 'Transcribe')
transcribeButton.type = 'button'
transcribeButton.disabled = true

const srtButton = el('button', 'action', 'Download SRT')
srtButton.type = 'button'
srtButton.disabled = true

const vttButton = el('button', 'action', 'Download VTT')
vttButton.type = 'button'
vttButton.disabled = true

const engineStatus = el('p', 'status', 'No transcript yet.')
engineStatus.setAttribute('role', 'status')

// A <progress> with no value is indeterminate, which is exactly right for the
// gap between pressing Transcribe and whisper reporting its first percent.
const progress = el('progress', 'progress')
progress.max = 100
progress.hidden = true

const controls = el('div', 'controls')
controls.append(modelLabel, modelSelect, transcribeButton, srtButton, vttButton)

const footer = el(
  'p',
  'footer',
  THREADS_AVAILABLE
    ? 'Cross-origin isolated: threaded inference is available.'
    : 'Not cross-origin isolated, so SharedArrayBuffer is unavailable and ' +
      'transcription runs single-threaded. That is the deploy host, not ' +
      'the build.',
)

app.append(heading, chooser, status, surface, audio, controls, progress, engineStatus, footer)

const waveform = createWaveform(canvas)
const player = createPlayer({ audio, surface })

// Substituted by the build, which bundles the worker first so that this name --
// which carries a content hash -- exists to substitute. See types/build.d.ts.
const engine = createEngineClient(new URL(__WHISPER_WORKER__, document.baseURI).href)

// --- State -----------------------------------------------------------------

/** The object URL of the file currently loaded, released when the next replaces it. @type {string | null} */
let currentUrl = null
/** @type {AudioBuffer | null} */
let currentBuffer = null
/** @type {string} */
let currentName = ''
/** @type {Transcript | null} */
let transcript = null
/** Whether the loaded model matches the one the select is showing. @type {string | null} */
let loadedModel = null

// --- Opening a recording ---------------------------------------------------

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
    currentBuffer = decoded.audioBuffer
    currentName = decoded.name

    audio.src = decoded.url
    player.setDuration(decoded.duration)
    waveform.setBuffer(decoded.audioBuffer)

    // A new recording invalidates the old transcript. Leaving the export
    // buttons live would hand someone the previous file's subtitles under this
    // file's name, which is a mistake they would not find until a player
    // disagreed with them.
    transcript = null
    srtButton.disabled = true
    vttButton.disabled = true
    engineStatus.textContent = 'No transcript yet.'

    status.textContent = `${decoded.name} — ${formatDuration(decoded.duration)}`
    transcribeButton.disabled = false
  } catch (error) {
    status.textContent = message(error)
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

// --- Transcribing ----------------------------------------------------------

transcribeButton.addEventListener('click', () => void transcribe())

async function transcribe() {
  if (!currentBuffer) return

  const id = modelSelect.value
  const model = MODELS[/** @type {keyof typeof MODELS} */ (id)]
  if (!model) return

  transcribeButton.disabled = true
  modelSelect.disabled = true
  progress.hidden = false
  progress.removeAttribute('value')

  try {
    if (loadedModel !== id) {
      // Said before it starts, not after. This is a download measured in tens
      // of megabytes and someone on a metered connection is entitled to know
      // that is what the button did.
      const cached = await isModelCached(model.url, { caches })
      engineStatus.textContent = cached
        ? `Loading ${model.label}…`
        : `Downloading ${model.label} (${megabytes(model.bytes)})…`

      const bytes = await downloadModel(model.url, {
        fetch: globalThis.fetch.bind(globalThis),
        caches,
        onProgress: ({ loaded, total, cached: fromCache }) => {
          if (fromCache) return
          engineStatus.textContent = total
            ? `Downloading ${model.label}: ${megabytes(loaded)} of ${megabytes(total)}`
            : `Downloading ${model.label}: ${megabytes(loaded)}`
          if (total) progress.value = (loaded / total) * 100
        },
      })

      engineStatus.textContent = `Loading ${model.label} into the engine…`
      progress.removeAttribute('value')
      await engine.load(bytes)
      loadedModel = id
    }

    engineStatus.textContent = 'Transcribing…'
    const samples = await toWhisperSamples(currentBuffer)
    const duration = currentBuffer.duration

    transcript = await engine.transcribe(
      samples,
      duration,
      {},
      {
        onProgress: (percent) => {
          progress.value = percent
        },
        onSegment: (text, endSeconds) => {
          // The partial text, as it decodes. Whisper works in order, so this is
          // both a preview and the honest answer to "is it stuck".
          engineStatus.textContent = `${formatDuration(endSeconds)} / ${formatDuration(duration)} — ${text.trim()}`
        },
      },
    )

    const words = transcript.segments.reduce((n, segment) => n + segment.words.length, 0)
    engineStatus.textContent = `${words} words in ${transcript.segments.length} segments.`
    srtButton.disabled = words === 0
    vttButton.disabled = words === 0
  } catch (error) {
    engineStatus.textContent = message(error)
  } finally {
    progress.hidden = true
    transcribeButton.disabled = false
    modelSelect.disabled = false
  }
}

// --- Exporting -------------------------------------------------------------

srtButton.addEventListener('click', () => save(toSRT, 'srt'))
vttButton.addEventListener('click', () => save(toVTT, 'vtt'))

/**
 * Hand the transcript over as a file.
 *
 * An object URL and a synthetic click on an <a download>, which needs no CSP
 * directive and no server. The URL is revoked immediately after: the browser
 * has already taken what it needs by then, and an un-revoked one keeps the
 * whole subtitle file resident for the life of the tab.
 *
 * @param {(transcript: Transcript) => string} render
 * @param {string} extension
 */
function save(render, extension) {
  if (!transcript) return

  const blob = new Blob([render(transcript)], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  const link = el('a')
  link.href = url
  // The recording's name with the extension swapped, so a folder of recordings
  // exports into a folder of matching subtitle files rather than a folder of
  // transcript.srt, transcript (1).srt.
  link.download = currentName.replace(/\.[^.]+$/, '') + '.' + extension
  link.click()

  URL.revokeObjectURL(url)
}

// --- Small helpers ---------------------------------------------------------

/** @param {number} bytes */
function megabytes(bytes) {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
