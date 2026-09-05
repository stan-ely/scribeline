/**
 * The page entry point. Bundled to site/dist/main.<hash>.js by
 * scripts/build-site.mjs.
 *
 * Audio in, subtitle file out. Open a recording, see it, play it, click it,
 * transcribe it, read it with the current word highlighted as it plays,
 * correct a word, split or merge segments, drag a boundary, undo it if you
 * change your mind, and download the SRT or VTT.
 */

import { el, formatDuration } from '../src/web/dom.js'
import { decodeAudioFile, revokeAudioFile } from '../src/web/audio-file.js'
import { createWaveform } from '../src/web/waveform.js'
import { createPlayer } from '../src/web/player.js'
import { createTranscriptView } from '../src/web/transcript-view.js'
import { toWhisperSamples } from '../src/web/resample.js'
import { createEngineClient } from '../src/web/engine-client.js'
import { MODELS, DEFAULT_MODEL } from '../src/core/engine.js'
import { downloadModel, isModelCached } from '../src/core/download.js'
import { toSRT, toVTT } from '../src/core/subtitles.js'
import { createUndoStack } from '../src/core/undo.js'

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

const transcribeButton = el('button', 'action is-primary', 'Transcribe')
transcribeButton.type = 'button'
transcribeButton.disabled = true

const cancelButton = el('button', 'action is-danger', 'Cancel')
cancelButton.type = 'button'
cancelButton.hidden = true

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
controls.append(modelLabel, modelSelect, transcribeButton, cancelButton, srtButton, vttButton)

// Whether the selected model is already on this machine, and whether this
// host runs single- or multi-threaded -- both said once, next to the
// controls they explain, rather than discovered after clicking Transcribe or
// buried in a footer nobody scrolls to.
const modelHint = el('p', 'model-hint')
const speedHint = el(
  'p',
  'speed-hint',
  // Only the non-default case is worth a sentence -- the isolated case is
  // what everything else on the page already assumes.
  THREADS_AVAILABLE
    ? ''
    : 'Running single-threaded on this host, so transcription will be ' +
      'noticeably slower than on a cross-origin-isolated deploy.',
)
const controlHints = el('div', 'control-hints')
controlHints.append(modelHint, speedHint)

// Empty until a transcript exists (`.transcript-hint:empty` hides it), so the
// gestures nothing else on the page states -- double-click a word, tab
// through corrections, insert or delete one, drag ⋮ -- are said once rather
// than left for hover to reveal by accident.
const transcriptHint = el('p', 'transcript-hint')
const TRANSCRIPT_HINT_TEXT =
  'Double-click a word to fix it, Enter/Tab for the next · + inserts a word, ' +
  'Ctrl/Cmd+Backspace deletes one · drag ⋮ between segments to move where one ends.'

const transcriptEl = el('div', 'transcript')

app.append(
  heading,
  chooser,
  status,
  surface,
  audio,
  controlHints,
  controls,
  transcriptHint,
  transcriptEl,
  progress,
  engineStatus,
)

const waveform = createWaveform(canvas)
const player = createPlayer({ audio, surface })
const transcriptView = createTranscriptView({
  container: transcriptEl,
  audio,
  onChange: (next) => {
    transcript = next
    history?.push(next)
    updateExportState()
  },
})

// Substituted by the build, which bundles the worker first so that this name --
// which carries a content hash -- exists to substitute. See types/build.d.ts.
const workerUrl = new URL(__WHISPER_WORKER__, document.baseURI).href

// --- State -----------------------------------------------------------------

// A `let`, not a `const`: cancelling mid-transcribe replaces it with a fresh
// worker (see transcribe()'s catch/cancel handling below) rather than trying
// to make an already-running whisper.cpp call give up the main thread it is
// blocking.
let engine = createEngineClient(workerUrl)

/** The object URL of the file currently loaded, released when the next replaces it. @type {string | null} */
let currentUrl = null
/** @type {AudioBuffer | null} */
let currentBuffer = null
/** @type {string} */
let currentName = ''
/** @type {Transcript | null} */
let transcript = null
/** Undo/redo over `transcript`, created once a transcript exists. @type {import('../src/core/undo.js').UndoStack<Transcript> | null} */
let history = null
/** Whether the loaded model matches the one the select is showing. @type {string | null} */
let loadedModel = null

/**
 * Keep the export buttons and the word-count status in sync with whatever
 * `transcript` currently holds -- whisper's own output, an edit, or an
 * undo/redo. The single place both transcribe() and edits funnel through, so
 * the two never drift the way two separately-maintained copies of this logic
 * would.
 */
function updateExportState() {
  const words = transcript
    ? transcript.segments.reduce((n, segment) => n + segment.words.length, 0)
    : 0
  srtButton.disabled = words === 0
  vttButton.disabled = words === 0
  engineStatus.textContent = transcript
    ? `${words} words in ${transcript.segments.length} segments.`
    : 'No transcript yet.'
  transcriptHint.textContent = words > 0 ? TRANSCRIPT_HINT_TEXT : ''
}

/**
 * Say, before someone commits to it, whether pressing Transcribe with the
 * currently-selected model starts a real download or not -- the option
 * label already states its size, but not whether that size has already been
 * paid.
 *
 * Stamped with the model id it was asked about and re-checked against the
 * select's current value before applying: `isModelCached` is async, and a
 * fast second change while the first check is still in flight must not have
 * its answer overwritten by the first one arriving late.
 */
async function refreshModelHint() {
  const id = modelSelect.value
  const model = MODELS[/** @type {keyof typeof MODELS} */ (id)]
  if (!model) return

  const cached = await isModelCached(model.url, { caches })
  if (modelSelect.value !== id) return // superseded by a later selection

  modelHint.textContent = cached
    ? `${model.label} is already downloaded.`
    : `${model.label} will download ${megabytes(model.bytes)}.`
}

modelSelect.addEventListener('change', () => void refreshModelHint())
void refreshModelHint()

// Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y to redo. Attached to
// window rather than the transcript container, because a merge or split
// click may have just had render() replace the element that had focus --
// chasing focus through a container that rebuilds itself on every edit is
// more fragile than filtering by activeElement instead.
window.addEventListener('keydown', (event) => {
  if (!history) return
  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z'
  const isRedo =
    (event.ctrlKey || event.metaKey) &&
    ((event.shiftKey && event.key === 'z') || event.key === 'y')
  if (!isUndo && !isRedo) return

  // A word correction is a native <input> mid-edit, with its own undo
  // history -- Ctrl/Cmd+Z there should behave like it does in any text field,
  // not jump the whole transcript back a step.
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return

  event.preventDefault()
  const next = isUndo ? history.undo() : history.redo()
  if (next === undefined) return
  transcript = next
  updateExportState()
  transcriptView.render(transcript)
})

// --- Opening a recording ---------------------------------------------------

/** @param {File | undefined | null} file */
async function open(file) {
  if (!file) return

  status.textContent = `Decoding ${file.name}…`
  status.classList.remove('is-error')
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
    history = null
    updateExportState()
    transcriptView.clear()

    status.textContent = `${decoded.name} — ${formatDuration(decoded.duration)}`
    transcribeButton.disabled = false
  } catch (error) {
    status.textContent = message(error)
    status.classList.add('is-error')
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

// The in-flight run's cancellation, if any -- created fresh by transcribe()
// each time, since an AbortController can't be un-aborted for a second run.
/** @type {AbortController | null} */
let cancelling = null
let cancelled = false

cancelButton.addEventListener('click', () => {
  cancelled = true
  cancelling?.abort()
  // There is no cooperative cancel in the worker protocol -- whisper.cpp
  // blocks the worker's one thread for the length of a transcribe() call, so
  // the only way to actually stop one already running is to end the worker
  // and start over. Doing this unconditionally (even mid-download, when
  // nothing has been loaded into this engine yet) is simpler than tracking
  // which phase is active, and costs one extra Worker construction that
  // does not itself load wasm or a model.
  engine.destroy()
  engine = createEngineClient(workerUrl)
  loadedModel = null
})

async function transcribe() {
  if (!currentBuffer) return

  const id = modelSelect.value
  const model = MODELS[/** @type {keyof typeof MODELS} */ (id)]
  if (!model) return

  const controller = new AbortController()
  cancelling = controller
  cancelled = false

  transcribeButton.disabled = true
  modelSelect.disabled = true
  cancelButton.hidden = false
  progress.hidden = false
  progress.removeAttribute('value')
  engineStatus.classList.remove('is-error')

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
        signal: controller.signal,
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

    history = createUndoStack(transcript)
    updateExportState()
    transcriptView.render(transcript)
  } catch (error) {
    // Both the abort()ed fetch and the destroy()ed worker reject with their
    // own, unrelated errors -- `cancelled` is the one flag set by exactly one
    // cause, the Cancel button, so it is what distinguishes "asked for this"
    // from "actually failed" regardless of which phase was interrupted.
    if (cancelled) {
      engineStatus.textContent = 'Cancelled.'
    } else {
      engineStatus.textContent = message(error)
      engineStatus.classList.add('is-error')
    }
  } finally {
    cancelling = null
    progress.hidden = true
    cancelButton.hidden = true
    transcribeButton.disabled = false
    modelSelect.disabled = false
    // A cancelled download leaves nothing cached (downloadModel only stores
    // it on success), so this correctly falls back to "will download" rather
    // than assuming the run that just ended left the model behind.
    void refreshModelHint()
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
