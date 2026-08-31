/**
 * SRT and VTT serialization.
 *
 * The two formats are the same document twice, and the differences between them
 * are small enough to look like typos and large enough to make a file that one
 * player accepts and another silently ignores. They are handled here in one
 * place, by two functions over one formatter, so that the differences are
 * visible side by side rather than spread across two exporters that were
 * copy-pasted apart.
 *
 * Isomorphic: no DOM, no fs. This returns a string; whoever wants it in a file
 * or a Blob is the one that knows how.
 */

import { segmentStart, segmentEnd } from './transcript.js'

/** @typedef {import('./transcript.js').Transcript} Transcript */
/** @typedef {import('./transcript.js').Segment} Segment */

/**
 * The line length a cue is wrapped at, in characters.
 *
 * 42 is the broadcast convention -- roughly what fits across a video frame at a
 * readable size -- and it is a default rather than a rule, which is why it is
 * an option. Wrapping matters more than it looks: an unwrapped cue is broken by
 * the player wherever the player likes, including mid-name. The words are
 * already here, so breaking between them is a few lines of code and it is the
 * difference between a file that exports and a file that is usable.
 */
const DEFAULT_MAX_LINE_LENGTH = 42

/**
 * The most lines a single cue may occupy.
 *
 * Two is the convention and it is not arbitrary: a third line pushes far enough
 * into the frame to cover faces, and a cue needing three lines is a cue that
 * should have been split in two. This exporter does not split it -- that is an
 * editing decision belonging to someone who can hear the audio -- so an
 * over-long cue keeps its overflow on the last line rather than growing.
 */
const MAX_LINES = 2

/**
 * @typedef {{ maxLineLength?: number }} SubtitleOptions
 */

/**
 * Render a transcript as SubRip (.srt).
 *
 * Cues are numbered from 1, timecodes use a COMMA before the milliseconds, and
 * lines end with CRLF -- all three are what the format specifies and what the
 * stricter players check.
 *
 * @param {Transcript} transcript
 * @param {SubtitleOptions} [options]
 * @returns {string}
 */
export function toSRT(transcript, options = {}) {
  const cues = cuesOf(transcript, options)

  const blocks = cues.map((cue, i) => {
    const from = formatTimecode(cue.start, ',')
    const to = formatTimecode(cue.end, ',')
    return `${i + 1}\r\n${from} --> ${to}\r\n${cue.lines.join('\r\n')}\r\n`
  })

  return blocks.join('\r\n')
}

/**
 * Render a transcript as WebVTT (.vtt).
 *
 * The `WEBVTT` header is mandatory -- a file without it is rejected outright by
 * every browser, which is the most common way a hand-rolled VTT fails.
 * Timecodes use a FULL STOP before the milliseconds, where SRT uses a comma.
 * Cues are not numbered: VTT allows an identifier line but does not want a bare
 * integer standing in for one.
 *
 * @param {Transcript} transcript
 * @param {SubtitleOptions} [options]
 * @returns {string}
 */
export function toVTT(transcript, options = {}) {
  const cues = cuesOf(transcript, options)

  const blocks = cues.map((cue) => {
    const from = formatTimecode(cue.start, '.')
    const to = formatTimecode(cue.end, '.')
    return `${from} --> ${to}\n${cue.lines.join('\n')}\n`
  })

  return `WEBVTT\n\n${blocks.join('\n')}`
}

/**
 * @typedef {{ start: number, end: number, lines: string[] }} Cue
 */

/**
 * The transcript reduced to what both formats need: a time range and some
 * lines. Everything format-specific happens after this.
 *
 * Segments with no words are dropped rather than emitted as empty cues. They
 * should not exist -- the operations in transcript.js preserve non-emptiness --
 * but an empty cue is a parse error in some players and an invisible flicker in
 * the rest, so a transcript assembled by hand does not get to produce one.
 *
 * @param {Transcript} transcript
 * @param {SubtitleOptions} options
 * @returns {Cue[]}
 */
function cuesOf(transcript, options) {
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH

  /** @type {Cue[]} */
  const cues = []
  for (const segment of transcript.segments) {
    const start = segmentStart(segment)
    const end = segmentEnd(segment)
    if (start === null || end === null) continue

    const lines = wrap(textOf(segment), maxLineLength)
    if (lines.length === 0) continue

    cues.push({ start, end, lines })
  }
  return cues
}

/**
 * A segment's words joined into a line of text.
 *
 * Words arrive from whisper with their leading space attached (" the", " cat"),
 * because that is how the tokenizer sees them and stripping it upstream would
 * lose the distinction between a word and a suffix. Joining with a single space
 * and then collapsing runs is what turns either convention -- spaced or bare --
 * into the same output, without this function having to know which one it got.
 *
 * @param {Segment} segment
 * @returns {string}
 */
function textOf(segment) {
  return segment.words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Break `text` into at most `MAX_LINES` lines of at most `maxLineLength`
 * characters, splitting only between words.
 *
 * A word longer than the limit is left whole on its own line rather than cut: a
 * URL or a long compound is still readable when it overflows and is not when it
 * is severed. Once the last permitted line is reached everything remaining goes
 * onto it, for the reason given at MAX_LINES.
 *
 * @param {string} text
 * @param {number} maxLineLength
 * @returns {string[]}
 */
function wrap(text, maxLineLength) {
  if (!text) return []

  /** @type {string[]} */
  const lines = []
  let line = ''

  for (const word of text.split(' ')) {
    if (!line) {
      line = word
    } else if (
      line.length + 1 + word.length <= maxLineLength ||
      lines.length === MAX_LINES - 1
    ) {
      line += ' ' + word
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)

  return lines
}

/**
 * Seconds as `HH:MM:SS<sep>mmm`.
 *
 * `sep` is the whole reason this is one function rather than two: SRT writes a
 * comma there and VTT writes a full stop, and that single character is the
 * difference between a file a player reads and a file it discards without an
 * error message. Passing it in puts the two calls next to each other in this
 * file, where the discrepancy is legible, instead of in two exporters that
 * drift.
 *
 * Hours are always present and always two digits. Both formats permit omitting
 * the hour field, and enough players mis-parse the short form that emitting it
 * is a gamble with nothing to win.
 *
 * Negative times are clamped to zero. They should not occur, a cue at
 * `-00:00:01,500` would be a parse error, and zero is at least a time.
 *
 * @param {number} seconds
 * @param {',' | '.'} sep
 * @returns {string}
 */
function formatTimecode(seconds, sep) {
  // Rounded to milliseconds FIRST, then decomposed. Rounding after splitting
  // lets 59.9996s produce 59 seconds and 1000 milliseconds -- a timecode of
  // 00:00:59,1000, which is not a number of milliseconds and not a time.
  const totalMs = Math.max(0, Math.round(seconds * 1000))

  const ms = totalMs % 1000
  const totalSeconds = (totalMs - ms) / 1000
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)

  /**
   * @param {number} n
   * @param {number} width
   */
  const pad = (n, width) => String(n).padStart(width, '0')

  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(ms, 3)}`
}
