/**
 * The two lines of DOM construction everything in src/web/ repeats.
 *
 * Browser-only: this directory is checked under tsconfig.json alone, with the
 * DOM lib and no Node globals. Nothing here may be imported by src/core/.
 */

/**
 * Create an element with an optional class and text.
 *
 * `textContent`, never `innerHTML`. Nothing on the page was user-supplied while
 * this helper lived in site/main.js; with a file picker there is now a filename
 * chosen by someone else being written into a status line, and the habit is
 * cheaper to have kept than to retrofit.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string | null} [className]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

/**
 * A duration as `m:ss`, or `h:mm:ss` past an hour.
 *
 * Deliberately not the subtitle timecode formatter from src/core/subtitles.js.
 * That one exists to satisfy a parser and pads everything to
 * `HH:MM:SS,mmm`; this one exists to be glanced at beside a waveform, where
 * `00:00:04,000` is noise around the only digit that changed.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
