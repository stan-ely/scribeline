// The binding between whisper.cpp and this application.
//
// THIS FILE REPLACES examples/whisper.wasm/emscripten.cpp IN THE UPSTREAM
// TREE. scripts/fetch-whisper.mjs copies it over that file after checking out
// the pinned tag, and writes the resulting diff to vendor/whisper/upstream.diff
// so what was changed is one file away rather than buried in a fork.
//
// WHY IT IS REPLACED AT ALL, since a patched build is a real cost to carry:
// upstream's binding exposes `full_default(index, audio, lang, nthreads,
// translate)`, which returns 0 or -1 and prints the transcript through a printf
// callback. There is no route from it to a timestamp. This application's whole
// premise is word-level timings -- src/core/transcript.js is built around words
// carrying their own -- so segment text scraped out of stdout is not a smaller
// version of the feature, it is a different application. Roughly forty lines
// below are the entire difference.
//
// Three changes, and nothing else:
//
//   1. `params.token_timestamps = true`, so whisper fills in per-token t0/t1.
//   2. The results are walked and returned as a JS object instead of printed.
//   3. `whisper_full` is called SYNCHRONOUSLY rather than on a detached
//      std::thread. Upstream needs that thread because it returns immediately
//      and prints later; we are already running inside a Web Worker, so
//      blocking is the correct behaviour and it is also what makes the
//      single-threaded build possible at all -- std::thread requires pthreads,
//      which requires SharedArrayBuffer, which is exactly what the deploy host
//      does not give us.
//
// Times are CENTISECONDS here and stay centiseconds all the way out. The single
// division into seconds happens in src/core/whisper-adapter.js and nowhere
// else.

#include "whisper.h"

#include <emscripten.h>
#include <emscripten/bind.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

std::vector<struct whisper_context *> g_contexts(4, nullptr);

// The JS callbacks for the run in progress. Globals rather than user_data
// pointers because whisper's callback signature carries a void* that would have
// to point at something outliving the call anyway, and there is only ever one
// run at a time per worker.
static emscripten::val g_on_segment = emscripten::val::undefined();
static emscripten::val g_on_progress = emscripten::val::undefined();

static inline int mpow2(int n) {
    int p = 1;
    while (p <= n) p *= 2;
    return p/2;
}

// Whether a token is one of whisper's own control tokens rather than a piece of
// text. Everything at or above the end-of-transcript id is special: the
// timestamp tokens, [_BEG_], [_TT_*], the language tokens. They carry timings
// and probabilities like any other token, so a transcript built without this
// check contains them, and they survive all the way into the subtitle file.
static inline bool is_special(struct whisper_context * ctx, whisper_token id) {
    return id >= whisper_token_eot(ctx);
}

// One segment as a JS object: its bounds, its text, and its tokens.
static emscripten::val segment_to_val(struct whisper_context * ctx, int i) {
    emscripten::val segment = emscripten::val::object();
    segment.set("t0", (double) whisper_full_get_segment_t0(ctx, i));
    segment.set("t1", (double) whisper_full_get_segment_t1(ctx, i));
    segment.set("text", std::string(whisper_full_get_segment_text(ctx, i)));

    emscripten::val tokens = emscripten::val::array();
    const int n_tokens = whisper_full_n_tokens(ctx, i);
    for (int j = 0; j < n_tokens; ++j) {
        if (is_special(ctx, whisper_full_get_token_id(ctx, i, j))) {
            continue;
        }

        emscripten::val token = emscripten::val::object();
        token.set("text", std::string(whisper_full_get_token_text(ctx, i, j)));
        // whisper_full_get_token_t0/t1, NOT whisper_full_get_token_data().t0/t1.
        // The two are identical today because this build does not enable VAD,
        // and they stop being identical the moment it does: the accessors map
        // back onto the original audio timeline while the struct's fields stay
        // in VAD-processed time, where the silences have been cut out. Reading
        // the struct would give a transcript whose timings drift further from
        // the audio the longer the recording is -- correct at the start, wrong
        // by the end, and never obviously either.
        token.set("t0", (double) whisper_full_get_token_t0(ctx, i, j));
        token.set("t1", (double) whisper_full_get_token_t1(ctx, i, j));
        token.set("p", (double) whisper_full_get_token_p(ctx, i, j));
        tokens.call<void>("push", token);
    }
    segment.set("tokens", tokens);

    return segment;
}

EMSCRIPTEN_BINDINGS(whisper) {
    emscripten::function("init", emscripten::optional_override([](const std::string & path_model) {
        for (size_t i = 0; i < g_contexts.size(); ++i) {
            if (g_contexts[i] == nullptr) {
                g_contexts[i] = whisper_init_from_file_with_params(path_model.c_str(), whisper_context_default_params());
                if (g_contexts[i] != nullptr) {
                    return i + 1;
                } else {
                    return (size_t) 0;
                }
            }
        }

        return (size_t) 0;
    }));

    emscripten::function("free", emscripten::optional_override([](size_t index) {
        --index;

        if (index < g_contexts.size()) {
            whisper_free(g_contexts[index]);
            g_contexts[index] = nullptr;
        }
    }));

    // Returns { segments: [{ t0, t1, text, tokens: [{ text, t0, t1, p }] }],
    //           language: string }
    //
    // or throws a JS Error. `on_segment` and `on_progress` may be undefined;
    // when they are not, they are called during the run, from this same thread,
    // which is a Web Worker's -- so they may post messages but must not expect
    // the DOM.
    emscripten::function("transcribe", emscripten::optional_override([](
                size_t index,
                const emscripten::val & audio,
                const std::string & lang,
                int nthreads,
                bool translate,
                emscripten::val on_segment,
                emscripten::val on_progress) {

        --index;

        if (index >= g_contexts.size() || g_contexts[index] == nullptr) {
            return emscripten::val::null();
        }

        struct whisper_context * ctx = g_contexts[index];

        struct whisper_full_params params = whisper_full_default_params(whisper_sampling_strategy::WHISPER_SAMPLING_GREEDY);
        const bool is_multilingual = whisper_is_multilingual(ctx);

        // Nothing is printed. Upstream's binding prints because printing is how
        // it returns; this one returns, so stdout would only be noise in a
        // console that has a page's own diagnostics in it.
        params.print_realtime   = false;
        params.print_progress   = false;
        params.print_timestamps = false;
        params.print_special    = false;

        params.translate        = translate;
        params.language         = is_multilingual ? strdup(lang.c_str()) : "en";
        params.n_threads        = std::min(nthreads, std::min(16, mpow2(std::thread::hardware_concurrency())));
        params.offset_ms        = 0;

        // THE REASON THIS FILE EXISTS. Without it every token's t0 and t1 come
        // back as zero and the transcript has no timings at all -- which draws
        // as a document whose every word begins at the start of the recording.
        params.token_timestamps = true;

        // Segments stay whisper's own -- roughly sentences, which is roughly a
        // subtitle cue, and a better first draft than anything derivable from
        // the timings. max_len is deliberately left at 0: setting it to 1 would
        // make every word its own segment, which is not word-level timing, it
        // is sentence-level segmentation thrown away.
        params.max_len          = 0;
        params.split_on_word    = true;

        g_on_segment  = on_segment;
        g_on_progress = on_progress;

        if (!g_on_segment.isUndefined() && !g_on_segment.isNull()) {
            params.new_segment_callback = [](struct whisper_context * ctx, struct whisper_state * /*state*/, int n_new, void * /*user_data*/) {
                const int n_segments = whisper_full_n_segments(ctx);
                // Partial results, as they are decoded. Whisper decodes in
                // order, so this is both the text so far and -- through the
                // last segment's end time -- honest progress. A four-minute
                // wait with something happening is a different experience from
                // a four-minute wait with a spinner.
                for (int i = n_segments - n_new; i < n_segments; ++i) {
                    g_on_segment(segment_to_val(ctx, i));
                }
            };
        }

        if (!g_on_progress.isUndefined() && !g_on_progress.isNull()) {
            params.progress_callback = [](struct whisper_context * /*ctx*/, struct whisper_state * /*state*/, int progress, void * /*user_data*/) {
                g_on_progress(progress);
            };
        }

        std::vector<float> pcmf32;
        const int n = audio["length"].as<int>();
        pcmf32.resize(n);

        emscripten::val heap = emscripten::val::module_property("HEAPU8");
        emscripten::val memory = heap["buffer"];
        emscripten::val memoryView = audio["constructor"].new_(memory, reinterpret_cast<uintptr_t>(pcmf32.data()), n);
        memoryView.call<void>("set", audio);

        whisper_reset_timings(ctx);
        const int status = whisper_full(ctx, params, pcmf32.data(), pcmf32.size());

        if (is_multilingual) {
            free((void*)params.language);
        }

        g_on_segment  = emscripten::val::undefined();
        g_on_progress = emscripten::val::undefined();

        if (status != 0) {
            return emscripten::val::null();
        }

        emscripten::val result = emscripten::val::object();
        emscripten::val segments = emscripten::val::array();

        const int n_segments = whisper_full_n_segments(ctx);
        for (int i = 0; i < n_segments; ++i) {
            segments.call<void>("push", segment_to_val(ctx, i));
        }

        result.set("segments", segments);
        result.set("language", std::string(whisper_lang_str(whisper_full_lang_id(ctx))));

        return result;
    }));
}
