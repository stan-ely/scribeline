/**
 * Builds the whisper.cpp WebAssembly engine into vendor/whisper/.
 *
 * Node-only -- checked under tsconfig.node.json, free to use fs and spawn
 * processes. Nothing under vendor/ is committed (see .gitignore): the wasm is
 * megabytes, it is reproducible from a pinned tag plus the two files in
 * whisper/, and a copy in this history would be a second source of truth that
 * ages badly.
 *
 * WHY THIS BUILDS RATHER THAN DOWNLOADS. Upstream's emscripten binding exposes
 * `full_default`, which returns 0 or -1 and prints the transcript through a
 * printf callback. It cannot return a timestamp. This application is built
 * around words carrying their own timings -- see src/core/transcript.js -- so
 * the ~40 lines in whisper/emscripten.cpp are the difference between this app
 * and a different, worse one. The prebuilt alternatives on npm all require
 * SharedArrayBuffer, which the deploy host cannot provide.
 *
 * TWO VARIANTS ARE BUILT AND ONLY ONE EVER RUNS IN PRODUCTION:
 *
 *   whisper.js     single-threaded. Runs anywhere. This is what the deployed
 *                  page loads, because GitHub Pages sends no COOP/COEP.
 *   whisper-mt.js  threaded. Needs SharedArrayBuffer, so it needs a
 *                  cross-origin-isolated page -- which locally means `npm
 *                  start` and in production means a different host.
 *
 * Usage:
 *   node scripts/fetch-whisper.mjs             # both variants
 *   node scripts/fetch-whisper.mjs --single    # just the one that ships
 *   node scripts/fetch-whisper.mjs --clean     # discard the checkout first
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rm, copyFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The whisper.cpp release this engine is built from.
 *
 * Pinned, not tracked. `master` would mean the transcript the app produces
 * could change between two builds of the same commit of this repository, and
 * the two files in whisper/ replace upstream files -- so an upstream change to
 * either is something to review deliberately, not to receive silently.
 */
const WHISPER_TAG = 'v1.9.3'

/**
 * The emscripten toolchain, also pinned.
 *
 * Emscripten's output is a moving target: the flags in whisper/CMakeLists.txt
 * are correct for this image, and DYNAMIC_EXECUTION=0 in particular is the kind
 * of guarantee a compiler release can quietly change.
 */
const EMSDK_IMAGE = 'emscripten/emsdk:4.0.17'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OVERLAY = path.join(ROOT, 'whisper')
const VENDOR = path.join(ROOT, 'vendor', 'whisper')
const CHECKOUT = path.join(VENDOR, 'whisper.cpp')

/** The files in whisper/ that replace their namesakes in the checkout. */
const OVERLAY_FILES = ['emscripten.cpp', 'CMakeLists.txt']

/** Where the overlay files go, relative to the checkout root. */
const OVERLAY_TARGET = path.join('examples', 'whisper.wasm')

/**
 * Run a command, inheriting stdio, and throw on a non-zero exit.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
  }
}

/**
 * Run a command and capture its output, returning null if it could not run at
 * all. Used only for probing.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {string | null}
 */
function probe(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) return null
  return String(result.stdout ?? '').trim()
}

/**
 * How the emscripten build will be run.
 *
 * A native toolchain is preferred when one is present, because it is several
 * times faster than the same build inside a container. Docker is the fallback
 * and, on a machine without emsdk installed, the only route -- which is most
 * machines, including the one this was written on.
 *
 * @returns {{ kind: 'native' } | { kind: 'docker' }}
 */
function chooseRunner() {
  if (probe('emcmake', ['--version']) !== null || process.env.EMSDK) {
    return { kind: 'native' }
  }

  const docker = probe('docker', ['info', '--format', '{{.ServerVersion}}'])
  if (docker !== null) return { kind: 'docker' }

  // Both routes named, rather than a spawn error naming whichever was tried
  // last. Someone hitting this has to choose between installing a toolchain and
  // starting a daemon, and the message is the only place that choice is
  // written down.
  throw new Error(
    [
      'No way to build the engine.',
      '',
      'This needs emscripten. Either:',
      '  - install emsdk and put emcmake on PATH (fastest), or',
      `  - start Docker, which will be used to run ${EMSDK_IMAGE}.`,
      '',
      'Docker appears to be installed but its daemon is not reachable if you',
      'see this immediately after installing it -- start Docker Desktop first.',
      '',
      'Everything except transcription works without this: `npm test`,',
      '`npm run build`, and `npm start` all succeed with vendor/whisper/ absent.',
    ].join('\n'),
  )
}

/**
 * Clone the pinned tag, or reuse an existing checkout at the same tag.
 *
 * Shallow, single-tag: the full history is a few hundred megabytes and nothing
 * here reads it.
 */
async function checkout() {
  const existing = probe('git', ['-C', CHECKOUT, 'describe', '--tags', '--exact-match'])
  if (existing === WHISPER_TAG) {
    console.log(`whisper.cpp ${WHISPER_TAG} already checked out`)
    // Reset first: the overlay below overwrites tracked files, so a reused
    // checkout still carries the previous run's changes and `git diff` would
    // report nothing.
    run('git', ['-C', CHECKOUT, 'checkout', '--', '.'])
    return
  }

  await rm(CHECKOUT, { recursive: true, force: true })
  await mkdir(VENDOR, { recursive: true })
  console.log(`Cloning whisper.cpp ${WHISPER_TAG}...`)
  run('git', [
    'clone',
    '--depth', '1',
    '--branch', WHISPER_TAG,
    // Checked out verbatim. With git's Windows default of autocrlf=true every
    // file arrives with CRLF, which changes the bytes the build compiles and
    // makes any exact-match edit of an upstream file fail for a reason that
    // looks like upstream having changed.
    '--config', 'core.autocrlf=false',
    'https://github.com/ggml-org/whisper.cpp',
    CHECKOUT,
  ])
}

/**
 * Make whisper.cpp's unconditional `-pthread` conditional.
 *
 * WITHOUT THIS THERE IS ONLY ONE BUILD. whisper.cpp's top-level CMakeLists.txt
 * adds `-pthread` to CMAKE_C_FLAGS and CMAKE_CXX_FLAGS for every emscripten
 * build, with a TODO explaining that it is there to stop wasm-ld complaining
 * about shared memory. The effect is that link flags cannot turn threading off:
 * the objects are already compiled for it. Before this edit the two variants
 * came out as byte-identical wasm, both requiring SharedArrayBuffer -- so the
 * "single-threaded" build was single-threaded in name only and would have
 * failed on the deploy host, which is the only host it exists for.
 *
 * A targeted replacement rather than a third full-file overlay: the file is
 * three hundred lines of which two matter, and carrying the other two hundred
 * and ninety-eight would mean re-reviewing them on every upstream bump. The
 * exact text is asserted, so an upstream edit to these lines fails the build
 * here rather than silently producing one build twice.
 */
async function makePthreadsOptional() {
  const file = path.join(CHECKOUT, 'CMakeLists.txt')
  const source = await readFile(file, 'utf8')

  // Line endings are not assumed. A checkout on Windows arrives with CRLF
  // unless git was configured otherwise, and a match written with \n silently
  // fails against it -- which is exactly what the assertion below would then
  // report as "upstream moved these lines", sending the reader to look at a
  // file that has not changed at all.
  const pattern =
    /( *)set\(CMAKE_C_FLAGS {3}"\$\{CMAKE_C_FLAGS} {3}-pthread"\)(\r?\n) *set\(CMAKE_CXX_FLAGS "\$\{CMAKE_CXX_FLAGS} -pthread"\)/

  const found = source.match(pattern)
  if (!found) {
    throw new Error(
      `Could not find whisper.cpp's unconditional -pthread flags in CMakeLists.txt.\n` +
        `They have moved or changed since ${WHISPER_TAG}. Without this edit both\n` +
        `builds come out identical and both need SharedArrayBuffer -- so the\n` +
        `single-threaded fallback would not actually be one. Check the file and\n` +
        `update the pattern in makePthreadsOptional().`,
    )
  }

  const [block, indent, eol] = found
  const patched = `${indent}if (SCRIBELINE_THREADS)${eol}${block}${eol}${indent}endif()`

  await writeFile(file, source.replace(block, patched))
}

/**
 * Copy whisper/*.{cpp,txt} over their upstream namesakes, and record the diff.
 *
 * A full-file overlay rather than a patch applied with `git apply`. A context
 * diff against a pinned tag fails to apply for reasons that have nothing to do
 * with intent -- a line of whitespace upstream, a CRLF checkout on Windows --
 * and the failure arrives as a rejected hunk rather than as a compile error.
 * Copying always works; what it costs is reviewability, and that is bought back
 * by writing the real diff to upstream.diff on every build.
 */
async function overlay() {
  for (const file of OVERLAY_FILES) {
    await copyFile(path.join(OVERLAY, file), path.join(CHECKOUT, OVERLAY_TARGET, file))
  }
  await makePthreadsOptional()

  const diff = spawnSync('git', ['-C', CHECKOUT, 'diff'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const text = String(diff.stdout ?? '')
  await writeFile(path.join(VENDOR, 'upstream.diff'), text)

  if (text.trim() === '') {
    // Not fatal, but it means the overlay changed nothing -- either the files
    // are byte-identical to upstream (in which case the binding is unpatched
    // and there will be no timestamps) or they landed somewhere else.
    console.warn(
      'WARNING: the overlay produced an empty diff. The binding may be unpatched,\n' +
        'which builds fine and returns a transcript with every timing set to zero.',
    )
  } else {
    console.log(`Overlay applied (${text.split('\n').length} diff lines -> vendor/whisper/upstream.diff)`)
  }
}

/**
 * The shell for one variant: configure, compile, and collect.
 *
 * Returned as a string rather than run, because the Docker path builds every
 * variant inside a single container and there is no reason for the two runners
 * to disagree about what a build is.
 *
 * @param {{ name: string, threads: boolean }} variant
 * @returns {string}
 */
function buildCommand({ name, threads }) {
  const buildDir = `build-${name}`

  const configure = [
    'emcmake', 'cmake', '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DSCRIBELINE_THREADS=${threads ? 'ON' : 'OFF'}`,
    `-DSCRIBELINE_OUTPUT_NAME=${name}`,
    // The wasm as its own file rather than base64 inside the JS. Embedding
    // inflates it by a third and makes the binary uncacheable independently of
    // the glue, which changes far more often than it does.
    '-DWHISPER_WASM_SINGLE_FILE=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
  ].join(' ')

  // Collected into one directory by the build itself. Where cmake puts its
  // output has moved between whisper.cpp releases, and a `find` on this side of
  // the container boundary is far simpler than teaching the host to look into
  // one.
  const collect =
    `mkdir -p ${ARTIFACT_DIR}\n` +
    // -type f is not belt-and-braces: upstream's example lives in a DIRECTORY
    // called examples/whisper.wasm, which matches the name being searched for
    // and which cp then refuses to copy.
    `find ${buildDir} -type f \\( -name '${name}.js' -o -name '${name}.wasm' -o -name '${name}.worker.js' \\) ` +
    `-exec cp {} ${ARTIFACT_DIR}/ \\;`

  return [configure, `cmake --build ${buildDir} --target libmain -j`, collect].join('\n')
}

/** Where each build drops what it produced, inside the checkout. */
const ARTIFACT_DIR = 'scribeline-out'

/**
 * Run every variant's build.
 *
 * THE DOCKER PATH DELIBERATELY DOES NOT BIND-MOUNT. A `-v` mount requires the
 * host directory to be listed under Docker Desktop's file sharing, which it is
 * not by default outside the user profile's standard folders -- the failure is
 * `the path ... is not shared from the host`, which is a settings dialog away
 * and not something a build script should require someone to find. `docker cp`
 * needs no such configuration, works identically on every platform, and makes
 * the build hermetic: nothing the container does can touch the working tree.
 *
 * One container builds every variant, because the copy in is the expensive part.
 *
 * @param {Array<{ name: string, threads: boolean }>} variants
 * @param {{ kind: 'native' | 'docker' }} runner
 */
async function runBuilds(variants, runner) {
  for (const variant of variants) {
    console.log(`  ${variant.name}: ${variant.threads ? 'threaded' : 'single-threaded'}`)
  }

  const out = path.join(CHECKOUT, ARTIFACT_DIR)
  await rm(out, { recursive: true, force: true })

  // The script goes into a FILE inside the checkout rather than into an
  // argument. Passing a multi-line shell script as an argv entry means every
  // layer between here and the container has to agree about quoting -- and on
  // Windows they do not: Node's `shell: true` concatenates argv without
  // escaping, so a script with spaces in it arrives as forty separate
  // arguments and `docker create` fails with nothing useful to say. A file has
  // no quoting at all, and it is copied in with everything else.
  const scriptName = 'scribeline-build.sh'
  await writeFile(
    path.join(CHECKOUT, scriptName),
    ['set -eu', ...variants.map(buildCommand)].join('\n') + '\n',
  )

  if (runner.kind === 'native') {
    run('sh', [scriptName], { cwd: CHECKOUT })
  } else {
    const id = probe('docker', ['create', '-w', '/src', EMSDK_IMAGE, 'sh', scriptName])
    if (!id) throw new Error('docker create failed')

    try {
      console.log('Copying the checkout into the container...')
      run('docker', ['cp', `${CHECKOUT}${path.sep}.`, `${id}:/src`])
      run('docker', ['start', '--attach', id])
      run('docker', ['cp', `${id}:/src/${ARTIFACT_DIR}`, CHECKOUT])
    } finally {
      // Removed even when the build failed: a stopped container holding a
      // copy of the checkout is a few hundred megabytes that nothing will ever
      // look at again.
      spawnSync('docker', ['rm', '-f', id])
    }
  }

  /** @type {string[]} */
  const copied = []
  for (const file of await readdir(out)) {
    await copyFile(path.join(out, file), path.join(VENDOR, file))
    copied.push(file)
  }

  for (const variant of variants) {
    if (!copied.includes(`${variant.name}.js`)) {
      throw new Error(
        `The build finished but produced no ${variant.name}.js. Check the emscripten output above.`,
      )
    }
  }

  console.log(`\n-> vendor/whisper/{${copied.join(', ')}}`)
  return copied
}

/** @param {string} file */
async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 16)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--clean')) await rm(CHECKOUT, { recursive: true, force: true })

  const runner = chooseRunner()
  console.log(`Building with ${runner.kind === 'native' ? 'a local emsdk' : `Docker (${EMSDK_IMAGE})`}`)

  await mkdir(VENDOR, { recursive: true })
  await checkout()
  await overlay()

  const variants = [{ name: 'whisper', threads: false }]
  if (!args.includes('--single')) variants.push({ name: 'whisper-mt', threads: true })

  console.log('\n=== Building')
  const files = await runBuilds(variants, runner)

  // Recorded so a stale artifact is detectable. The overlay hashes matter most:
  // editing whisper/emscripten.cpp and forgetting to rebuild leaves an engine
  // that behaves like the previous version of a file that is no longer on disk.
  /** @type {Record<string, string>} */
  const sources = {}
  for (const file of OVERLAY_FILES) sources[file] = await sha256(path.join(OVERLAY, file))

  /** @type {Record<string, number>} */
  const sizes = {}
  for (const file of files) sizes[file] = (await stat(path.join(VENDOR, file))).size

  await writeFile(
    path.join(VENDOR, 'build.json'),
    JSON.stringify(
      { tag: WHISPER_TAG, emsdk: EMSDK_IMAGE, builtAt: new Date().toISOString(), sources, sizes },
      null,
      2,
    ) + '\n',
  )

  console.log('\nEngine built into vendor/whisper/. `npm run build` will copy it into site/dist/.')
}

await main()
