/**
 * Binding an <audio> element to the waveform: the playhead, and seeking by
 * clicking.
 *
 * Browser-only. Checked under tsconfig.json alone.
 */

import { timeAtX, fractionAtTime } from '../core/timeline.js'

/**
 * @typedef {{ setDuration(seconds: number): void, destroy(): void }} Player
 */

/**
 * @param {object} parts
 * @param {HTMLMediaElement} parts.audio
 * @param {HTMLElement} parts.surface the element the playhead is positioned inside
 * @returns {Player}
 */
export function createPlayer({ audio, surface }) {
  let duration = 0
  /** @type {number | null} */
  let frame = null

  /**
   * The playhead's position, written as a 0-1 fraction on the surface's style.
   *
   * THIS IS THE ONE INLINE STYLE THE APP WRITES, and the reason the generated
   * CSP grants `style-src 'unsafe-inline'` -- see the comment on buildCSP in
   * scripts/build-site.mjs. A custom property rather than a `left` in pixels,
   * because the stylesheet resolves it with `calc(var(--playhead) * 100%)`: the
   * browser then re-resolves the position against the current width on every
   * layout, so a window resize moves the playhead with no JavaScript running at
   * all.
   */
  const write = () => {
    surface.style.setProperty('--playhead', String(fractionAtTime(audio.currentTime, duration)))
  }

  // requestAnimationFrame, not the `timeupdate` event. timeupdate fires roughly
  // four times a second, which draws a playhead that visibly steps rather than
  // moves. The loop runs only between play and pause: a permanent one would
  // keep the compositor awake on a tab nobody is looking at.
  const tick = () => {
    write()
    frame = requestAnimationFrame(tick)
  }

  const start = () => {
    if (frame === null) frame = requestAnimationFrame(tick)
  }

  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    // One final position after the loop has stopped, so a pause lands the
    // playhead exactly where playback stopped rather than one frame short.
    write()
  }

  /** @param {PointerEvent} event */
  const seek = (event) => {
    if (duration <= 0) return
    // Measured against the live rect rather than offsetWidth, so the mapping is
    // still right under any CSS transform or zoom applied to an ancestor.
    const rect = surface.getBoundingClientRect()
    audio.currentTime = timeAtX(event.clientX - rect.left, rect.width, duration)
    write()
  }

  audio.addEventListener('play', start)
  audio.addEventListener('pause', stop)
  audio.addEventListener('ended', stop)
  // Covers seeking while paused, when no animation frame is running to notice.
  audio.addEventListener('seeked', write)
  surface.addEventListener('pointerdown', seek)

  return {
    setDuration(seconds) {
      duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
      write()
    },

    destroy() {
      stop()
      audio.removeEventListener('play', start)
      audio.removeEventListener('pause', stop)
      audio.removeEventListener('ended', stop)
      audio.removeEventListener('seeked', write)
      surface.removeEventListener('pointerdown', seek)
    },
  }
}
