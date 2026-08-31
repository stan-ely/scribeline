/**
 * Builds site/dist/: the static bundle that gets deployed.
 *
 * Everything here is Node-only -- this file is checked under tsconfig.node.json,
 * not tsconfig.json, and unlike src/web/ it is free to use fs, path, and http.
 * Nothing under site/dist/ is committed; it is generated fresh by
 * `npm run build`.
 *
 * Run with `--serve` to also serve the result on http://localhost:4173.
 * localhost counts as a secure context even over plain HTTP, so WebCrypto, the
 * microphone, and the file picker all behave there as they would over real
 * HTTPS.
 *
 * CROSS-ORIGIN ISOLATION, WHICH IS THE ONE THING TO KNOW ABOUT THIS BUILD:
 * threaded whisper.cpp inference needs SharedArrayBuffer, which a browser only
 * exposes to a cross-origin-isolated page, which requires two response headers
 * (COOP and COEP). Those live in site/_headers. That file is read by Cloudflare
 * Pages and Netlify and is NOT read by GitHub Pages, which serves no custom
 * headers -- so on the current deploy target the shipped app is single-threaded
 * no matter what is written here. The dev server below DOES send them, so
 * `npm start` is faster than production, which is the wrong way round and is
 * exactly why it is written down. Resolving it means moving hosts or injecting
 * the headers from a service worker; neither is a scaffold-sized decision.
 */

import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, copyFile, rm, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENGINE_ORIGINS } from '../src/core/engine.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SITE = path.join(ROOT, 'site')
const DIST = path.join(SITE, 'dist')

/**
 * The deployed origin, in one place.
 *
 * Its consumer is the absolute URLs in site/index.html's Open Graph tags, which
 * crawlers fetch with no document to resolve a relative path against. Those tags
 * carry an __ORIGIN__ placeholder rather than the domain typed out a second
 * time: two copies of one fact drift the first time only one is edited, and here
 * the drift is silent, because a wrong og:url is invisible until someone else
 * pastes the link somewhere.
 *
 * No custom domain is bound yet. When one is, this constant changes and a CNAME
 * file joins the build -- both in this file, which is the point of it being a
 * constant.
 */
const ORIGIN = 'https://stan-ely.github.io/scribeline'

/**
 * The Content-Security-Policy, as a single generated string.
 *
 * connect-src is built from ENGINE_ORIGINS -- every host src/core/engine.js may
 * fetch model weights from -- rather than typed out by hand a second time here.
 * Two lists that must agree but are not the same list drift, and this drift is
 * silent in the worst direction: a model added to the picker and not to the
 * policy fails only on a cold load, only in production.
 *
 * Each entry is already reduced to an origin by that module. A connect-src entry
 * carrying a path would restrict matching to that path prefix, and Hugging Face
 * redirects `resolve/` downloads to a different origin entirely -- a redirect
 * drops the path, so a path-scoped entry would fail in a way that looks like a
 * network error.
 *
 * script-src is 'self' only, and can honestly stay that way: everything the page
 * loads is bundled into this origin's own output. Nothing is pulled from a CDN
 * at runtime, so no third party can serve JavaScript into a page that is holding
 * someone's recording.
 *
 * script-src also needs 'wasm-unsafe-eval'. That directive has an alarming name
 * and a narrow meaning: it permits WebAssembly compilation and nothing else --
 * not eval, not new Function. Without it the whisper module cannot be
 * instantiated at all. Granting it is the entire premise of the app; granting
 * plain 'unsafe-eval' would not be.
 *
 * style-src keeps 'unsafe-inline' for the waveform playhead, whose position is a
 * custom property written every animation frame. There is no static value to
 * give it instead, and style injection is a far smaller problem than script
 * injection.
 *
 * media-src allows blob: for audio the user opens locally, which is handed to
 * the player as an object URL and never uploaded anywhere.
 *
 * frame-ancestors is deliberately absent from this tag: browsers only honour it
 * as an HTTP response header, never inside a <meta> tag, so putting it here
 * would be a comment that looks like protection. site/_headers sets it for hosts
 * that read that file, and site/main.js refuses to run inside a frame
 * regardless -- so the protection does not depend on the host's cooperation.
 *
 * @param {readonly string[]} engineOrigins
 * @returns {string}
 */
export function buildCSP(engineOrigins) {
  const origins = [...new Set(engineOrigins.map((u) => new URL(u).origin))]
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'wasm-unsafe-eval'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `media-src 'self' blob:`,
    `worker-src 'self' blob:`,
    `connect-src 'self' blob: ${origins.join(' ')}`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `object-src 'none'`,
  ]
  // Semicolon-joined and collapsed to one line: a <meta> content attribute
  // tolerates newlines, but keeping it one line avoids any doubt about how a
  // particular parser treats whitespace inside an attribute value.
  return directives.join('; ') + ';'
}

/**
 * Bundles site/main.js with esbuild's JS API -- never the CLI, which would make
 * this script depend on a separately installed binary rather than on a
 * devDependency.
 *
 * `splitting: true` produces a single file today, because nothing is
 * dynamically imported yet. It is on from the start because the thing that will
 * be dynamically imported is the whisper glue, and the whole reason to load that
 * lazily is so a visitor who never opens a file never downloads it. Turning
 * splitting on at that point would be a build change tangled up in a feature
 * change.
 *
 * Output names are content-hashed so a redeploy is never served stale out of a
 * browser or CDN cache under an old name; index.html's script tag is rewritten
 * to match after the build.
 *
 * Source maps ship on purpose. The page's claim is that the audio never leaves
 * the machine, and that is not a claim anyone can check by reading minified
 * output. A source map makes the deployed bundle legible in devtools, so the
 * claim can be verified against the code actually running rather than against
 * the code in this repository. Every line of it is public already.
 */
async function bundle() {
  const result = await esbuild.build({
    entryPoints: [path.join(SITE, 'main.js')],
    outdir: DIST,
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'esm',
    target: ['es2022'],
    splitting: true,
    entryNames: '[name].[hash]',
    // Not 'chunk-[name]': esbuild already names shared split chunks "chunk", so
    // that prefix would produce chunk-chunk.HASH.js.
    chunkNames: '[name].[hash]',
    metafile: true,
    absWorkingDir: ROOT,
  })

  const mainJsRel = path
    .relative(ROOT, path.join(SITE, 'main.js'))
    .split(path.sep)
    .join('/')

  /** @type {string | null} */
  let entryOutput = null
  for (const [outFile, info] of Object.entries(result.metafile.outputs)) {
    if (info.entryPoint === mainJsRel) {
      entryOutput = outFile
      break
    }
  }
  if (!entryOutput) throw new Error('esbuild did not report an output for site/main.js')

  return {
    // Filename only: index.html's script src is relative to site/dist/.
    entryFile: path.basename(entryOutput),
    outputs: Object.keys(result.metafile.outputs),
  }
}

/**
 * Builds site/dist/ and returns what landed in it.
 *
 * Exported so test/build-site.test.mjs can run the real build rather than a
 * reimplementation of it -- the assertions worth making here (the CSP names
 * every engine origin, no placeholder survives) are about the output, and a test
 * that rebuilt the output itself would assert nothing about this file.
 *
 * @returns {Promise<{ entryFile: string, cssFile: string, outputs: string[] }>}
 */
export async function build() {
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  const { entryFile, outputs } = await bundle()

  // Content-hashed exactly like the JS. Hosts commonly serve static files with a
  // short max-age, so for a few minutes after a deploy a returning visitor can
  // hold a cached stylesheet against freshly fetched HTML -- new markup with the
  // previous stylesheet, which does not degrade gracefully. A hashed name makes
  // that pairing impossible: HTML naming styles.<hash>.css can only be served
  // the stylesheet it was built against.
  const css = await readFile(path.join(SITE, 'styles.css'), 'utf8')
  const cssFile = `styles.${createHash('sha256').update(css).digest('hex').slice(0, 8).toUpperCase()}.css`
  await writeFile(path.join(DIST, cssFile), css)

  await copyFile(path.join(SITE, '_headers'), path.join(DIST, '_headers'))

  const csp = buildCSP(ENGINE_ORIGINS)
  const template = await readFile(path.join(SITE, 'index.html'), 'utf8')

  // replaceAll, not replace: a placeholder may appear more than once, and
  // `String.replace` with a string argument substitutes only the first. The
  // guard below is what turns that class of mistake into a failed build rather
  // than a page shipped with a literal __ORIGIN__ in an href, so the two belong
  // together.
  const html = template
    .replaceAll('__CSP__', csp)
    .replaceAll('__SCRIPT__', entryFile)
    .replaceAll('__STYLES__', cssFile)
    .replaceAll('__ORIGIN__', ORIGIN)

  const leftover = ['__CSP__', '__SCRIPT__', '__STYLES__', '__ORIGIN__'].filter((t) =>
    html.includes(t),
  )
  if (leftover.length) {
    throw new Error(
      `site/index.html placeholder(s) not replaced: ${leftover.join(', ')} -- check the token still exists in the template`,
    )
  }

  await writeFile(path.join(DIST, 'index.html'), html)

  return { entryFile, cssFile, outputs }
}

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

async function serveDist() {
  const PORT = 4173

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let filePath = path.join(DIST, decodeURIComponent(url.pathname))
      if (url.pathname === '/') filePath = path.join(DIST, 'index.html')

      // Path traversal: decodeURIComponent can produce '..' segments that
      // path.join then resolves out of DIST. This serves a directory of public
      // files on loopback, so the exposure is small, but "small" is not a reason
      // to serve arbitrary files off the developer's disk.
      if (path.relative(DIST, filePath).startsWith('..')) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      const info = await stat(filePath).catch(() => null)
      if (!info || !info.isFile()) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      // The two headers that make SharedArrayBuffer -- and therefore threaded
      // inference -- available. They mirror site/_headers, which the deploy host
      // may or may not read. See this file's header comment: the practical
      // effect is that local development is cross-origin isolated and production
      // currently is not, so anything conditional on `crossOriginIsolated` must
      // be exercised with them removed before it is believed.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      res.setHeader('Content-Type', MIME[path.extname(filePath)] ?? 'application/octet-stream')
      createReadStream(filePath).pipe(res)
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })

  await new Promise((resolve) => server.listen(PORT, () => resolve(undefined)))
  console.log(
    `Serving site/dist/ at http://localhost:${PORT} (secure context: yes, via localhost; cross-origin isolated: yes)`,
  )
}

// Run the build only when invoked as a script (`node scripts/build-site.mjs`),
// not when imported -- test/build-site.test.mjs calls build() itself.
if (import.meta.filename === process.argv[1]) {
  const { entryFile, outputs } = await build()
  console.log(
    `Built site/dist/ (${outputs.length} output${outputs.length === 1 ? '' : 's'}, entry: ${entryFile})`,
  )
  if (process.argv.includes('--serve')) await serveDist()
}
