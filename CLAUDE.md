# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

`README.md` covers what the project is and how to run it, and is not repeated
here. This file covers what the README does not: the invariants a change can
break silently, and where they live.

The repository is currently a scaffold — the toolchain, the build, and the
security policy exist; the editor does not. Expect this file to grow as the
app does.

## Commands

```bash
npm test                  # unit suite, offline, ~1s
npm run typecheck         # TWO tsc invocations; see below
npm run build             # esbuild -> site/dist/
npm start                 # build + serve site/dist/ on :4173

node scripts/fetch-whisper.mjs   # build the wasm engine into vendor/whisper/
                                 # needs emscripten, or just Docker running.
                                 # Everything above works without it.

node --test test/build-site.test.mjs                                  # one file
node --test --test-name-pattern="connect-src" test/build-site.test.mjs # one test
```

Node is resolved through mise here (`mise install`, then `mise exec -- npm test`
or a shimmed shell). `mise.toml` mirrors every npm script as a task; either
runner works.

## Invariants

**`src/core/` must not touch the DOM or `fs`.** It is typechecked twice — once
under `tsconfig.json` with `types: []` and the DOM lib, once under
`tsconfig.node.json` with Node's globals. A stray `Buffer.from` in core passes
the second and fails the first. That double-check is the only thing making
"isomorphic" a build property rather than a comment. Always run both
(`npm run typecheck`), never one.

To confirm the split is still doing something, add `Buffer.from('x')` to a file
in `src/core/`: the browser project must fail and the Node project must pass. If
both pass, the split has become decorative and something in the tsconfigs is
wrong.

**The CSP is derived from `src/core/engine.js`, never written beside it.**
`ENGINE_ORIGINS` is the single list of hosts the page may fetch model weights
from, and `buildCSP` in `scripts/build-site.mjs` generates `connect-src` from
it. Adding a model host to one and not the other produces a page that works on
every warm cache and fails on the first cold load in production. `test/
build-site.test.mjs` asserts the derivation against the real build's output.

**`connect-src` entries must be bare origins, with no path.** A CSP source
carrying a path restricts matching to that path prefix, and a redirect drops the
path. Hugging Face redirects `resolve/` downloads to a separate CDN origin — so
a path-scoped entry fails in a way that looks like a network error, and the CDN
origins need their own entries. That hand-written pair in `engine.js` looks
redundant next to the derived list and is not; do not tidy it away.

**Cross-origin isolation depends on the host, so both engine builds have to
work.** COOP and COEP are in `site/_headers`, which **Netlify and Cloudflare
Pages read and GitHub Pages ignores**. The dev server in `scripts/build-site.mjs`
sends them too, so `npm start` is isolated. On a host that reads `_headers` the
threaded build loads and inference is several times faster; anywhere else — a
GitHub Pages deploy, a browser without `SharedArrayBuffer`, a preview URL served
without the headers — the single-threaded build loads instead.

That fallback is a real code path, not a theoretical one, and it is the one
nothing exercises by default. Anything conditional on `crossOriginIsolated` must
be run with those two `setHeader` calls in the dev server commented out before
it is believed. Do not write code that assumes `SharedArrayBuffer` exists.

The two builds are only genuinely different because
`scripts/fetch-whisper.mjs` makes whisper.cpp's unconditional `-pthread`
conditional. Without that edit both come out as byte-identical wasm that both
require `SharedArrayBuffer` — verified, not assumed: they had the same md5 until
it was added. If the single-threaded build ever starts failing on a
non-isolated host, compare the two `.wasm` files first.

**The engine is a patched build, and the patch is the only reason word timings
exist.** `whisper/emscripten.cpp` and `whisper/CMakeLists.txt` replace their
namesakes in whisper.cpp's tree at a pinned tag; `scripts/fetch-whisper.mjs`
copies them in and writes the resulting diff to `vendor/whisper/upstream.diff`.
Upstream's binding returns `0`/`-1` and prints through a `printf` callback — it
cannot return a timestamp — so reverting to it produces a build that compiles,
runs, and yields a transcript with every timing set to zero. If timings ever
come back as zeroes, check that diff first: an empty one means the overlay did
not land.

**Emscripten is built with `-sDYNAMIC_EXECUTION=0`, and that flag is
load-bearing.** The generated CSP grants `'wasm-unsafe-eval'` — WebAssembly
compilation and nothing else — and deliberately not `'unsafe-eval'`. Emscripten's
default output contains `eval` in paths this app never calls, and a CSP does not
care whether a branch is reachable: without the flag the glue fails to load at
all, and the obvious "fix" is to loosen the policy. Do not loosen the policy.

**Times are centiseconds until `src/core/whisper-adapter.js` and seconds
afterwards.** whisper.cpp reports token times in hundredths of a second. That
adapter divides by 100 exactly once and is the only file permitted to see the
other unit. A second division anywhere downstream produces a transcript that
looks plausible and is a hundred times too short.

**`site/main.js` refuses to run inside a frame, and that check is load-bearing.**
`frame-ancestors` is only honoured as an HTTP response header, and the deploy
host sets none. The in-page check is therefore the protection, not a backup for
it. Do not remove it on the grounds that the header covers it.

## Conventions

Plain JavaScript with JSDoc, checked by tsc. There is no compile step between
the file that is written and the file that runs. Do not introduce `.ts` sources
without a reason that survives that sentence.

No runtime dependencies. The engine is fetched WebAssembly, the waveform is a
canvas, the UI is the DOM. Adding a framework is a decision to make explicitly,
not one to arrive at through a convenient import.

Comments explain *why*, and particularly why an obvious alternative was not
taken. A comment restating the line below it is noise; a comment recording the
failure that a line prevents is the reason the line survives someone's cleanup.

Commit messages: `type(scope): imperative subject`, lowercase, then a prose body
saying why. Not a summary of the diff — the diff is already in the commit.
