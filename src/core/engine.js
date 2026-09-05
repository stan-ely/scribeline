/**
 * Where the transcription engine and its weights come from.
 *
 * This file is data, not behaviour, and it exists before the code that uses it
 * for one reason: scripts/build-site.mjs derives the page's
 * Content-Security-Policy `connect-src` from `ENGINE_ORIGINS` below. The list of
 * hosts the app may dial and the list of hosts the policy permits are the same
 * list, read from one place, rather than two lists that must agree.
 *
 * Two lists that must agree but are not the same list drift the first time only
 * one of them is edited, and here the drift is silent in the worst direction: a
 * model added to the picker and not to the policy fails at download time, in
 * production, on a network the developer was not using.
 *
 * Isomorphic: no DOM, no fs. Checked under both tsconfig projects.
 */

/**
 * The whisper.cpp WebAssembly build is served from our own origin, not a CDN.
 *
 * That is a deliberate constraint rather than a preference. Threaded inference
 * needs `SharedArrayBuffer`, which needs cross-origin isolation, which means
 * shipping `Cross-Origin-Embedder-Policy: require-corp` -- and under that
 * policy every cross-origin subresource must opt in with CORP or CORS headers
 * we do not control. A same-origin wasm binary sidesteps the whole question.
 *
 * The files are not committed (see .gitignore); scripts/fetch-whisper.mjs
 * builds them there. Same-origin, so they contribute no CSP entry.
 *
 * WHAT IS LOADED IS THE JS GLUE, NOT THE WASM. Emscripten emits a loader that
 * fetches and instantiates the binary beside it; the `.wasm` is never fetched
 * by this application's own code. An earlier version of this file named
 * `whisper.wasm` directly, which would have failed at the first `import()`.
 *
 * THE PATH IS RELATIVE, AND THAT IS THE LOAD-BEARING PART. This app deploys to
 * a project Pages site under a path -- see ORIGIN in scripts/build-site.mjs,
 * which is `https://stan-ely.com/scribeline`, not a bare domain. A leading
 * slash here resolves to the domain root, so an absolute path 404s in
 * production and works in every local test, which is the worst available
 * combination. Callers resolve these against `import.meta.url`.
 */
export const ENGINE_DIR = 'whisper/'

/**
 * The two builds, and which one a page may use.
 *
 * `threaded` needs `SharedArrayBuffer` and therefore a cross-origin-isolated
 * page. `single` needs nothing and is slower by roughly an order of magnitude.
 *
 * BOTH ARE SHIPPED, AND WHICH ONE LOADS IS THE HOST'S DECISION, not this
 * application's. A host that reads site/_headers (Netlify, Cloudflare Pages)
 * sends COOP/COEP and gets `threaded`; one that does not (GitHub Pages) gets
 * `single`, as does any browser without SharedArrayBuffer.
 *
 * `single` is therefore the branch that nothing exercises by default -- the dev
 * server sends the headers, so local development always takes the other one.
 * It is a real code path with real users behind it, and the only way to know it
 * works is to remove those headers and run it.
 *
 * @type {Readonly<{ threaded: string, single: string }>}
 */
export const ENGINE_FILES = Object.freeze({
  threaded: 'whisper-mt.js',
  single: 'whisper.js',
})

/**
 * Which build this page may load.
 *
 * @param {boolean} isolated whether the page is cross-origin isolated
 * @returns {string} a path relative to the bundle
 */
export function engineFile(isolated) {
  return ENGINE_DIR + (isolated ? ENGINE_FILES.threaded : ENGINE_FILES.single)
}

/**
 * The GGML weights, by model id.
 *
 * `bytes` is here so the UI can say how large a download it is about to start
 * before starting it -- on a phone, on cellular, the difference between tiny
 * and small is the difference between "fine" and "not now". The numbers are the
 * published sizes of the quantized q5_1 builds and are checked by nothing;
 * treat them as labels, not as a length to validate a response against.
 *
 * English-only variants (`.en`) are meaningfully better than the multilingual
 * ones at the same size, which is why the small end of this list is `.en` and
 * the large end is not.
 *
 * Downloaded once and kept in the Cache API, keyed by URL. Nothing here is
 * committed to the repository -- the weights are tens of megabytes and belong
 * to whisper.cpp's release artifacts, not to this history.
 */
export const MODELS = {
  'tiny.en': {
    label: 'Tiny (English)',
    bytes: 32_200_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin',
  },
  'base.en': {
    label: 'Base (English)',
    bytes: 60_000_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin',
  },
  'small.en': {
    label: 'Small (English)',
    bytes: 190_000_000,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin',
  },
}

/** The default when the user has not chosen. Small enough to download over a
 * phone connection without the choice feeling like a commitment. */
export const DEFAULT_MODEL = 'base.en'

/**
 * Every origin the page may open a network connection to, deduped.
 *
 * Derived from `MODELS` rather than typed out, and consumed by the CSP
 * generator in scripts/build-site.mjs. `new URL(u).origin` reduces each entry
 * to scheme://host[:port], which is the granularity connect-src wants -- a path
 * in a CSP source is honoured but a redirect drops it, and Hugging Face
 * redirects model downloads to its CDN.
 *
 * Which is worth stating plainly, because it is the next thing to trip over:
 * the redirect target is a different origin, so it needs its own entry here the
 * moment a download is attempted from a page that enforces this policy.
 *
 * @type {readonly string[]}
 */
export const ENGINE_ORIGINS = Object.freeze([
  ...new Set([
    ...Object.values(MODELS).map((m) => new URL(m.url).origin),

    // THE REDIRECT TARGETS, which are not derivable from the URLs above --
    // they only ever appear in a Location header. These are the entries in
    // this file written out by hand, and they are the ones that break.
    //
    // Hugging Face has moved `resolve/` downloads onto Xet storage: a download
    // that used to land on cdn-lfs.huggingface.co now redirects to
    // `<region>.aws.cdn.hf.co`. A CSP blocks a redirect to an origin it does
    // not name, and the fetch fails with "Failed to fetch" and a console
    // violation -- which is what happened the first time this was tried
    // against a real network, exactly as the comment above predicted.
    //
    // The wildcard is deliberate: the subdomain carries the region the client
    // is served from, so naming one host would work in the country it was
    // tested in and fail elsewhere. A CSP host wildcard matches one or more
    // leading labels, so this covers `us.aws.` as well as any other region.
    'https://*.cdn.hf.co',
    // The other Xet hostname, used by some repositories rather than the
    // regional CDN above.
    'https://cas-bridge.xethub.hf.co',
    // The pre-Xet CDN. Still serving repositories that have not been migrated,
    // so it stays until every model in MODELS is known to have moved.
    'https://cdn-lfs.huggingface.co',
    'https://cdn-lfs-us-1.huggingface.co',
  ]),
])
