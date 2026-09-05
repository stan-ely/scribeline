/**
 * Fetching and caching a model's weights.
 *
 * Every test here runs against a fake `fetch` and a fake `CacheStorage`, which
 * is the entire reason src/core/download.js takes them as arguments. What is
 * being checked is not that a download works -- that is one line of `fetch` --
 * but that the failures leave the cache in a state the next attempt can
 * recover from, and that the fast path does not touch the network at all.
 *
 * Offline and instant. Nothing here touches the network, the DOM, or the disk.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { downloadModel, isModelCached, deleteModel } from '../src/core/download.js'

const URL_ = 'https://example.invalid/ggml-tiny.en.bin'

/**
 * A CacheStorage over a Map, implementing only what download.js uses.
 *
 * Real enough to catch the mistakes that matter: it stores a Response, so a
 * body read twice fails here exactly as it would in a browser.
 */
function fakeCaches() {
  /** @type {Map<string, Response>} */
  const entries = new Map()
  const cache = {
    async match(/** @type {any} */ key) {
      const stored = entries.get(String(key))
      return stored ? stored.clone() : undefined
    },
    async put(/** @type {any} */ key, /** @type {any} */ response) {
      entries.set(String(key), response)
    },
    async delete(/** @type {any} */ key) {
      return entries.delete(String(key))
    },
  }
  return { caches: /** @type {any} */ ({ async open() { return cache } }), entries }
}

/**
 * A fetch that streams `bytes` in fixed-size chunks, so the progress loop runs
 * more than once.
 *
 * @param {Uint8Array} bytes
 * @param {{ chunk?: number, contentLength?: boolean, failAfter?: number }} [options]
 */
function fakeFetch(bytes, options = {}) {
  const { chunk = 4, contentLength = true, failAfter = Infinity } = options
  let calls = 0

  const fetch = async (/** @type {any} */ _url, /** @type {any} */ init) => {
    calls++
    let offset = 0
    const stream = new ReadableStream({
      pull(controller) {
        if (init?.signal?.aborted) {
          controller.error(new Error('aborted'))
          return
        }
        if (offset >= failAfter) {
          controller.error(new Error('connection reset'))
          return
        }
        if (offset >= bytes.byteLength) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(offset, offset + chunk))
        offset += chunk
      },
    })
    return new Response(stream, {
      status: 200,
      headers: contentLength ? { 'content-length': String(bytes.byteLength) } : {},
    })
  }

  return { fetch: /** @type {any} */ (fetch), calls: () => calls }
}

const model = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

test('a download returns the bytes and stores them', async () => {
  const { caches, entries } = fakeCaches()
  const { fetch } = fakeFetch(model)

  const bytes = await downloadModel(URL_, { fetch, caches })

  assert.deepEqual([...bytes], [...model], 'the chunks were reassembled in order')
  assert.ok(entries.has(URL_), 'and kept, or the next visit pays for them again')
})

test('a cached model never touches the network', async () => {
  const { caches } = fakeCaches()
  const first = fakeFetch(model)
  await downloadModel(URL_, { fetch: first.fetch, caches })

  const second = fakeFetch(model)
  const bytes = await downloadModel(URL_, { fetch: second.fetch, caches })

  assert.equal(
    second.calls(),
    0,
    'the whole point of the cache is that the second visit is offline and instant',
  )
  assert.deepEqual([...bytes], [...model])
})

test('progress adds up to the total, and reports it', async () => {
  const { caches } = fakeCaches()
  const { fetch } = fakeFetch(model, { chunk: 3 })

  /** @type {import('../src/core/download.js').DownloadProgress[]} */
  const seen = []
  await downloadModel(URL_, { fetch, caches, onProgress: (p) => seen.push(p) })

  assert.ok(seen.length > 1, 'a single progress event is a spinner, not progress')
  assert.equal(seen.at(-1)?.loaded, model.byteLength, 'the last event is the whole file')
  assert.equal(seen.at(-1)?.total, model.byteLength, 'and knows what the whole file was')
  assert.ok(
    seen.every((p, i) => i === 0 || p.loaded >= seen[i - 1].loaded),
    'progress must never go backwards',
  )
})

test('a missing Content-Length reports a total of 0, not NaN', async () => {
  const { caches } = fakeCaches()
  const { fetch } = fakeFetch(model, { contentLength: false })

  /** @type {number[]} */
  const totals = []
  await downloadModel(URL_, { fetch, caches, onProgress: (p) => totals.push(p.total) })

  assert.ok(
    totals.every((t) => t === 0),
    'an unknown total must be reported as unknown -- dividing by NaN puts ' +
      '"NaN%" in front of someone waiting on a 60 MB download',
  )
})

test('a cache hit still reports progress, marked as cached', async () => {
  const { caches } = fakeCaches()
  const { fetch } = fakeFetch(model)
  await downloadModel(URL_, { fetch, caches })

  /** @type {import('../src/core/download.js').DownloadProgress[]} */
  const seen = []
  await downloadModel(URL_, { fetch, caches, onProgress: (p) => seen.push(p) })

  assert.equal(seen.length, 1, 'one event, because there was nothing to wait for')
  assert.equal(seen[0].cached, true, 'and it says so, so the UI can say "ready" not "downloaded"')
  assert.equal(seen[0].loaded, seen[0].total, 'a cached model is 100% downloaded')
})

test('a failed request names the status and the URL', async () => {
  const { caches, entries } = fakeCaches()
  const fetch = /** @type {any} */ (
    async () => new Response('nope', { status: 404, statusText: 'Not Found' })
  )

  await assert.rejects(
    () => downloadModel(URL_, { fetch, caches }),
    (/** @type {any} */ error) => {
      assert.match(String(error.message), /404/, 'the status is the diagnosis')
      assert.match(
        String(error.message),
        /example\.invalid/,
        'and so is the host -- a model download crosses a redirect to a CDN on ' +
          'another origin, so "404" alone does not say which host said it',
      )
      return true
    },
  )
  assert.equal(entries.size, 0, 'nothing was stored')
})

test('a connection that drops mid-download leaves nothing cached', async () => {
  const { caches, entries } = fakeCaches()
  const { fetch } = fakeFetch(model, { chunk: 2, failAfter: 4 })

  await assert.rejects(() => downloadModel(URL_, { fetch, caches }))

  assert.equal(
    entries.size,
    0,
    'a partial model is not a smaller model -- it fails to initialise whisper ' +
      'with an error that says nothing about the download that produced it',
  )
})

test('an abort stops the download and stores nothing', async () => {
  const { caches, entries } = fakeCaches()
  const { fetch } = fakeFetch(model, { chunk: 2 })
  const controller = new AbortController()

  const pending = downloadModel(URL_, {
    fetch,
    caches,
    signal: controller.signal,
    onProgress: () => controller.abort(),
  })

  await assert.rejects(() => pending, 'cancelling has to actually cancel')
  assert.equal(entries.size, 0, 'and leave the next attempt a clean start')
})

test('a truncated response that ends cleanly is still rejected', async () => {
  const { caches, entries } = fakeCaches()
  // Claims ten bytes in the header and delivers four.
  const short = new Uint8Array([1, 2, 3, 4])
  const fetch = /** @type {any} */ (
    async () =>
      new Response(short, { status: 200, headers: { 'content-length': '10' } })
  )

  await assert.rejects(
    () => downloadModel(URL_, { fetch, caches }),
    /ended early/,
    'the one failure the read loop cannot see is the one that looks like success',
  )
  assert.equal(entries.size, 0)
})

test('isModelCached answers without downloading anything', async () => {
  const { caches } = fakeCaches()

  assert.equal(await isModelCached(URL_, { caches }), false)

  const { fetch } = fakeFetch(model)
  await downloadModel(URL_, { fetch, caches })

  assert.equal(
    await isModelCached(URL_, { caches }),
    true,
    'the Transcribe button has to know whether pressing it starts a 60 MB download',
  )
})

test('a model can be deleted', async () => {
  const { caches, entries } = fakeCaches()
  const { fetch } = fakeFetch(model)
  await downloadModel(URL_, { fetch, caches })

  assert.equal(await deleteModel(URL_, { caches }), true, 'there was something to delete')
  assert.equal(entries.size, 0)
  assert.equal(await deleteModel(URL_, { caches }), false, 'and now there is not')
})
