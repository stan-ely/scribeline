/**
 * Rendering the transcript next to the waveform: highlighting the word under
 * the playhead as audio plays, and seeking by clicking a word.
 *
 * Browser-only. Checked under tsconfig.json alone.
 */

import { wordAt } from '../core/transcript.js'
import { el } from './dom.js'

/** @typedef {import('../core/transcript.js').Transcript} Transcript */

/**
 * @typedef {{ render(transcript: Transcript): void, clear(): void, destroy(): void }} TranscriptView
 */

/**
 * @param {object} parts
 * @param {HTMLElement} parts.container the element the transcript is rendered into
 * @param {HTMLMediaElement} parts.audio
 * @returns {TranscriptView}
 */
export function createTranscriptView({ container, audio }) {
  /** @type {Transcript | null} */
  let transcript = null

  // words[segmentIndex][wordIndex] -> its <span>, rebuilt once per render()
  // so the per-frame highlight below is two array lookups rather than a DOM
  // query. This runs on every animation frame while audio plays, for the same
  // reason wordAt itself is a binary search rather than a scan.
  /** @type {HTMLElement[][]} */
  let words = []

  /** @type {HTMLElement | null} */
  let current = null
  /** @type {number | null} */
  let frame = null

  const highlight = () => {
    if (!transcript) return
    const hit = wordAt(transcript, audio.currentTime)
    const next = hit ? (words[hit.segmentIndex]?.[hit.wordIndex] ?? null) : null
    if (next === current) return
    current?.classList.remove('is-current')
    next?.classList.add('is-current')
    // Keeps the highlighted word visible in a transcript taller than its
    // container, without also jumping when nothing changed -- the guard above
    // already stops that.
    next?.scrollIntoView({ block: 'nearest' })
    current = next
  }

  // requestAnimationFrame, not `timeupdate`, and only between play and pause --
  // the same tradeoff src/web/player.js makes for the same reason: `timeupdate`
  // steps rather than tracks, and a permanent loop would run against a tab
  // nobody is looking at.
  const tick = () => {
    highlight()
    frame = requestAnimationFrame(tick)
  }

  const start = () => {
    if (frame === null) frame = requestAnimationFrame(tick)
  }

  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    highlight()
  }

  /** @param {MouseEvent} event */
  const onClick = (event) => {
    const target = /** @type {HTMLElement} */ (event.target)
    const word = target.closest('[data-start]')
    if (!(word instanceof HTMLElement)) return
    audio.currentTime = Number(word.dataset.start)
  }

  audio.addEventListener('play', start)
  audio.addEventListener('pause', stop)
  audio.addEventListener('ended', stop)
  // Covers seeking (from the waveform, say) while paused, when no animation
  // frame is running to notice on its own.
  audio.addEventListener('seeked', highlight)
  container.addEventListener('click', onClick)

  return {
    render(next) {
      transcript = next
      current = null
      words = []

      const segments = next.segments.map((segment) => {
        const p = el('p', 'transcript-segment')
        const spans = segment.words.map((word) => {
          const span = el('span', 'transcript-word', word.text)
          span.dataset.start = String(word.start)
          p.append(span, document.createTextNode(' '))
          return span
        })
        return { p, spans }
      })

      container.replaceChildren(...segments.map(({ p }) => p))
      words = segments.map(({ spans }) => spans)

      highlight()
    },

    clear() {
      transcript = null
      current = null
      words = []
      container.replaceChildren()
    },

    destroy() {
      stop()
      audio.removeEventListener('play', start)
      audio.removeEventListener('pause', stop)
      audio.removeEventListener('ended', stop)
      audio.removeEventListener('seeked', highlight)
      container.removeEventListener('click', onClick)
    },
  }
}
