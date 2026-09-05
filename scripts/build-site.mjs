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
 * (COOP and COEP). Those live in site/_headers. That file is read by Netlify and
 * Cloudflare Pages and is NOT read by GitHub Pages, which serves no custom
 * headers at all.
 *
 * So the engine that loads is decided by the host, and both have to work. The
 * dev server below sends the headers, so `npm start` is isolated and runs the
 * threaded build. A host that ignores _headers gets the single-threaded one,
 * which is several times slower and is the path nothing exercises unless
 * somebody deliberately removes the two setHeader calls and tries it.
 *
 * The CSP itself is unaffected by any of this: it is delivered in a <meta> tag
 * generated below, so it survives a host that sets no headers whatsoever.
 */

import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, copyFile, readdir, rm, mkdir, stat } from 'node:fs/promises'
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
 * NOTE THE HOST: this is stan-ely.com, not stan-ely.github.io. The account's
 * user Pages site carries a custom domain, and project Pages sites inherit it,
 * so this repository is served from a path under that domain without anything
 * in this repository asking for it. No CNAME file is written here -- the
 * binding belongs to the user site, and one written from this build would be
 * a second claim on the same domain.
 *
 * It is a path, not a bare origin, and that is deliberate rather than sloppy:
 * a project Pages site lives under /scribeline/, so og:url must carry it or
 * the link resolves to the user site's homepage.
 */
const ORIGIN = 'https://stan-ely.com/scribeline'

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
 * Bundle one entry point with esbuild's JS API -- never the CLI, which would
 * make this script depend on a separately installed binary rather than on a
 * devDependency.
 *
 * `splitting: true` is on although each entry currently produces one file. The
 * thing that gets dynamically imported is the whisper glue, which the worker
 * loads by URL at runtime rather than through the bundler, so splitting earns
 * its keep the moment anything else is loaded lazily.
 *
 * Output names are content-hashed so a redeploy is never served stale out of a
 * browser or CDN cache under an old name; index.html's script tag is rewritten
 * to match after the build, and the worker's name is substituted into the page's
 * bundle.
 *
 * Source maps ship on purpose. The page's claim is that the audio never leaves
 * the machine, and that is not a claim anyone can check by reading minified
 * output. A source map makes the deployed bundle legible in devtools, so the
 * claim can be verified against the code actually running rather than against
 * the code in this repository. Every line of it is public already.
 *
 * @param {string} entry absolute path to the entry module
 * @param {Record<string, string>} [define]
 * @returns {Promise<{ file: string, outputs: string[] }>}
 */
async function bundleEntry(entry, define = {}) {
  const result = await esbuild.build({
    entryPoints: [entry],
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
    define,
  })

  const entryRel = path.relative(ROOT, entry).split(path.sep).join('/')

  /** @type {string | null} */
  let output = null
  for (const [outFile, info] of Object.entries(result.metafile.outputs)) {
    if (info.entryPoint === entryRel) {
      output = outFile
      break
    }
  }
  if (!output) throw new Error(`esbuild did not report an output for ${entryRel}`)

  // Filename only: everything that references these is relative to site/dist/.
  return { file: path.basename(output), outputs: Object.keys(result.metafile.outputs) }
}

/**
 * Bundle the page and the transcription worker.
 *
 * TWO PASSES, AND THE ORDER MATTERS. The worker is built first because the page
 * has to name it, and its name carries a content hash that does not exist until
 * it has been built. The name is then handed to the page's build as a `define`,
 * which is the same discipline index.html's placeholders use: one fact, written
 * once, substituted in -- rather than a filename typed out in two files that
 * must agree, where the drift is a worker that 404s only after a redeploy.
 *
 * The cost of two passes is that the page and the worker do not share a split
 * chunk. They share almost nothing anyway -- the worker's only import from this
 * repository is the adapter -- and a shared chunk between a document and a
 * worker would be fetched twice regardless.
 */
async function bundle() {
  const worker = await bundleEntry(path.join(SITE, 'whisper-worker.js'))
  const main = await bundleEntry(path.join(SITE, 'main.js'), {
    __WHISPER_WORKER__: JSON.stringify(worker.file),
  })

  return {
    entryFile: main.file,
    workerFile: worker.file,
    outputs: [...worker.outputs, ...main.outputs],
  }
}

/**
 * Copy the built whisper engine into the bundle, if it has been built.
 *
 * ABSENCE IS NOT AN ERROR. The engine is produced by
 * `node scripts/fetch-whisper.mjs`, which needs emscripten -- through Docker,
 * on most machines. Making the site build depend on that would mean every
 * clone, every CI run, and every change to a stylesheet needed a wasm
 * toolchain. The page copes: it reports that the engine is not built and
 * everything except transcription works.
 *
 * @returns {Promise<string[]>} the files copied
 */
async function copyEngine() {
  const from = path.join(ROOT, 'vendor', 'whisper')
  const entries = await readdir(from).catch(() => null)
  if (!entries) return []

  // Filtered before the directory is created, so a vendor/ holding only the
  // build's own scratch -- the checkout it cloned, the diff it wrote -- does not
  // leave an empty whisper/ in the bundle looking like a half-finished copy.
  const engine = entries.filter((entry) => /\.(js|wasm)$/.test(entry))
  if (engine.length === 0) return []

  const to = path.join(DIST, 'whisper')
  await mkdir(to, { recursive: true })
  for (const entry of engine) {
    await copyFile(path.join(from, entry), path.join(to, entry))
  }
  return engine
}

/**
 * Builds site/dist/ and returns what landed in it.
 *
 * Exported so test/build-site.test.mjs can run the real build rather than a
 * reimplementation of it -- the assertions worth making here (the CSP names
 * every engine origin, no placeholder survives) are about the output, and a test
 * that rebuilt the output itself would assert nothing about this file.
 *
 * @returns {Promise<{ entryFile: string, workerFile: string, cssFile: string, engineFiles: string[], outputs: string[] }>}
 */
export async function build() {
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  const { entryFile, workerFile, outputs } = await bundle()
  const engineFiles = await copyEngine()

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

  return { entryFile, workerFile, cssFile, engineFiles, outputs }
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
  const { entryFile, outputs, engineFiles } = await build()
  console.log(
    `Built site/dist/ (${outputs.length} output${outputs.length === 1 ? '' : 's'}, entry: ${entryFile})`,
  )
  console.log(
    engineFiles.length
      ? `Engine: ${engineFiles.join(', ')}`
      : 'Engine: not built -- run `node scripts/fetch-whisper.mjs`. Everything except transcription works without it.',
  )
  if (process.argv.includes('--serve')) await serveDist()
}
