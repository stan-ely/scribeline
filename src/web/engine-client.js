/**
 * The page's side of the whisper worker.
 *
 * A promise-shaped wrapper over postMessage, so the page can `await
 * engine.transcribe(...)` instead of writing a message-correlation state
 * machine next to its DOM code.
 *
 * Browser-only. Checked under tsconfig.json alone.
 */

import { engineFile } from '../core/engine.js'

/** @typedef {import('../core/transcript.js').Transcript} Transcript */

/**
 * @typedef {object} EngineEvents
 * @property {(percent: number) => void} [onProgress] 0-100, from whisper itself
 * @property {(text: string, endSeconds: number) => void} [onSegment] partial text as it decodes
 */

/**
 * Start the worker.
 *
 * The worker is created eagerly but the engine inside it is not: instantiating
 * the wasm and parsing a model is tens of megabytes of work, and a visitor who
 * opens the page to look at a waveform should not pay for it.
 *
 * @param {string} workerUrl the built worker's URL, injected by the build
 * @returns {{
 *   load(model: Uint8Array, events?: EngineEvents): Promise<void>,
 *   transcribe(samples: Float32Array, duration: number, options?: { language?: string, translate?: boolean }, events?: EngineEvents): Promise<Transcript>,
 *   destroy(): void,
 * }}
 */
export function createEngineClient(workerUrl) {
  const worker = new Worker(workerUrl, { type: 'module' })

  let nextId = 1
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, events: EngineEvents }>} */
  const pending = new Map()

  worker.addEventListener('message', (event) => {
    const message = event.data
    // Progress and segments carry the id of no particular request in the common
    // case -- there is only ever one run in flight -- so they are dispatched to
    // whatever is waiting rather than looked up.
    const waiting = pending.get(message.id) ?? [...pending.values()][0]

    switch (message.type) {
      case 'progress':
        waiting?.events.onProgress?.(message.percent)
        break
      case 'segment':
        waiting?.events.onSegment?.(message.segment.text, message.segment.t1 / 100)
        break
      case 'log':
        // whisper.cpp's own output. Kept at debug so it is available when
        // something is wrong and invisible when nothing is.
        console.debug('[whisper]', message.text)
        break
      case 'loaded':
      case 'done':
        pending.get(message.id)?.resolve(message.transcript)
        pending.delete(message.id)
        break
      case 'error':
        pending.get(message.id)?.reject(new Error(message.message))
        pending.delete(message.id)
        break
    }
  })

  worker.addEventListener('error', (event) => {
    // A worker that fails to start -- a missing engine file, a syntax error in
    // the glue -- never delivers a message, so every pending promise would hang
    // forever. This is the only place that can tell the page the difference
    // between "still working" and "will never work".
    const error = new Error(
      event.message || 'The transcription worker failed to start. Is the engine built?',
    )
    for (const [id, waiting] of pending) {
      waiting.reject(error)
      pending.delete(id)
    }
  })

  /**
   * @param {any} message
   * @param {EngineEvents} events
   * @param {Transferable[]} [transfer]
   */
  const send = (message, events, transfer = []) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, events })
      worker.postMessage({ ...message, id }, transfer)
    })
  }

  return {
    async load(model, events = {}) {
      // Transferred, not copied. A structured clone of a 60 MB model is a
      // second 60 MB and a visible pause on the main thread, and the page has
      // no use for the bytes once the worker has them.
      await send(
        { type: 'load', engineUrl: engineUrlFor(), model },
        events,
        [model.buffer],
      )
    },

    transcribe(samples, duration, options = {}, events = {}) {
      return send(
        {
          type: 'transcribe',
          samples,
          duration,
          language: options.language ?? 'en',
          translate: options.translate ?? false,
        },
        events,
        [samples.buffer],
      )
    },

    destroy() {
      worker.terminate()
      pending.clear()
    },
  }
}

/**
 * The absolute URL of the engine build this page may use.
 *
 * Resolved against the document rather than written as an absolute path. This
 * app deploys to a project Pages site under `/scribeline/`, so a leading slash
 * would resolve to the domain root -- correct in every local test and a 404 in
 * production. See ENGINE_DIR in src/core/engine.js.
 *
 * @returns {string}
 */
function engineUrlFor() {
  return new URL(engineFile(globalThis.crossOriginIsolated === true), document.baseURI).href
}
