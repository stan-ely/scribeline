/**
 * The transcript document: what a transcription is, and what editing one does
 * to it.
 *
 * This is the shape every other part of the app agrees on. The waveform draws
 * against it, the editor mutates it through the functions below, the SRT/VTT
 * exporters read it, and the whisper adapter's only job is to produce one. It
 * is written before any of them on purpose -- a data shape invented as a side
 * effect of a UI decision is a shape the other two consumers then have to be
 * retrofitted to.
 *
 * Isomorphic: no DOM, no fs. Checked under both tsconfig projects.
 */

/**
 * A single word, with the timings the model reported for it.
 *
 * `start` and `end` are SECONDS, as floats. whisper.cpp reports token times in
 * centiseconds, and `AudioContext.currentTime` and `HTMLMediaElement`'s
 * `currentTime` both speak seconds -- so one of the two units has to lose, and
 * the one that loses is the one used by exactly one producer at the edge of the
 * system. The whisper adapter divides by 100 once; nothing downstream of it
 * ever sees a centisecond. Millisecond formatting for subtitle files is a
 * serialization concern and rounds in src/core/subtitles.js.
 *
 * `confidence` is optional because it is optional upstream: not every decoding
 * path in whisper.cpp fills it in, and a UI that dims low-confidence words has
 * to cope with not knowing rather than treating absent as zero.
 *
 * @typedef {{ text: string, start: number, end: number, confidence?: number }} Word
 */

/**
 * A run of words that will become one subtitle cue.
 *
 * NOTE WHAT IS NOT HERE: a segment has no `start` or `end` of its own. Its
 * bounds ARE its first and last word, derived on demand by `segmentStart` and
 * `segmentEnd` below.
 *
 * That is the load-bearing decision in this file. A segment carrying its own
 * timestamps alongside its words can hold a pair of numbers that disagree with
 * the words between them -- and dragging a boundary is exactly the operation
 * that would produce the disagreement, because it changes which words a segment
 * holds. The disagreement would then be invisible until somebody exported the
 * file and a cue was timed to text it does not contain. Deriving the bounds
 * makes that state unrepresentable rather than merely discouraged.
 *
 * The cost is that a segment must never be empty, since an empty one has no
 * bounds to derive. Every operation in this file preserves that.
 *
 * @typedef {{ words: Word[] }} Segment
 */

/**
 * A whole transcription.
 *
 * `duration` is the audio's length, not the last word's end -- a recording
 * usually ends in silence, and the waveform has to draw that silence. It is
 * carried here rather than recomputed because it comes from the decoded audio,
 * which core cannot see.
 *
 * `language` is whisper's detected or forced language tag, optional for the
 * same reason `confidence` is: it may not have been asked for.
 *
 * Segments are ordered by time and non-empty. Both are invariants of the
 * operations below, not assumptions about the caller -- but a transcript
 * assembled by hand can break them, which is why `wordAt` refuses to guess when
 * it meets an empty segment rather than reading `words[0]` of nothing.
 *
 * @typedef {{ segments: Segment[], duration: number, language?: string }} Transcript
 */

/**
 * Where a segment begins: its first word's start, or `null` if it has no words.
 *
 * Returning `null` rather than `NaN` or `0` is deliberate. `NaN` propagates
 * silently through arithmetic and comparisons and surfaces as a cue timed to
 * `00:00:00,NaN`; `0` is a plausible-looking lie that sorts to the front. Null
 * forces the two callers that exist -- the exporter and `wordAt` -- to say what
 * they do about it.
 *
 * @param {Segment} segment
 * @returns {number | null}
 */
export function segmentStart(segment) {
  const first = segment.words[0]
  return first ? first.start : null
}

/**
 * Where a segment ends: its last word's end, or `null` if it has no words.
 *
 * @param {Segment} segment
 * @returns {number | null}
 */
export function segmentEnd(segment) {
  const last = segment.words[segment.words.length - 1]
  return last ? last.end : null
}

/**
 * How many words the transcript holds, across every segment.
 *
 * @param {Transcript} transcript
 * @returns {number}
 */
export function totalWords(transcript) {
  let n = 0
  for (const segment of transcript.segments) n += segment.words.length
  return n
}

/**
 * Split one segment into two, before `wordIndex`.
 *
 * Returns a new transcript. Every operation in this file is pure and returns a
 * new object, because a transcript editor needs undo and undo over a mutable
 * tree is a diffing problem -- with immutable operations the undo stack is a
 * list of the objects that were already produced. It stays cheap because the
 * rebuild is structural: the segment array is copied and one segment becomes
 * two, while every word object and every untouched segment is shared.
 *
 * A split at 0 or at `words.length` returns the transcript UNCHANGED rather
 * than throwing or producing an empty segment. The caller is a mouse: a drag
 * that lands back where it started should be inert, and an out-of-range index
 * from a pointer that left the element is not an exceptional condition worth a
 * stack trace.
 *
 * @param {Transcript} transcript
 * @param {number} segmentIndex
 * @param {number} wordIndex the split lands BEFORE this word
 * @returns {Transcript}
 */
export function splitSegment(transcript, segmentIndex, wordIndex) {
  const segment = transcript.segments[segmentIndex]
  if (!segment) return transcript
  if (wordIndex <= 0 || wordIndex >= segment.words.length) return transcript

  const segments = [...transcript.segments]
  segments.splice(
    segmentIndex,
    1,
    { words: segment.words.slice(0, wordIndex) },
    { words: segment.words.slice(wordIndex) },
  )
  return { ...transcript, segments }
}

/**
 * Merge a segment with the one that follows it.
 *
 * A no-op at the last index, and at an index that names no segment, for the
 * same reason `splitSegment` is: the caller is a pointer, not a program.
 *
 * @param {Transcript} transcript
 * @param {number} segmentIndex the segment to merge with its successor
 * @returns {Transcript}
 */
export function mergeSegments(transcript, segmentIndex) {
  const first = transcript.segments[segmentIndex]
  const second = transcript.segments[segmentIndex + 1]
  if (!first || !second) return transcript

  const segments = [...transcript.segments]
  segments.splice(segmentIndex, 2, { words: [...first.words, ...second.words] })
  return { ...transcript, segments }
}

/**
 * Move the boundary between segments `boundaryIndex` and `boundaryIndex + 1` by
 * `wordDelta` words. Positive moves words forward (the earlier segment grows);
 * negative moves them back.
 *
 * This is the primitive behind dragging a boundary in the editor, and it is
 * expressed in WORDS rather than in seconds on purpose. The word timings came
 * out of the model and are the one part of the document the user did not
 * author; a boundary drag decides which words belong together, and the
 * timestamps follow from that. Retiming a word is a different operation and is
 * not this one.
 *
 * `wordDelta` is CLAMPED so that neither side is emptied, rather than throwing
 * or refusing. A drag is continuous and a user who pulls past the end of a
 * segment means "as far as it goes", not "error" -- and an emptied segment
 * would have no bounds to derive, which is the invariant this whole file rests
 * on.
 *
 * @param {Transcript} transcript
 * @param {number} boundaryIndex
 * @param {number} wordDelta
 * @returns {Transcript}
 */
export function moveBoundary(transcript, boundaryIndex, wordDelta) {
  const first = transcript.segments[boundaryIndex]
  const second = transcript.segments[boundaryIndex + 1]
  if (!first || !second) return transcript

  // At most all but one word may leave a segment, in either direction.
  const delta = Math.max(
    -(first.words.length - 1),
    Math.min(second.words.length - 1, Math.trunc(wordDelta)),
  )
  if (delta === 0) return transcript

  const all = [...first.words, ...second.words]
  const cut = first.words.length + delta

  const segments = [...transcript.segments]
  segments.splice(
    boundaryIndex,
    2,
    { words: all.slice(0, cut) },
    { words: all.slice(cut) },
  )
  return { ...transcript, segments }
}

/**
 * Replace one word's text, leaving its timings alone.
 *
 * Text is the half of a word the user is allowed to author -- the model's
 * spelling of a name is wrong far more often than its timing is. Changing a
 * word's `start` or `end` is a separate operation this file does not yet offer.
 *
 * @param {Transcript} transcript
 * @param {number} segmentIndex
 * @param {number} wordIndex
 * @param {string} text
 * @returns {Transcript}
 */
export function setWordText(transcript, segmentIndex, wordIndex, text) {
  const segment = transcript.segments[segmentIndex]
  const word = segment?.words[wordIndex]
  if (!word || word.text === text) return transcript

  const words = [...segment.words]
  words[wordIndex] = { ...word, text }

  const segments = [...transcript.segments]
  segments[segmentIndex] = { ...segment, words }
  return { ...transcript, segments }
}

/**
 * Find the word being spoken at `time`, or `null` if none is.
 *
 * `null` is a real answer here, not a failure: most of a recording's timeline
 * is the gaps between words, and a playhead sitting in one is in silence. A
 * caller that highlighted "the nearest word" instead would leave a word lit
 * through a four-second pause.
 *
 * The interval is half-open, `[start, end)`. Adjacent words share a number at
 * their join, and a closed interval would make that instant match both of them
 * -- so the later word wins, consistently, and a playhead at exactly a word's
 * end has finished it.
 *
 * Binary search, twice: once over segments, once within the segment found. This
 * runs on every animation frame while audio plays, against a transcript that
 * can hold tens of thousands of words, so a linear scan here is a scan of the
 * whole document sixty times a second. Both searches assume segments are
 * time-ordered and non-empty, which every operation above preserves; a
 * hand-assembled transcript that breaks it gets `null` rather than a guess.
 *
 * @param {Transcript} transcript
 * @param {number} time seconds
 * @returns {{ segmentIndex: number, wordIndex: number } | null}
 */
export function wordAt(transcript, time) {
  const segments = transcript.segments

  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const start = segmentStart(segments[mid])
    const end = segmentEnd(segments[mid])
    // An empty segment has no bounds, so there is no side of it to recurse
    // into. Refusing beats picking one at random.
    if (start === null || end === null) return null

    if (time < start) hi = mid - 1
    else if (time >= end) lo = mid + 1
    else {
      const wordIndex = findWord(segments[mid].words, time)
      return wordIndex === -1 ? null : { segmentIndex: mid, wordIndex }
    }
  }
  return null
}

/**
 * Index of the word covering `time` within one segment's words, or -1 if the
 * time falls in a gap between them.
 *
 * @param {readonly Word[]} words
 * @param {number} time
 * @returns {number}
 */
function findWord(words, time) {
  let lo = 0
  let hi = words.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const word = words[mid]
    if (time < word.start) hi = mid - 1
    else if (time >= word.end) lo = mid + 1
    else return mid
  }
  return -1
}
