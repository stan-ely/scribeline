/**
 * The worker that owns whisper.
 *
 * Bundled to site/dist/whisper-worker.<hash>.js as a second entry point by
 * scripts/build-site.mjs, and started by src/web/engine-client.js.
 *
 * WHY A WORKER, given that the threaded build already uses threads: because the
 * build that actually ships does not. `whisper_full` is a synchronous call that
 * returns when the whole recording has been transcribed -- minutes, on a long
 * one. On the main thread that is a frozen page: no playback, no scrolling, no
 * cancel button, and in most browsers an "unresponsive tab" prompt offering to
 * kill the thing the user is waiting for.
 *
 * Everything here runs off the main thread, so nothing in this file may touch
 * the DOM. It talks in messages, and the shapes of those messages are the
 * contract with engine-client.js.
 */

import { toTranscript } from '../src/core/whisper-adapter.js'

/**
 * The instantiated emscripten module, and the whisper context index inside it.
 *
 * Both are kept for the life of the worker. Loading the model is the expensive
 * part -- tens of megabytes parsed into whisper's own structures -- and a page
 * where someone transcribes a second file should not pay it twice.
 *
 * @type {{ module: any, index: number, engineUrl: string } | null}
 */
let engine = null

/**
 * How many threads to ask whisper for.
 *
 * One when the page is not cross-origin isolated, because that is not a
 * preference -- the single-threaded build has no pthreads at all, and asking it
 * for eight would be asking for something that cannot exist. Capped at 8
 * because whisper's own scaling flattens well before then and the cores past it
 * are better left to the rest of the machine.
 */
function threadCount() {
  if (!globalThis.crossOriginIsolated) return 1
  // Capped at 8 to match PTHREAD_POOL_SIZE in whisper/CMakeLists.txt. Asking for
  // more threads than the pool holds sends ggml back to creating one on demand,
  // which deadlocks against this binding's synchronous whisper_full -- the exact
  // hang the pool was added to fix. Raise both numbers together or neither.
  return Math.min(navigator.hardwareConcurrency || 4, 8)
}

/**
 * Load the engine and the model.
 *
 * @param {{ engineUrl: string, model: Uint8Array }} request
 */
async function load({ engineUrl, model }) {
  if (engine && engine.engineUrl === engineUrl) {
    // The glue is already instantiated; only the model needs replacing. Freeing
    // first matters: contexts are a fixed-size pool of four in the binding, so
    // a page where someone tries four models leaks its way to a silent failure
    // to load a fifth.
    engine.module.free(engine.index)
    engine.module.FS.writeFile('/model.bin', model)
    engine.index = engine.module.init('/model.bin')
  } else {
    // A runtime import of a URL the build wrote, not a static one: the file
    // does not exist in this repository, it is produced by
    // scripts/fetch-whisper.mjs, and which of the two variants is loaded is
    // decided by the page at runtime.
    const { default: createWhisperModule } = await import(engineUrl)

    const module = await createWhisperModule({
      // Emscripten writes to these; without them whisper.cpp's own logging goes
      // to the console of a worker nobody is looking at, interleaved and
      // unattributed.
      print: (/** @type {string} */ text) => post({ type: 'log', text }),
      printErr: (/** @type {string} */ text) => post({ type: 'log', text }),
    })

    module.FS.writeFile('/model.bin', model)
    const index = module.init('/model.bin')
    engine = { module, index, engineUrl }
  }

  if (!engine.index) {
    throw new Error(
      'whisper could not load the model. It may be for a different version of ' +
        'whisper.cpp, or the download may be corrupt -- try removing it and ' +
        'downloading again.',
    )
  }
}

/**
 * Transcribe.
 *
 * @param {{ samples: Float32Array, duration: number, language: string, translate: boolean }} request
 */
function transcribe({ samples, duration, language, translate }) {
  if (!engine) throw new Error('The engine has not been loaded')

  const raw = engine.module.transcribe(
    engine.index,
    samples,
    language,
    threadCount(),
    translate,
    // Partial results as they are decoded. Whisper works in order, so the last
    // segment's end time over the duration is honest progress -- and the text
    // arriving is what makes a long wait legible rather than merely long.
    (/** @type {any} */ segment) => post({ type: 'segment', segment, duration }),
    (/** @type {number} */ percent) => post({ type: 'progress', percent }),
  )

  if (raw === null) {
    throw new Error('whisper failed to transcribe this audio.')
  }

  // Converted here rather than on the main thread: this is the boundary the raw
  // shape exists on either side of, and shipping tokens across postMessage only
  // to convert them there would put whisper's centiseconds in a second file.
  return toTranscript(raw, duration)
}

/** @param {any} message */
function post(message) {
  postMessage(message)
}

self.addEventListener('message', async (event) => {
  const request = event.data
  try {
    if (request.type === 'load') {
      await load(request)
      post({ type: 'loaded', id: request.id })
    } else if (request.type === 'transcribe') {
      post({ type: 'done', id: request.id, transcript: transcribe(request) })
    }
  } catch (error) {
    // Errors are posted, never thrown. An exception escaping a worker's message
    // handler surfaces as a bare `error` event with no message on most
    // browsers, which reaches the user as "something went wrong" for a fault
    // that named itself precisely.
    post({
      type: 'error',
      id: request?.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})
