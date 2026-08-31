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

**Cross-origin isolation is not available on the deploy host.** COOP and COEP
are in `site/_headers`, which GitHub Pages ignores. The dev server in
`scripts/build-site.mjs` *does* send them, so local development is cross-origin
isolated and production is not. Anything conditional on `crossOriginIsolated` —
which will include the choice between the threaded and single-threaded whisper
builds — must be exercised with those headers removed before it is believed. Do
not write code that assumes `SharedArrayBuffer` exists.

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
