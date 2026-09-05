/**
 * Constants that do not exist until the build substitutes them.
 *
 * `tsconfig.json` and `tsconfig.node.json` both already include `types/`, which
 * is why this directory was named there before anything needed it.
 *
 * These are esbuild `define` replacements, not variables: by the time the
 * bundle runs, the identifier has been replaced by a literal. Declaring them
 * here is what lets the checker see the same thing the bundler will produce,
 * rather than an undefined global that every reference has to be silenced
 * against one at a time.
 */

/**
 * The built transcription worker's filename, content-hashed.
 *
 * Written by scripts/build-site.mjs, which builds the worker first precisely so
 * that this name exists to substitute. See `bundle()` there.
 */
declare const __WHISPER_WORKER__: string
