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

> **Status: early.** Half of the first sentence above is true. Opening the site
> gets you a file chooser, a waveform, and a player — pick a recording and it is
> decoded in the page, drawn, and playable, and clicking the waveform seeks
> there. `src/core/` holds the transcript document too: the word and segment
> model, the editing operations, and SRT/VTT export, under test. What is missing
> is the part in the middle. There is no whisper yet, so nothing produces a
> transcript, and nothing draws one next to the audio.

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

## Layout

```
src/core/    timestamp maths, segment boundaries, peaks, SRT/VTT. No DOM, no fs.
src/web/     everything that needs a DOM: decode, canvas, playhead.
site/        the page: index.html, main.js, styles.css -> built to site/dist/
scripts/     build-site.mjs
test/        node --test
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
**Cloudflare Pages and Netlify read and GitHub Pages does not**. The dev server
sends them, so local development is isolated and a GitHub Pages deploy is not.
That is the wrong way round and it is deliberately written down in
`scripts/build-site.mjs`, `site/_headers`, and `.github/workflows/pages.yml`
rather than left to be discovered.

**The policy is generated, not written.** `src/core/engine.js` lists the origins
the app may fetch model weights from, and `scripts/build-site.mjs` builds
`connect-src` out of that list. Add a model host there and the policy follows;
add it to the policy by hand and you have created the drift the arrangement
exists to prevent.

## Licence

MIT. See [LICENSE](LICENSE).
