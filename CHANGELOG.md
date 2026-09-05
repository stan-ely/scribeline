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

The engine arrived. Open a recording, pick a model, press Transcribe, and get
an SRT or a VTT back. whisper.cpp runs as WebAssembly in a worker on the page,
the weights are downloaded once and kept in the Cache API, and the audio still
never leaves the machine.

It is a patched build, and that is the thing worth knowing. Upstream's
emscripten binding exposes `full_default`, which returns 0 or -1 and prints the
transcript through a printf callback — there is no route from it to a
timestamp. Since this app is built on words carrying their own timings, the
forty lines in `whisper/emscripten.cpp` that turn whisper's token times into a
returned value are the difference between it and a different, worse app.
`scripts/fetch-whisper.mjs` builds it from a pinned tag with emscripten, through
Docker on a machine without a toolchain, and writes the diff against upstream
next to the output so what was changed stays one file away.

Two builds are produced and the host picks. The threaded one needs
`SharedArrayBuffer` and therefore the two headers in `site/_headers`, which
Netlify and Cloudflare Pages read and GitHub Pages ignores; anywhere the headers
do not arrive, the single-threaded build loads instead and runs on one core.
Both have been run end to end -- `SCRIBELINE_NO_ISOLATION=1 npm start` withholds
the headers from the dev server, so the fallback is a command rather than an
edit somebody has to remember to undo, which is why it went untested before.

Making those two builds actually different took an edit nobody would guess at.
whisper.cpp compiles every emscripten target with `-pthread` unconditionally, so
link flags cannot turn threading off — the first pair came out as byte-identical
wasm, both requiring `SharedArrayBuffer`, and the "single-threaded" build was
single-threaded in name only. `scripts/fetch-whisper.mjs` now makes those two
lines conditional, and asserts on the exact text so an upstream change fails the
build rather than quietly producing one binary twice.

Neither build contains an `eval`. `DYNAMIC_EXECUTION=0` is passed to emscripten
because the generated policy grants `'wasm-unsafe-eval'` — which permits
WebAssembly compilation and nothing else — and deliberately not `'unsafe-eval'`.
A CSP does not care whether a branch is reachable, so without that flag the glue
would fail to load and the honest fix would look like loosening the policy.

A whisper token is not a word, and the first real transcript said so: three
seconds of audio came back as `once upon a time .`, five words, the last of
them a full stop. The tokenizer is byte-pair and marks a word boundary with a
leading space, so punctuation arrives as its own token and a long word arrives
in pieces — "unbelievable" as `un`, `bel`, `iev`, `able`. Left alone that is a
transcript of fragments, each one separately clickable and separately wrong.
The adapter now joins a token to the word before it when it carries no leading
space, and takes the least confident piece as the word's confidence, because a
word is only as trustworthy as its worst part.

The threaded build deadlocked, and the reason is worth writing down. This
binding calls `whisper_full` synchronously; emscripten starts a pthread by
posting to a Worker and waiting for it to come up, which needs the starting
thread's event loop to run — and that thread is blocked inside `whisper_full`
waiting for the very threads it is trying to start. A three-second clip
transcribed forever. Upstream never meets this because it runs `whisper_full`
on a detached thread and prints its results instead of returning them. The fix
is `PTHREAD_POOL_SIZE`, which spawns the workers during module instantiation,
before anything blocks.

The policy needed new redirect targets, and finding out how was the point of
trying it against a real network. Hugging Face has moved `resolve/` downloads
onto Xet storage, so a request to `huggingface.co` now redirects to
`<region>.aws.cdn.hf.co` rather than to the `cdn-lfs` hosts named in
`engine.js`. A CSP blocks a redirect to an origin it does not name, so the
download failed with `Failed to fetch` — which is precisely the failure that
list of hand-written origins was written to prevent, arriving anyway because
the destination changed underneath it. The entry is a wildcard, because the
subdomain names the region the client is served from: one host would have
worked in the country it was tested in.

Three smaller things that were wrong and are now not. `WASM_PATH` named a bare
`.wasm` file, which emscripten never emits — what is loaded is JS glue — and it
began with a slash, which resolves to the domain root on a project Pages site
served from `/scribeline/`: correct in every local test and a 404 in production.
Audio is now decoded straight to whisper's 16 kHz instead of the output device's
rate, which is a sixth of the memory on an hour-long recording and a resample
nobody has to write. And `npm test` names its directory, now that a checkout of
whisper.cpp with its own test suite lives under `vendor/`.

Thirty more tests, so eighty-two. The transcript still is not drawn on
the page — this slice was about making the thing underneath it trustworthy
first.
