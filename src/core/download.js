/**
 * Fetching a model's weights, once, and keeping them.
 *
 * A model is tens of megabytes and it is the same tens of megabytes every
 * visit, so downloading it twice is the difference between an app someone uses
 * again and an app someone used. The Cache API is the right store for it: it is
 * keyed by URL, it survives a reload and a closed tab, and unlike IndexedDB it
 * holds a `Response` -- which is what a download already is.
 *
 * EVERYTHING THIS NEEDS IS INJECTED. `fetch` and `caches` are parameters rather
 * than globals, which is not ceremony: it is the only reason this file can be
 * tested at all. The behaviour worth testing here is entirely about failure --
 * a cache hit that must not touch the network, an abort that must leave nothing
 * half-written, a response with no `Content-Length` -- and none of that is
 * reachable from a test that has to make a real request for a real model over a
 * real network.
 *
 * Isomorphic: no DOM, no fs. Checked under both tsconfig projects.
 */

/**
 * The Cache API bucket the weights live in.
 *
 * Versioned in the name so that a future change to what is stored can be
 * retired by opening a different bucket and deleting this one, rather than by
 * trying to recognise and migrate whatever a previous release left behind.
 */
export const MODEL_CACHE = 'scribeline-models-v1'

/**
 * How far along a download is.
 *
 * `total` is 0 when the server did not say. That is reported honestly rather
 * than guessed at, because the alternative -- dividing by an unknown total --
 * puts `NaN%` in front of someone waiting on a 60 MB download, and a progress
 * bar that lies is worse than a byte count that does not.
 *
 * @typedef {{ loaded: number, total: number, cached: boolean }} DownloadProgress
 */

/**
 * @typedef {object} DownloadOptions
 * @property {typeof globalThis.fetch} fetch
 * @property {CacheStorage} caches
 * @property {string} [cacheName]
 * @property {AbortSignal} [signal]
 * @property {(progress: DownloadProgress) => void} [onProgress]
 */

/**
 * Whether a model is already on this machine.
 *
 * Lets the UI say "ready" instead of "download" without fetching anything, and
 * lets the Transcribe button be honest about whether pressing it will start a
 * 60 MB download.
 *
 * @param {string} url
 * @param {{ caches: CacheStorage, cacheName?: string }} options
 * @returns {Promise<boolean>}
 */
export async function isModelCached(url, { caches, cacheName = MODEL_CACHE }) {
  const cache = await caches.open(cacheName)
  return (await cache.match(url)) !== undefined
}

/**
 * Get a model's bytes, from the cache if they are there and from the network if
 * they are not.
 *
 * The whole response is buffered before it is stored. Handing a partially-read
 * body to `cache.put` is not portable -- the body has already been consumed by
 * the progress loop, and a `Response` cannot be read twice -- so the choice is
 * between buffering and giving up progress reporting. Buffering wins, and the
 * cost is that the largest model briefly holds its own size in memory. That is
 * the reason `DEFAULT_MODEL` in engine.js is a small one.
 *
 * NOTHING IS CACHED UNTIL THE DOWNLOAD COMPLETES. A partial model is not a
 * smaller model; it is a file that fails to initialise whisper with an error
 * that says nothing about the download that produced it. An abort or a dropped
 * connection must leave the cache exactly as it was, so the next attempt starts
 * clean rather than finding half a model and trusting it.
 *
 * @param {string} url
 * @param {DownloadOptions} options
 * @returns {Promise<Uint8Array>}
 */
export async function downloadModel(url, options) {
  const { fetch, caches, cacheName = MODEL_CACHE, signal, onProgress } = options
  const cache = await caches.open(cacheName)

  const hit = await cache.match(url)
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer())
    // Reported anyway, with `cached` set. A caller that only redraws on
    // progress would otherwise show nothing at all on the fast path, which
    // reads as a button that did not work.
    onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, cached: true })
    return bytes
  }

  const response = await fetch(url, { signal })
  if (!response.ok) {
    // The status, and the URL. A model download crosses a redirect to a CDN on
    // a different origin, so "404" alone does not say which of the two hosts
    // said it -- and that distinction is the whole diagnosis.
    throw new Error(`Could not download the model: ${response.status} ${response.statusText} (${url})`)
  }
  if (!response.body) {
    throw new Error(`The model download returned no body (${url})`)
  }

  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()

  /** @type {Uint8Array[]} */
  const chunks = []
  let loaded = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      onProgress?.({ loaded, total, cached: false })
    }
  } catch (error) {
    // Releasing the reader on the way out matters: without it an aborted
    // download leaves the response body locked, and the retry that someone
    // immediately attempts fails for a different reason than the first one did.
    reader.releaseLock()
    throw error
  }

  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  // Stored only now, and only if the length we were promised is the length we
  // got. A truncated response that still ended cleanly is the one failure the
  // loop above cannot see.
  if (total > 0 && loaded !== total) {
    throw new Error(
      `The model download ended early: ${loaded} of ${total} bytes (${url})`,
    )
  }
  await cache.put(url, new Response(bytes))

  return bytes
}

/**
 * Forget a downloaded model.
 *
 * Here because the weights are the largest thing this app puts on someone's
 * disk by two orders of magnitude, and a page that quietly parks 190 MB in
 * browser storage with no way to take it back is not one this project wants to
 * be.
 *
 * @param {string} url
 * @param {{ caches: CacheStorage, cacheName?: string }} options
 * @returns {Promise<boolean>} whether there was anything to delete
 */
export async function deleteModel(url, { caches, cacheName = MODEL_CACHE }) {
  const cache = await caches.open(cacheName)
  return cache.delete(url)
}
