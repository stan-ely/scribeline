# scribeline

A transcript editor that runs on your machine.

Open a recording. The waveform and the words sit on one timeline, so a
timestamp is a place you can see rather than a number you have to trust. Click a
word to jump there. Drag a segment boundary to fix where it starts. Export SRT
or VTT when it reads the way it should.

The transcription is [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
compiled to WebAssembly and run inside the page. There is no server, no upload,
and no account. Your audio does not leave the device, which is not a policy —
there is nowhere for it to go.

> **Status: early, but it works end to end.** Open a recording, see its
> waveform, play it, click it to seek. Pick a model, press Transcribe, and
> whisper.cpp runs as WebAssembly in the page and hands back a transcript with
> word-level timings — which you can download as SRT or VTT.
>
> What is missing is the editor. The transcript is not drawn next to the audio
> yet, so there is nothing to click a word in, nothing to drag a boundary on,
> and no way to fix a misheard name. `src/core/` already holds the document
> model and every operation that editor will call; what it does not have is a
> screen.
>
> Transcription needs the engine built once — see **Building the engine** below.
> Everything else works without it.

---

## Why it is built this way

**Word-level timestamps, not segment-level.** Whisper's segments are sentences,
and a sentence is too coarse a unit to edit against. Word timings are what make
click-to-jump land on the word you clicked and what make a dragged boundary mean
something.

**The waveform is the index.** Silence is visible, and the place where a speaker
stopped is usually the place where a segment should end. Showing the audio next
to the text turns "find the bad cut" from a listening task into a looking one.

**In the page, not on a server.** Recordings are interviews, therapy notes,
standups, someone's voice. The reason to run a 60 MB model in a browser tab
instead of calling an API is that it removes the question of what happens to the
file afterwards.

## Running it

The toolchain is Node and nothing else. [mise](https://mise.jdx.dev) pins the
version; plain npm works too if you already have Node 24.

```bash
mise install          # Node 24
npm ci

npm test              # unit suite, offline, ~1s
npm run typecheck     # two tsc projects -- see below
npm run build         # -> site/dist/
npm start             # build + serve site/dist/ on http://localhost:4173
```

`mise.toml` mirrors every npm script as a task, so `mise run build` and
`npm run build` do the same thing.

`localhost` counts as a secure context, so the file picker and the microphone
work against `npm start` without a certificate.

## Building the engine

Transcription needs a WebAssembly build of whisper.cpp, which is **not** in this
repository — it is compiled from a pinned tag into `vendor/whisper/`:

```bash
node scripts/fetch-whisper.mjs      # both builds
node scripts/fetch-whisper.mjs --single   # just the one that ships
```

It needs emscripten. If `emcmake` is on your `PATH` it is used directly;
otherwise the script runs a pinned `emscripten/emsdk` image, so **Docker running
is enough** — nothing needs installing. It takes a few minutes the first time.

Everything else works without it. `npm test`, `npm run typecheck`, `npm run
build`, and `npm start` all succeed with `vendor/whisper/` absent; the page
loads, draws, and plays, and only the Transcribe button is inert.

**Why it is built rather than downloaded.** whisper.cpp's own WebAssembly
example exposes a binding that returns `0` or `-1` and prints the transcript
through a `printf` callback — it cannot return a timestamp. This app is built on
words carrying their own timings, so `whisper/emscripten.cpp` replaces that
binding with one that returns whisper's token times as data. It is about forty
lines, it is the reason any of this works, and the diff against upstream is
written to `vendor/whisper/upstream.diff` on every build.

## Layout

```
src/core/    timestamp maths, segment boundaries, peaks, model download,
             the whisper adapter, SRT/VTT. No DOM, no fs.
src/web/     everything that needs a DOM: decode, canvas, playhead, worker client.
site/        the page: index.html, main.js, styles.css, whisper-worker.js
             -> built to site/dist/
whisper/     the two files that replace their namesakes in whisper.cpp's tree
scripts/     build-site.mjs, fetch-whisper.mjs
test/        node --test
vendor/      the built engine. Generated, never committed.
```

`src/core/` is typechecked twice, once with the DOM and `types: []` and once
with Node's globals. That double-check is what makes "isomorphic" a property of
the build rather than a comment: a `Buffer.from` in core passes the Node project
and fails the browser one. Run `npm run typecheck`, never one half of it.

## Two things worth knowing before you deploy it

**Threaded inference needs two response headers.** whisper.cpp runs many times
faster with threads, threads need `SharedArrayBuffer`, and browsers only expose
that to a cross-origin-isolated page — which requires
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. They are in `site/_headers`, which
**Netlify and Cloudflare Pages read and GitHub Pages does not**.

So the host decides which engine loads, and both builds ship. Where the headers
arrive, the page loads `whisper-mt.js` and uses every core; where they do not,
it loads `whisper.js` and runs on one. The dev server sends them, so `npm start`
matches an isolated deploy — which means the single-threaded path is the one
local development never exercises. `SCRIBELINE_NO_ISOLATION=1 npm start`
withholds the headers, so that path can be tried without editing anything.

**Deploying somewhere that needs the engine built.** The engine is compiled, not
committed, and `scripts/fetch-whisper.mjs` reaches for Docker when no `emcmake`
is on `PATH` — which most hosted build environments do not provide. The
practical arrangement is to build it in CI, where Docker or emsdk is available
and the result can be cached on the whisper.cpp tag, and to publish the finished
`site/dist/` from there.

**The policy is generated, not written.** `src/core/engine.js` lists the origins
the app may fetch model weights from, and `scripts/build-site.mjs` builds
`connect-src` out of that list. Add a model host there and the policy follows;
add it to the policy by hand and you have created the drift the arrangement
exists to prevent.

## Licence

MIT. See [LICENSE](LICENSE).
