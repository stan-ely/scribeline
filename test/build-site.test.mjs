/**
 * The one test the scaffold has, and it exists to hold one rule in place:
 * the Content-Security-Policy is DERIVED from src/core/engine.js, never typed
 * out beside it.
 *
 * That rule is easy to state and easy to break silently -- someone adds a model
 * host, the picker works locally against a warm cache, and the download fails
 * only on a cold load in production. So the assertion is made against the real
 * build's real output rather than against a reimplementation of it: this calls
 * build() from scripts/build-site.mjs and reads site/dist/index.html.
 *
 * Offline, and a couple of seconds. Nothing here touches the network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, buildCSP } from '../scripts/build-site.mjs'
import { ENGINE_ORIGINS, MODELS, DEFAULT_MODEL } from '../src/core/engine.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'site', 'dist')

test('every engine origin reaches the generated connect-src', () => {
  const csp = buildCSP(ENGINE_ORIGINS)
  const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src'))
  assert.ok(connect, 'no connect-src directive in the generated policy')

  for (const origin of ENGINE_ORIGINS) {
    assert.ok(
      connect.includes(origin),
      `${origin} is in ENGINE_ORIGINS but not in connect-src -- the policy is no longer derived from it`,
    )
  }
})

test('connect-src entries carry no path', () => {
  // A CSP source with a path restricts matching to that path prefix, and a
  // redirect drops the path -- which is exactly what a Hugging Face model
  // download does. An entry like https://huggingface.co/ggerganov/ would look
  // more precise and would fail on the redirect.
  const csp = buildCSP(ENGINE_ORIGINS)
  const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? ''

  for (const token of connect.split(/\s+/).filter((t) => t.startsWith('http'))) {
    assert.equal(
      token,
      new URL(token).origin,
      `${token} is not a bare origin; a path here fails silently on a redirect`,
    )
  }
})

test('every model URL is covered by an origin in the list', () => {
  for (const [id, model] of Object.entries(MODELS)) {
    assert.ok(
      ENGINE_ORIGINS.includes(new URL(model.url).origin),
      `model ${id} points at an origin missing from ENGINE_ORIGINS`,
    )
  }
})

test('the default model is one of the models', () => {
  assert.ok(
    Object.hasOwn(MODELS, DEFAULT_MODEL),
    `DEFAULT_MODEL is ${DEFAULT_MODEL}, which MODELS does not define`,
  )
})

test('the build writes a page with no placeholder left in it', async () => {
  const { entryFile, cssFile } = await build()

  const html = await readFile(path.join(DIST, 'index.html'), 'utf8')

  // The build throws on a leftover placeholder, so reaching this line already
  // proves most of it. Asserting anyway: the guard is a list of tokens someone
  // could shorten while removing one from the template, and this is what would
  // notice.
  for (const token of ['__CSP__', '__SCRIPT__', '__STYLES__', '__ORIGIN__']) {
    assert.ok(!html.includes(token), `${token} survived into site/dist/index.html`)
  }

  assert.ok(html.includes(entryFile), 'the script tag does not name the bundle that was built')
  assert.ok(html.includes(cssFile), 'the link tag does not name the stylesheet that was built')

  for (const origin of ENGINE_ORIGINS) {
    assert.ok(html.includes(origin), `${origin} is missing from the shipped policy`)
  }
})

test('the built page carries no absolute URL to a host it may not dial', async () => {
  // Open Graph tags are absolute by necessity and are the easiest place for a
  // stray third-party URL to appear. Anything the page fetches must be in
  // ENGINE_ORIGINS or same-origin; anything else is either a mistake or a
  // request that the policy will block.
  const html = await readFile(path.join(DIST, 'index.html'), 'utf8')
  const allowed = [...ENGINE_ORIGINS, 'https://stan-ely.com']

  // `;` is excluded from the character class because most of the URLs in the
  // page are inside the CSP meta tag, where a semicolon ends the directive and
  // is not part of the source it follows.
  const found = [...html.matchAll(/https?:\/\/[^"'\s>;]+/g)].map((m) => new URL(m[0]).origin)

  for (const origin of new Set(found)) {
    assert.ok(
      allowed.includes(origin),
      `${origin} appears in the page but is neither the deploy origin nor in ENGINE_ORIGINS`,
    )
  }
})
