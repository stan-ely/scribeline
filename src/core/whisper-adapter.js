/**
 * Turning what whisper.cpp reports into the document the rest of the app edits.
 *
 * This is the only file in the repository allowed to see a centisecond.
 * whisper.cpp reports every token time in hundredths of a second; src/core/
 * speaks seconds, because `HTMLMediaElement.currentTime` does and because a
 * playhead comparing against the wrong unit is a bug that looks like a model
 * that mistimes everything by a factor of a hundred. The division happens once,
 * here, and nothing downstream ever sees the other unit.
 *
 * It is also where most of this slice is testable. Everything else in the
 * engine -- the wasm, the worker, the download -- needs a browser or a network;
 * this is an array in and an object out, and it is where a transcript acquires
 * the invariants src/core/transcript.js rests on.
 *
 * Isomorphic: no DOM, no fs. Checked under both tsconfig projects.
 */

/** @typedef {import('./transcript.js').Transcript} Transcript */
/** @typedef {import('./transcript.js').Segment} Segment */
/** @typedef {import('./transcript.js').Word} Word */

/**
 * One token as the patched emscripten binding hands it over.
 *
 * `t0` and `t1` are CENTISECONDS. `p` is the token's probability, 0-1, which
 * becomes `Word.confidence` -- the same number, renamed to what it is used for.
 *
 * @typedef {{ text: string, t0: number, t1: number, p: number }} RawToken
 */

/**
 * One of whisper's own segments: a sentence-ish run, with the tokens inside it.
 *
 * The segmentation is whisper's rather than ours on purpose. Its segments are
 * roughly sentences, which is roughly a subtitle cue, and that is a better
 * starting point for an editor than anything derivable from the timings alone.
 * The user re-cuts them with splitSegment/mergeSegments/moveBoundary; this is
 * the first draft, not the answer.
 *
 * @typedef {{ tokens: RawToken[] }} RawSegment
 */

/**
 * The smallest duration a word may have, in seconds.
 *
 * A word needs a non-empty interval to be findable at all: `wordAt` matches on
 * `[start, end)`, so a word whose end equals its start matches no time
 * whatsoever and is invisible to the playhead forever. whisper does emit those
 * -- a token the decoder placed but gave no measurable extent. One centisecond
 * is the resolution the timings arrive at, so it is the smallest lie available.
 */
const MIN_WORD_SECONDS = 0.01

/**
 * Build a transcript from the engine's raw output.
 *
 * THE INVARIANTS ARE ESTABLISHED HERE, not assumed. src/core/transcript.js
 * documents that segments are time-ordered and non-empty and that its
 * operations preserve both -- but preserving them is not creating them, and
 * this function is the one place a transcript is created from outside data. A
 * transcript that breaks either invariant does not throw: `wordAt` returns
 * `null` for the rest of the recording, so the playhead simply never highlights
 * anything and the failure looks like a UI that was never wired up.
 *
 * So: empty and whitespace-only tokens are dropped, segments left with no
 * tokens are dropped, and each word's start is pulled forward to the previous
 * word's end if the model reported them out of order. That last one happens:
 * token timestamps are a by-product of the decoder's attention, not a
 * measurement, and a couple of tokens per recording come back overlapping.
 *
 * @param {{ segments: RawSegment[], language?: string }} raw
 * @param {number} duration seconds of audio, from the decoder -- NOT the last
 *   word's end. A recording usually ends in silence and the waveform draws it.
 * @returns {Transcript}
 */
export function toTranscript(raw, duration) {
  const audioLength = Number.isFinite(duration) && duration > 0 ? duration : 0

  /** @type {Segment[]} */
  const segments = []
  // Carried across segments, not reset per segment: the ordering that matters
  // is the document's, and whisper's segment boundaries are exactly where an
  // overlap is most likely to show up.
  let previousEnd = 0

  for (const rawSegment of raw.segments ?? []) {
    /** @type {Word[]} */
    const words = []

    for (const token of rawSegment.tokens ?? []) {
      const raw = typeof token.text === 'string' ? token.text : ''
      const text = raw.trim()
      // Whitespace-only tokens are real and frequent -- whisper's tokenizer
      // carries the leading space of a word as part of it, and a segment often
      // opens with one that is nothing else. A Word with no text draws as a gap
      // that cannot be clicked and exports as a double space.
      if (text === '') continue

      const start = Math.max(previousEnd, seconds(token.t0))
      const end = Math.max(start + MIN_WORD_SECONDS, seconds(token.t1))
      previousEnd = end

      const previous = words[words.length - 1]
      if (previous && continues(raw, text)) {
        previous.text += text
        previous.end = Math.max(previous.end, end)
        // The least confident piece decides. A word is only as trustworthy as
        // its worst part, and averaging would let three certain syllables hide
        // a guessed one -- which is the opposite of what a UI that dims
        // uncertain words is for.
        if (typeof token.p === 'number' && Number.isFinite(token.p)) {
          previous.confidence =
            previous.confidence === undefined
              ? token.p
              : Math.min(previous.confidence, token.p)
        }
        continue
      }

      /** @type {Word} */
      const word = { text, start, end }
      // Absent rather than zero when the engine did not report one. `confidence`
      // is optional upstream and a UI that dims low-confidence words has to be
      // able to tell "unsure" from "not measured" -- zero is the most confident
      // possible statement of the wrong thing.
      if (typeof token.p === 'number' && Number.isFinite(token.p)) {
        word.confidence = token.p
      }
      words.push(word)
    }

    // A segment with no words has no bounds to derive, which is the one state
    // transcript.js cannot represent. Dropping it is the only option that keeps
    // the document well-formed; keeping it would break `wordAt` for everything
    // after it, since its binary search refuses to guess which side of a
    // boundless segment to recurse into.
    if (words.length > 0) segments.push({ words })
  }

  /** @type {Transcript} */
  const transcript = {
    segments,
    // At least as long as the words it contains. A model can time a token past
    // the end of the audio it was given, and a duration shorter than the last
    // word would put the end of the transcript off the right edge of the
    // waveform it is drawn against.
    duration: Math.max(audioLength, previousEnd),
  }
  if (raw.language) transcript.language = raw.language
  return transcript
}

/**
 * Whether a token continues the word before it rather than starting a new one.
 *
 * A WHISPER TOKEN IS NOT A WORD, and the difference is visible in the first
 * transcript anyone produces: "once upon a time." comes back as five tokens,
 * the last of which is the full stop. Treating each as a word puts a clickable
 * "." in the transcript and exports a cue reading "once upon a time ." with a
 * space before the period.
 *
 * It gets worse than punctuation. The tokenizer is byte-pair, so a long or
 * unusual word arrives in pieces -- "unbelievable" as " un", "bel", "iev",
 * "able" -- and each piece would become a word with its own timing, its own
 * position in the transcript, and its own ability to be clicked and corrected.
 * A transcript of a technical conversation would be mostly fragments.
 *
 * Two signals, either of which is enough:
 *
 *   The tokenizer marks a word boundary with a LEADING SPACE on the token that
 *   starts it. A token without one continues what came before. This is the
 *   general rule and it is what reassembles byte-pair fragments.
 *
 *   A token that is only punctuation attaches backwards regardless. It is a
 *   belt-and-braces rule for the case where the space is present anyway, and it
 *   is safe because a lone punctuation mark is never a word someone wants to
 *   click, correct, or seek to.
 *
 * @param {string} raw the token's text as the engine gave it, spaces intact
 * @param {string} text the same text, trimmed
 * @returns {boolean}
 */
function continues(raw, text) {
  if (!/^\s/.test(raw)) return true
  // No letter and no digit anywhere: a full stop, a comma, an ellipsis, a
  // closing bracket, an em dash. Unicode-aware, because the punctuation of a
  // transcript is not necessarily ASCII.
  return !/[\p{L}\p{N}]/u.test(text)
}

/**
 * Centiseconds to seconds, defensively.
 *
 * Non-finite and negative values become 0 rather than propagating. A NaN start
 * makes every comparison in `wordAt`'s binary search false, which does not
 * throw -- it returns `null` for times that should have matched, somewhere else
 * entirely.
 *
 * @param {number} centiseconds
 * @returns {number}
 */
function seconds(centiseconds) {
  if (!Number.isFinite(centiseconds) || centiseconds < 0) return 0
  return centiseconds / 100
}
