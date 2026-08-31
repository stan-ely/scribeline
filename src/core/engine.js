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
 * The file is not committed (see .gitignore); a fetch step will place it here
 * at build time. Same-origin, so it contributes no CSP entry.
 */
export const WASM_PATH = '/whisper/whisper.wasm'

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
    // The CDN that huggingface.co redirects `resolve/` downloads to. Not
    // derivable from the URLs above -- it only appears in a Location header --
    // so it is the one entry in this file that is written out by hand.
    'https://cdn-lfs.huggingface.co',
    'https://cdn-lfs-us-1.huggingface.co',
  ]),
])
