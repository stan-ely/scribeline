/**
 * Rendering the transcript next to the waveform, and editing it there:
 * highlighting the word under the playhead as audio plays, seeking by
 * clicking a word, correcting a word's text, splitting or merging a
 * segment, and dragging a segment boundary.
 *
 * Browser-only. Checked under tsconfig.json alone.
 */

import { wordAt, splitSegment, mergeSegments, moveBoundary, setWordText } from '../core/transcript.js'
import { el } from './dom.js'

/** @typedef {import('../core/transcript.js').Transcript} Transcript */

/**
 * @typedef {{ render(transcript: Transcript): void, clear(): void, destroy(): void }} TranscriptView
 */

/**
 * @param {object} parts
 * @param {HTMLElement} parts.container the element the transcript is rendered into
 * @param {HTMLMediaElement} parts.audio
 * @param {(next: Transcript) => void} parts.onChange called whenever an edit gesture produces a new transcript
 * @returns {TranscriptView}
 */
export function createTranscriptView({ container, audio, onChange }) {
  /** @type {Transcript | null} */
  let transcript = null

  // words[segmentIndex][wordIndex] -> its <span>, rebuilt once per render()
  // so the per-frame highlight below is two array lookups rather than a DOM
  // query. This runs on every animation frame while audio plays, for the same
  // reason wordAt itself is a binary search rather than a scan. The boundary
  // drag below also reads it, to find the words on either side of a boundary
  // without a second DOM query.
  /** @type {HTMLElement[][]} */
  let words = []

  /** @type {HTMLElement | null} */
  let current = null
  /** @type {number | null} */
  let frame = null

  // The in-flight word edit, if any. A second double-click, a blur, or an
  // Escape while one is open is unambiguous because there is only ever one.
  /** @type {{ input: HTMLInputElement, segmentIndex: number, wordIndex: number } | null} */
  let editing = null

  // The in-flight boundary drag, if any. lastDelta lets pointermove skip
  // re-rendering when the pointer has moved but not crossed into a new word.
  /** @type {{ segmentIndex: number, lastDelta: number } | null} */
  let dragging = null

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
    const word = target.closest('.transcript-word')
    if (word instanceof HTMLElement) {
      audio.currentTime = Number(word.dataset.start)
      return
    }

    const split = target.closest('.transcript-split')
    if (split instanceof HTMLElement && transcript) {
      const segmentIndex = Number(split.dataset.segment)
      const wordIndex = Number(split.dataset.word)
      const next = splitSegment(transcript, segmentIndex, wordIndex)
      // Reference equality is enough to detect a no-op, because every
      // operation in transcript.js returns the SAME object when it declines
      // to act -- a click at the edge of a segment should not push a no-op
      // entry onto the undo stack.
      if (next !== transcript) commit(next)
      return
    }

    const merge = target.closest('.transcript-merge')
    if (merge instanceof HTMLElement && transcript) {
      const segmentIndex = Number(merge.dataset.segment)
      const next = mergeSegments(transcript, segmentIndex)
      if (next !== transcript) commit(next)
    }
  }

  /** @param {MouseEvent} event */
  const onDoubleClick = (event) => {
    const target = /** @type {HTMLElement} */ (event.target)
    const span = target.closest('.transcript-word')
    if (span instanceof HTMLElement) beginEdit(span)
  }

  /** @param {HTMLElement} span */
  const beginEdit = (span) => {
    if (!transcript) return
    // A second double-click while one edit is already open commits it first,
    // rather than leaving two inputs live or silently discarding the first.
    if (editing) commitEdit()

    const segmentIndex = Number(span.dataset.segment)
    const wordIndex = Number(span.dataset.word)
    const word = transcript.segments[segmentIndex]?.words[wordIndex]
    if (!word) return

    const input = el('input', 'transcript-word-input')
    input.type = 'text'
    input.value = word.text
    input.dataset.segment = String(segmentIndex)
    input.dataset.word = String(wordIndex)

    span.replaceWith(input)
    input.focus()
    input.select()

    editing = { input, segmentIndex, wordIndex }
  }

  const commitEdit = () => {
    if (!editing || !transcript) return
    const { input, segmentIndex, wordIndex } = editing
    const text = input.value.trim()
    editing = null

    // An empty word breaks the space-joined rendering and would export a
    // subtitle cue timed to nothing -- reverting is the guard, not a new
    // invariant added to setWordText.
    if (!text) {
      render(transcript)
      return
    }

    const next = setWordText(transcript, segmentIndex, wordIndex, text)
    commit(next)
  }

  const cancelEdit = () => {
    if (!editing || !transcript) return
    editing = null
    render(transcript)
  }

  /** @param {FocusEvent} event */
  const onEditBlur = (event) => {
    if (editing && event.target === editing.input) commitEdit()
  }

  /** @param {KeyboardEvent} event */
  const onEditKeydown = (event) => {
    if (!editing || event.target !== editing.input) return
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
    }
  }

  /** @param {PointerEvent} event */
  const onPointerDown = (event) => {
    const target = /** @type {HTMLElement} */ (event.target)
    const handle = target.closest('.transcript-boundary-handle')
    if (!(handle instanceof HTMLElement) || !transcript) return

    // Captured on container, not the handle: render() replaces the handle
    // element on every pointermove below (to draw the live preview), which
    // would silently end a capture held on the handle itself.
    container.setPointerCapture(event.pointerId)
    dragging = { segmentIndex: Number(handle.dataset.segment), lastDelta: 0 }
    handle.classList.add('is-dragging')
  }

  /** @param {PointerEvent} event */
  const onPointerMove = (event) => {
    if (!dragging || !transcript) return
    const delta = wordDeltaForPointer(dragging.segmentIndex, event.clientX)
    if (delta === dragging.lastDelta) return
    dragging.lastDelta = delta

    // Live preview only -- moveBoundary's own clamping keeps this safe even
    // while the pointer is still moving, and neither onChange nor the undo
    // stack hears about it until the drag ends.
    render(moveBoundary(transcript, dragging.segmentIndex, delta))
    container
      .querySelector(`.transcript-boundary-handle[data-segment="${dragging.segmentIndex}"]`)
      ?.classList.add('is-dragging')
  }

  /** @param {PointerEvent} event */
  const onPointerUp = (event) => {
    if (!dragging || !transcript) return
    const { segmentIndex, lastDelta } = dragging
    dragging = null
    container.releasePointerCapture(event.pointerId)
    container
      .querySelector(`.transcript-boundary-handle[data-segment="${segmentIndex}"]`)
      ?.classList.remove('is-dragging')

    // transcript is already the live-previewed result of the last
    // pointermove's render() -- committing it here turns the whole drag into
    // exactly one undo entry, not one per pixel crossed.
    if (lastDelta !== 0) onChange(transcript)
  }

  /**
   * Which word, among the ones on either side of a boundary, the pointer
   * currently sits over -- expressed as the signed word count to pass to
   * moveBoundary.
   *
   * Measured against each word span's live getBoundingClientRect(), the same
   * technique src/web/player.js uses for the waveform: exact regardless of
   * proportional font metrics, where a pixels-per-word estimate would not be.
   *
   * @param {number} segmentIndex the earlier of the two segments sharing this boundary
   * @param {number} clientX
   * @returns {number}
   */
  function wordDeltaForPointer(segmentIndex, clientX) {
    const before = words[segmentIndex] ?? []
    const after = words[segmentIndex + 1] ?? []
    const combined = [...before, ...after]
    if (combined.length === 0) return 0

    let closest = 0
    let closestDistance = Infinity
    combined.forEach((span, i) => {
      const rect = span.getBoundingClientRect()
      const mid = rect.left + rect.width / 2
      const distance = Math.abs(clientX - mid)
      if (distance < closestDistance) {
        closestDistance = distance
        closest = i
      }
    })

    // The boundary currently sits at index before.length within `combined`;
    // landing it at `closest` instead is a move of that many words.
    return closest - before.length
  }

  /**
   * Apply an edit: render it immediately and report it upward in the same
   * step, so the view never has one transcript on screen and a different one
   * reported to onChange.
   *
   * @param {Transcript} next
   */
  function commit(next) {
    render(next)
    onChange(next)
  }

  audio.addEventListener('play', start)
  audio.addEventListener('pause', stop)
  audio.addEventListener('ended', stop)
  // Covers seeking (from the waveform, say) while paused, when no animation
  // frame is running to notice on its own.
  audio.addEventListener('seeked', highlight)
  container.addEventListener('click', onClick)
  container.addEventListener('dblclick', onDoubleClick)
  container.addEventListener('focusout', onEditBlur)
  container.addEventListener('keydown', onEditKeydown)
  container.addEventListener('pointerdown', onPointerDown)
  container.addEventListener('pointermove', onPointerMove)
  container.addEventListener('pointerup', onPointerUp)

  /** @param {Segment} segment @param {number} segmentIndex */
  function buildSegment(segment, segmentIndex) {
    const p = el('p', 'transcript-segment')
    const spans = segment.words.map((word, wordIndex) => {
      if (wordIndex > 0) {
        // Never placed before the first or after the last word: splitting
        // there is already a no-op in splitSegment, and a dead click target
        // is worse than one that is simply absent.
        const split = el('button', 'transcript-split')
        split.type = 'button'
        split.title = 'Split here'
        split.dataset.segment = String(segmentIndex)
        split.dataset.word = String(wordIndex)
        p.append(split)
      }

      const span = el('span', 'transcript-word', word.text)
      span.dataset.start = String(word.start)
      span.dataset.segment = String(segmentIndex)
      span.dataset.word = String(wordIndex)
      p.append(span, document.createTextNode(' '))
      return span
    })
    return { p, spans }
  }

  /** @param {number} segmentIndex the earlier of the two segments sharing this boundary */
  function buildBoundary(segmentIndex) {
    const div = el('div', 'transcript-boundary')

    const handle = el('button', 'transcript-boundary-handle')
    handle.type = 'button'
    handle.title = 'Drag to move the boundary'
    handle.dataset.segment = String(segmentIndex)

    const merge = el('button', 'transcript-merge', 'Merge')
    merge.type = 'button'
    merge.title = 'Merge with the next segment'
    merge.dataset.segment = String(segmentIndex)

    div.append(handle, merge)
    return div
  }

  /** @param {Transcript} next */
  function render(next) {
    transcript = next
    current = null
    words = []

    const segments = next.segments.map((segment, segmentIndex) => buildSegment(segment, segmentIndex))

    /** @type {ChildNode[]} */
    const nodes = []
    segments.forEach(({ p }, i) => {
      nodes.push(p)
      if (i < segments.length - 1) nodes.push(buildBoundary(i))
    })

    container.replaceChildren(...nodes)
    words = segments.map(({ spans }) => spans)

    highlight()
  }

  return {
    render,

    clear() {
      transcript = null
      current = null
      words = []
      editing = null
      dragging = null
      container.replaceChildren()
    },

    destroy() {
      stop()
      audio.removeEventListener('play', start)
      audio.removeEventListener('pause', stop)
      audio.removeEventListener('ended', stop)
      audio.removeEventListener('seeked', highlight)
      container.removeEventListener('click', onClick)
      container.removeEventListener('dblclick', onDoubleClick)
      container.removeEventListener('focusout', onEditBlur)
      container.removeEventListener('keydown', onEditKeydown)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerUp)
      editing = null
      dragging = null
    },
  }
}

/** @typedef {{ words: import('../core/transcript.js').Word[] }} Segment */
