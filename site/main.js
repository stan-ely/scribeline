/**
 * The page entry point. Bundled to site/dist/main.<hash>.js by
 * scripts/build-site.mjs.
 *
 * Nothing is mounted yet -- this is the scaffold commit. What is here already
 * is the pair of environment checks the app cannot start without, because
 * finding out about either of them halfway through loading a 60 MB model is
 * worse than finding out immediately.
 */

/**
 * Refuse to run inside a frame.
 *
 * This page handles recordings people have not chosen to publish. Embedded in
 * someone else's document, it becomes a control they can position under their
 * own copy and their own framing, and clickjacking a file picker is a real
 * attack rather than a theoretical one.
 *
 * The header that would prevent this properly is `frame-ancestors`, and it is
 * only honoured as an HTTP response header -- never inside a <meta> tag. GitHub
 * Pages serves no custom headers at all, so on the deploy target this check is
 * not defence in depth, it is the defence. It stays regardless of host.
 */
if (window.top !== window.self) {
  document.documentElement.textContent =
    'scribeline will not run inside a frame. Open it directly.'
  throw new Error('framed')
}

/**
 * Whether the page is cross-origin isolated, and therefore whether
 * `SharedArrayBuffer` -- and threaded whisper.cpp inference -- is available.
 *
 * This is not a capability to check at the point of use. It is decided by
 * response headers before any of our code runs, it cannot be recovered from at
 * runtime, and the difference it makes is roughly an order of magnitude in
 * transcription speed. The app is expected to read this once and choose a
 * single-threaded build when it is false, rather than fail.
 *
 * See the header comment in scripts/build-site.mjs for why it is false on some
 * hosts no matter what this repository does.
 */
export const THREADS_AVAILABLE = globalThis.crossOriginIsolated === true

console.info(
  `scribeline: scaffold. threads ${THREADS_AVAILABLE ? 'available' : 'unavailable'}.`,
)
