#
# Replaces examples/whisper.wasm/CMakeLists.txt in the upstream tree.
#
# WHY IT IS REPLACED: upstream sets LINK_FLAGS on the target directly, with
# `-s USE_PTHREADS=1` written into the string. There is no way to build a
# single-threaded variant without editing this file -- and the single-threaded
# variant is the ONLY one that ever runs on this project's deploy host, which
# sends no COOP/COEP and therefore has no SharedArrayBuffer. See the header
# comment in scripts/build-site.mjs.
#
# Everything below is upstream's flag list plus four changes, each load-bearing:
#
#   USE_PTHREADS is conditional (SCRIBELINE_THREADS), so both variants build.
#
#   DYNAMIC_EXECUTION=0 removes every eval() and new Function() from the
#   generated glue. The page's generated CSP grants 'wasm-unsafe-eval' -- which
#   permits WebAssembly compilation and nothing else -- and deliberately not
#   'unsafe-eval'. A CSP does not care whether a branch is reachable, so without
#   this flag the glue fails to load at all, and the app's whole security
#   posture would have to be loosened to accommodate code paths it never calls.
#
#   MODULARIZE + EXPORT_ES6 make the output an ES module with a factory as its
#   default export, so the worker can `await import()` it. Upstream's output
#   assigns a global, which would need a script tag and a page-level name.
#
#   OUTPUT_NAME is a parameter, so the two variants emit whisper.js/whisper.wasm
#   and whisper-mt.js/whisper-mt.wasm. Emscripten writes the .wasm filename into
#   the .js, so the two builds cannot simply be renamed after the fact -- they
#   would both look for libmain.wasm and one would silently load the other's.
#
# The `whisper.wasm` demo-page target from upstream is dropped: this project
# serves its own page.
#

set(TARGET libmain)

add_executable(${TARGET}
    emscripten.cpp
    )

include(DefaultTargetOptions)

target_link_libraries(${TARGET} PRIVATE
    whisper
    )

if (NOT DEFINED SCRIBELINE_OUTPUT_NAME)
    set(SCRIBELINE_OUTPUT_NAME "whisper")
endif()

set_target_properties(${TARGET} PROPERTIES OUTPUT_NAME ${SCRIBELINE_OUTPUT_NAME})

if (SCRIBELINE_THREADS)
    # PTHREAD_POOL_SIZE IS NOT A TUNING KNOB, IT IS THE DIFFERENCE BETWEEN
    # WORKING AND HANGING. The binding calls whisper_full synchronously, which
    # blocks this thread until the whole recording is transcribed. Emscripten
    # spawns a pthread by posting a message to a Worker and waiting for it to
    # come up -- which requires the spawning thread's event loop to run. It
    # cannot: it is blocked inside whisper_full waiting for the very threads it
    # is trying to create. A three-second clip transcribed forever, observed.
    #
    # A pre-spawned pool is created during module instantiation, before anything
    # blocks, so ggml finds its workers already alive. Upstream avoids the same
    # deadlock differently, by running whisper_full on a detached std::thread and
    # returning immediately -- which it can do because it prints its results
    # instead of returning them, and which this binding cannot.
    #
    # Keep this >= the largest n_threads the page ever asks for; see
    # threadCount() in site/whisper-worker.js, which caps at 8.
    set(THREAD_FLAGS "-s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=8 -s PTHREAD_POOL_SIZE_STRICT=0")
    message(STATUS "scribeline: threaded build (needs SharedArrayBuffer)")
else()
    set(THREAD_FLAGS "")
    message(STATUS "scribeline: single-threaded build (runs anywhere)")
endif()

# INITIAL_MEMORY is lower than upstream's 512MB because growth is on and this
# runs on phones: half a gigabyte reserved up front is an allocation failure on
# a device that would have coped with growing into it.
set_target_properties(${TARGET} PROPERTIES LINK_FLAGS " \
    --bind \
    ${THREAD_FLAGS} \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME=createWhisperModule \
    -s ENVIRONMENT=web,worker \
    -s DYNAMIC_EXECUTION=0 \
    -s INITIAL_MEMORY=256MB \
    -s MAXIMUM_MEMORY=2000MB \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s FORCE_FILESYSTEM=1 \
    -s EXPORTED_RUNTIME_METHODS=\"['FS', 'HEAPU8', 'print', 'printErr']\" \
    ")
