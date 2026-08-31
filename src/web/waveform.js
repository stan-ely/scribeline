/**
 * Painting the waveform onto a canvas.
 *
 * Everything here is the part that could not be tested offline: sizing a
 * backing store, reading a computed colour, filling a path. The arithmetic this
 * draws from lives in src/core/peaks.js, under test.
 *
 * THIS CANVAS IS NOT REPAINTED WHILE AUDIO PLAYS. It is drawn once per file and
 * once per resize. The playhead is a DOM element positioned by a CSS custom
 * property (see src/web/player.js), which is why the generated CSP grants
 * `style-src 'unsafe-inline'` -- and why a sixty-times-a-second repaint of a
 * few thousand rectangles is not on the critical path of playback.
 *
 * Browser-only. Checked under tsconfig.json alone.
 */

import { mixToMono, computePeaks } from '../core/peaks.js'

/**
 * @typedef {{ setBuffer(buffer: AudioBuffer | null): void, destroy(): void }} Waveform
 */

/**
 * Mount a waveform on a canvas that is sized by CSS.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Waveform}
 */
export function createWaveform(canvas) {
  /** @type {Float32Array | null} */
  let mono = null
  /** @type {number | null} */
  let pending = null

  // Coalesced into one animation frame. A ResizeObserver fires for every
  // intermediate width during a window drag, and each of those would otherwise
  // be a full reduction over several million samples.
  const schedule = () => {
    if (pending !== null) return
    pending = requestAnimationFrame(() => {
      pending = null
      draw()
    })
  }

  function draw() {
    const context = canvas.getContext('2d')
    if (!context) return

    const { width: cssWidth, height: cssHeight } = canvas.getBoundingClientRect()
    if (cssWidth === 0 || cssHeight === 0) return

    // The backing store is scaled by devicePixelRatio and the context scaled to
    // match, so the rest of this function works in CSS pixels. Without it the
    // waveform is drawn at a third of the resolution of the screen it is on and
    // reads as soft, which on a picture made of one-pixel columns is most of
    // the detail.
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round(cssHeight * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, cssWidth, cssHeight)

    // Colours come from the stylesheet's custom properties rather than from
    // literals here, so there is one palette. A second copy in JavaScript is a
    // copy that stops matching the first time a theme is touched.
    const styles = getComputedStyle(canvas)
    const accent = styles.getPropertyValue('--accent').trim() || '#d8a657'
    const line = styles.getPropertyValue('--line').trim() || '#2b2825'

    // The centre line, drawn even with no audio loaded: an empty waveform that
    // is blank is indistinguishable from one that failed to render.
    context.fillStyle = line
    context.fillRect(0, Math.round(cssHeight / 2), cssWidth, 1)
    if (!mono) return

    // One column per CSS pixel. A resize recomputes rather than rescales,
    // because a peak array holds one measurement per column and stretching it
    // invents detail that looks exactly like the real thing.
    const columns = Math.max(1, Math.floor(cssWidth))
    const { min, max } = computePeaks(mono, columns)

    const middle = cssHeight / 2
    // Half a pixel of inset so a full-scale sample is a visible line rather
    // than a row clipped by the canvas edge.
    const scale = middle - 0.5

    // One path for every column, filled once. A beginPath/stroke per column is
    // a thousand separate paths per draw, and it shows on a resize drag.
    const path = new Path2D()
    for (let i = 0; i < columns; i++) {
      const top = middle - max[i] * scale
      const bottom = middle - min[i] * scale
      // A minimum height of one pixel: a column of near-silence that rounds to
      // zero height disappears entirely, which draws a gap in the recording
      // where there is quiet speech.
      path.rect(i, top, 1, Math.max(1, bottom - top))
    }
    context.fillStyle = accent
    context.fill(path)
  }

  const observer = new ResizeObserver(schedule)
  observer.observe(canvas)

  return {
    setBuffer(buffer) {
      if (!buffer) {
        mono = null
      } else {
        const channels = []
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          channels.push(buffer.getChannelData(c))
        }
        mono = mixToMono(channels)
      }
      schedule()
    },

    destroy() {
      observer.disconnect()
      if (pending !== null) cancelAnimationFrame(pending)
      pending = null
      mono = null
    },
  }
}
