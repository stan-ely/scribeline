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

/**
 * The placeholder screen.
 *
 * Rendered from JavaScript rather than written into index.html, for one reason
 * beyond consistency with how the app will work: a static page proves the HTML
 * was served, and this proves the bundle was fetched, parsed, and executed
 * under the shipped Content-Security-Policy. On a deployed scaffold that is the
 * more useful of the two signals -- an empty page cannot tell you which half
 * failed.
 *
 * The threading line is here for the same reason. Whether the page is
 * cross-origin isolated is decided by response headers this repository cannot
 * set on its deploy host, and it is otherwise only visible by reading headers
 * by hand. Putting it on the page makes the one real constraint on this
 * project checkable by looking at it.
 *
 * All of this is replaced by the editor. Nothing here is a component to build
 * on -- no state, no vdom, no structure worth keeping.
 */
const app = document.getElementById('app')
if (!app) throw new Error('#app is missing from the page')

/**
 * @param {string} tag
 * @param {string | null} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  // textContent, never innerHTML. Nothing on this page is user-supplied yet,
  // and the habit is cheaper to keep than to retrofit once something is.
  if (text) node.textContent = text
  return node
}

const shell = el('div', 'placeholder')
shell.append(
  el('h1', null, 'scribeline'),
  el('p', 'lede', 'A transcript editor that runs on your machine.'),
  el(
    'p',
    null,
    'Waveform and words on one timeline. whisper.cpp runs as WebAssembly in ' +
      'the page, so your audio never leaves the device.',
  ),
  el('p', 'status', 'Scaffold — the editor is not built yet.'),
  el(
    'p',
    'env',
    THREADS_AVAILABLE
      ? 'This page is cross-origin isolated: threaded inference is available.'
      : 'This page is not cross-origin isolated, so SharedArrayBuffer is ' +
        'unavailable and transcription would run single-threaded. That is the ' +
        'deploy host, not the build.',
  ),
)

// createElement directly rather than through el(): that helper is typed as
// returning HTMLElement, which has no `href`. Narrowing it generically would
// mean a lookup type for one anchor on a page that is about to be deleted.
const source = el('p', 'env')
const link = document.createElement('a')
link.href = 'https://github.com/stan-ely/scribeline'
link.textContent = 'github.com/stan-ely/scribeline'
source.append(link)
shell.append(source)

app.append(shell)
