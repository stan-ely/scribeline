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

Still no editor, no waveform, and no whisper: the page continues to render the
placeholder.
