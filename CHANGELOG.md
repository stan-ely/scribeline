# Changelog

Notable changes, in prose. Versions follow [semver](https://semver.org).

## Unreleased

Nothing released yet.

The transcript document now exists. `src/core/transcript.js` defines what a
transcription is — words carrying their own timings, grouped into segments —
and the operations an editor performs on one: split, merge, drag a boundary,
correct a word, and find the word being spoken at a given moment.

Two decisions in there are worth knowing about, because they constrain
everything built on top. A segment has no timestamps of its own; its bounds are
its first and last word, so a boundary that disagrees with the text between it
is not a bug to be fixed but a state that cannot be written down. And every
operation returns a new transcript rather than editing one, because undo over a
mutable tree is a diffing problem and over an immutable one it is a list.

`src/core/subtitles.js` renders that document as SRT or VTT, wrapping cues
between words at a configurable line length. The two formats differ by about
three characters — a comma against a full stop, a header line, cue numbering —
and each difference is the kind that produces a file a player discards without
saying why, so they are generated from one path with the differences visible
side by side.

Both are covered by the offline suite, which is now thirty-six tests rather
than six.

Dropped the `playwright` devDependency. Nothing imported it; it was reserved
for a browser-driven check that does not exist yet, and until that check is
written it was a large install on every CI run buying nothing. It comes back
with the commit that uses it.

The placeholder screen is gone. Opening the site now gets you a file chooser, a
waveform, and a player: pick or drop a recording and it is decoded in the page,
drawn, and playable, with a playhead that tracks it and a click anywhere on the
waveform seeking there.

The split between `src/core/` and `src/web/` was drawn where the tests are.
`src/core/peaks.js` reduces a few million samples to one min/max pair per pixel
column and `src/core/timeline.js` maps a time to a position and back; both are
arithmetic, both run in the offline suite, and both are where a waveform goes
wrong in ways that still draw a plausible picture. What is left in `src/web/` is
glue small enough to read: get an `AudioBuffer`, fill a path, move an element.

Two things about that drawing are worth knowing, because they are easy to
"simplify" back. A column keeps both its bounds rather than one magnitude, so an
asymmetric or offset signal draws as itself instead of as a mirrored blob. And
the canvas is painted once per file and once per resize, never during playback —
the playhead is a separate element moved by a CSS custom property, which is the
consumer the policy's `style-src 'unsafe-inline'` was granted for all along.

Playback is an `<audio>` element over an object URL, and the `AudioContext` is
opened to decode and closed immediately after. The element brings native
transport, seeking, and a `currentTime` already in the seconds the core speaks;
the context, left open, would hold an audio output device for a file nobody
played.

Sixteen more tests, so fifty-two. Still no transcript on the page and no
whisper — this slice builds the timeline the words will be positioned against.
