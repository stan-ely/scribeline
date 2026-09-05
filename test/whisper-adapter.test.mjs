/**
 * The adapter between whisper.cpp's output and the transcript document.
 *
 * This is the boundary where outside data becomes a document the rest of the
 * app trusts, so the cases that matter are the malformed ones: a token with no
 * text, a segment with nothing left in it, timings that overlap or run
 * backwards. Every one of those has a wrong answer that does not throw -- it
 * produces a transcript that looks fine and makes `wordAt` return null forever
 * -- so each assertion below says which failure it is preventing.
 *
 * Offline and instant. Nothing here touches the network, the DOM, or the disk.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toTranscript } from '../src/core/whisper-adapter.js'
import { wordAt, totalWords, segmentStart, segmentEnd } from '../src/core/transcript.js'
import { toSRT } from '../src/core/subtitles.js'

/**
 * A raw segment from tokens given as `[text, t0, t1, p?]`, in CENTISECONDS --
 * the unit the engine actually speaks, so these tests fail if the division ever
 * moves or is done twice.
 *
 * @param {Array<[string, number, number, number?]>} tokens
 */
const seg = (tokens) => ({
  tokens: tokens.map(([text, t0, t1, p]) => ({ text, t0, t1, p: p ?? 0.9 })),
})

test('centiseconds become seconds, exactly once', () => {
  const transcript = toTranscript({ segments: [seg([['Hello', 120, 155]])] }, 10)
  const word = transcript.segments[0].words[0]

  assert.equal(word.start, 1.2, 'a t0 of 120 centiseconds is 1.2 seconds')
  assert.equal(word.end, 1.55, 'a t1 of 155 centiseconds is 1.55 seconds')
})

test('a word carries its probability through as confidence', () => {
  const transcript = toTranscript({ segments: [seg([['Hello', 0, 50, 0.42]])] }, 10)

  assert.equal(
    transcript.segments[0].words[0].confidence,
    0.42,
    'the engine reported a probability and it did not reach the document',
  )
})

test('a token with no probability leaves confidence absent, not zero', () => {
  const raw = { segments: [{ tokens: [{ text: 'Hello', t0: 0, t1: 50, p: NaN }] }] }
  const word = toTranscript(raw, 10).segments[0].words[0]

  assert.ok(
    !Object.hasOwn(word, 'confidence'),
    'absent confidence must stay absent -- zero is the most confident possible ' +
      'statement of the wrong thing, and a UI that dims low-confidence words ' +
      'would dim every word the engine simply did not score',
  )
})

test('whitespace-only tokens are dropped', () => {
  // whisper's tokenizer carries a word's leading space as part of it, and a
  // segment routinely opens with a token that is nothing but that space.
  const transcript = toTranscript(
    { segments: [seg([[' ', 0, 10], ['Hello', 10, 60], ['', 60, 70]])] },
    10,
  )

  assert.equal(
    totalWords(transcript),
    1,
    'an empty word exports as a double space and draws as a gap nothing can click',
  )
  assert.equal(transcript.segments[0].words[0].text, 'Hello')
})

test('a token keeps its text trimmed', () => {
  const transcript = toTranscript({ segments: [seg([[' Hello', 0, 50]])] }, 10)

  assert.equal(
    transcript.segments[0].words[0].text,
    'Hello',
    "the tokenizer's leading space belongs to the format, not to the word",
  )
})

test('a trailing full stop joins the word before it', () => {
  // The first transcript this app ever produced came back as
  // "once upon a time ." -- five words, the last of which was the period.
  const transcript = toTranscript(
    {
      segments: [
        seg([
          [' once', 0, 40],
          [' upon', 40, 70],
          [' a', 70, 90],
          [' time', 90, 190],
          ['.', 190, 201],
        ]),
      ],
    },
    3,
  )
  const words = transcript.segments[0].words

  assert.equal(totalWords(transcript), 4, 'a lone full stop is not a word')
  assert.equal(words[3].text, 'time.', 'it belongs to the word it follows')
  assert.equal(
    // CRLF, because that is what SubRip specifies and what subtitles.js emits.
    toSRT(transcript).split('\r\n')[2],
    'once upon a time.',
    'and the exported cue reads as a sentence, not "time ." with a space',
  )
})

test('byte-pair fragments are reassembled into one word', () => {
  // The tokenizer splits long or unusual words into pieces, and only the first
  // carries the leading space that marks a word boundary.
  const transcript = toTranscript(
    { segments: [seg([[' un', 0, 20], ['bel', 20, 40], ['iev', 40, 60], ['able', 60, 90]])] },
    3,
  )
  const word = transcript.segments[0].words[0]

  assert.equal(totalWords(transcript), 1, 'four tokens, one word')
  assert.equal(word.text, 'unbelievable')
  assert.equal(word.start, 0, 'it starts when its first piece did')
  assert.equal(word.end, 0.9, 'and ends when its last piece did')
})

test('a reassembled word is as confident as its least confident piece', () => {
  const transcript = toTranscript(
    { segments: [seg([[' un', 0, 20, 0.9], ['likely', 20, 60, 0.3]])] },
    3,
  )

  assert.equal(
    transcript.segments[0].words[0].confidence,
    0.3,
    'averaging would let certain syllables hide a guessed one, which is the ' +
      'opposite of what dimming uncertain words is for',
  )
})

test('punctuation attaches backwards even when it arrives spaced', () => {
  const transcript = toTranscript({ segments: [seg([[' yes', 0, 40], [' ?', 40, 50]])] }, 3)

  assert.equal(transcript.segments[0].words[0].text, 'yes?')
  assert.equal(totalWords(transcript), 1)
})

test('punctuation opening a segment stays a word rather than vanishing', () => {
  // Nothing to attach to. Keeping it is better than dropping text the model
  // reported, and better than crashing on an empty word list.
  const transcript = toTranscript({ segments: [seg([['...', 0, 20], [' well', 20, 60]])] }, 3)

  assert.equal(transcript.segments[0].words[0].text, '...')
  assert.equal(totalWords(transcript), 2)
})

test('a segment left with no words is dropped entirely', () => {
  const transcript = toTranscript(
    { segments: [seg([[' ', 0, 10]]), seg([['Hello', 10, 60]])] },
    10,
  )

  assert.equal(
    transcript.segments.length,
    1,
    'an empty segment has no bounds to derive, and wordAt refuses to guess ' +
      'which side of one to search -- so it would return null for every time ' +
      'after it, not just inside it',
  )
  assert.equal(segmentStart(transcript.segments[0]), 0.1)
})

test('no segments at all gives a transcript with none, not one empty one', () => {
  const transcript = toTranscript({ segments: [] }, 12.5)

  assert.deepEqual(transcript.segments, [], 'a silent recording has no segments')
  assert.equal(transcript.duration, 12.5, 'and still knows how long it was')
})

test('overlapping tokens are pulled into order', () => {
  // Token timestamps are a by-product of the decoder's attention rather than a
  // measurement, and a few per recording come back overlapping the one before.
  const transcript = toTranscript({ segments: [seg([[' one', 0, 100], [' two', 60, 150]])] }, 10)
  const [first, second] = transcript.segments[0].words

  assert.equal(
    second.start,
    first.end,
    'wordAt binary-searches on the assumption that words are ordered; an ' +
      'overlap makes it return the wrong word or none at all',
  )
  assert.equal(second.end, 1.5, 'only the start moved -- the reported end still stands')
})

test('ordering is enforced across a segment boundary, not just within one', () => {
  const transcript = toTranscript(
    { segments: [seg([['one', 0, 100]]), seg([['two', 50, 200]])] },
    10,
  )

  assert.ok(
    (segmentStart(transcript.segments[1]) ?? 0) >= (segmentEnd(transcript.segments[0]) ?? 0),
    'segments must be time-ordered for the outer binary search in wordAt, and ' +
      'a segment boundary is exactly where an overlap shows up',
  )
})

test('a zero-length token is given an interval it can be found in', () => {
  const transcript = toTranscript({ segments: [seg([['blip', 300, 300]])] }, 10)
  const word = transcript.segments[0].words[0]

  assert.ok(word.end > word.start, 'a word with no extent is invisible to the playhead forever')
  assert.deepEqual(
    wordAt(transcript, 3),
    { segmentIndex: 0, wordIndex: 0 },
    'wordAt matches on [start, end), so start === end matches no time at all',
  )
})

test('the transcript is at least as long as the words it holds', () => {
  // A model can time a token past the end of the audio it was handed.
  const transcript = toTranscript({ segments: [seg([['late', 0, 1200]])] }, 10)

  assert.equal(
    transcript.duration,
    12,
    'a duration shorter than the last word puts the end of the transcript off ' +
      'the right edge of the waveform it is drawn against',
  )
})

test('a missing duration does not produce NaN', () => {
  const transcript = toTranscript({ segments: [seg([['Hello', 0, 50]])] }, NaN)

  assert.equal(transcript.duration, 0.5, 'falls back to the words, not to NaN')
})

test('the detected language is carried, and absent when not reported', () => {
  const withLang = toTranscript({ segments: [], language: 'en' }, 1)
  const without = toTranscript({ segments: [] }, 1)

  assert.equal(withLang.language, 'en')
  assert.ok(!Object.hasOwn(without, 'language'), 'not asked for is not the same as unknown')
})

test('the result is a document the existing operations can drive', () => {
  // The point of the adapter: what comes out is what transcript.js consumes.
  const transcript = toTranscript(
    {
      segments: [
        seg([[' The', 0, 30], [' quick', 30, 70], [' fox', 70, 120]]),
        seg([[' jumped', 150, 200]]),
      ],
    },
    5,
  )

  assert.equal(totalWords(transcript), 4)
  assert.deepEqual(
    wordAt(transcript, 0.5),
    { segmentIndex: 0, wordIndex: 1 },
    'the playhead at 0.5s is inside "quick"',
  )
  assert.equal(wordAt(transcript, 1.3), null, 'and in the gap between segments it is in silence')
})
