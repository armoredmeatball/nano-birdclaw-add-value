# nano-birdclaw-add-value

A single-file X/Twitter digest that finds the conversations you can actually add value to — inspired by [birdclaw](https://github.com/steipete/birdclaw), distilled to ~1250 lines with zero dependencies.

## What you get

One streamed Markdown report over your home timeline and mentions, with sections like "What people are talking about", "Important links shared", "Worth opening", and "Worth weighing in on" — and under **every** bullet, exactly one nested sub-bullet naming a concrete, conversation-specific way *you* could add value (first-hand experience, a sharp question, a resource, a counterpoint, a quote-post angle). Generic "share your thoughts" filler is banned by the prompt; bullets without a real angle get dropped.

```markdown
## What people are talking about
- @charliermarsh shipped a Rust-based type checker preview and is asking for
  pathological codebases to benchmark against (tweet_2075281721050759474).
  - **Add value:** Offer your 400k-line monorepo as a benchmark case and share
    the mypy timings you already measured (tweet_2075281721050759474).
```

## Requirements

- Node >= 20
- The [bird](https://github.com/steipete/bird) CLI: `npm install -g @steipete/bird` — be logged into X in your browser; bird reads your browser cookies, no API keys needed
- `OPENAI_API_KEY` (or any OpenAI-compatible endpoint via `OPENAI_BASE_URL`)

## Install

One file, zero dependencies — nothing to build or publish. Clone it, then run it with Node (see Requirements above):

```sh
git clone https://github.com/armoredmeatball/nano-birdclaw-add-value
cd nano-birdclaw-add-value
```

## Quickstart

```sh
# Serve the web UI at http://127.0.0.1:8787 (streams as it generates)
node nano-birdclaw.mjs

# One-shot CLI mode: markdown to stdout, status to stderr
node nano-birdclaw.mjs today
node nano-birdclaw.mjs 24h --limit 200 --refresh > digest.md
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `<period>` | — | `today`, `24h`, `yesterday`, or `week`; run once to stdout. No period = serve the web UI |
| `--limit N` | 100 | Home-timeline tweets to fetch (`bird home -n N`) |
| `--mentions N` | 100 | Mentions to fetch |
| `--following` | off | Use the chronological Following feed; default is For You |
| `--refresh` | off | Bypass the 5-minute cache (still writes it) |
| `--port N` | 8787 | Web UI port (binds 127.0.0.1 only) |
| `--model M` | gpt-5.5 | Model id |
| `--help` | — | Usage |

## Environment

| Variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | Required. Bearer token for the model API |
| `BIRDCLAW_OPENAI_BASE_URL` / `OPENAI_BASE_URL` | OpenAI-compatible base URL, in that priority order (default `https://api.openai.com/v1`) |
| `NANO_BIRDCLAW_MODEL` / `BIRDCLAW_AI_MODEL` | Model id (default `gpt-5.5`) |
| `BIRDCLAW_OPENAI_REASONING_EFFORT` | `reasoning.effort` (default `medium`) |
| `BIRDCLAW_OPENAI_SERVICE_TIER` | `service_tier` (default `priority`) |
| `NANO_BIRDCLAW_NAME` | Name used in the prompt (default `@<your handle>` from `bird whoami`) |
| `NANO_BIRDCLAW_BIRD` / `BIRDCLAW_BIRD_COMMAND` | bird executable (default `bird`) |

## How it works

- `bird home` + `bird mentions` (plus `bird read` for reply parents of mentions) are fetched in parallel, filtered to the window, deduped, and compacted.
- One prompt — birdclaw's digest prompt with the value-angle rules always on — is sent to the OpenAI Responses API with `stream: true`.
- The markdown streams straight to stdout, or as NDJSON to a tiny inline web page with citations linked back to the source tweets.

Results are cached for 5 minutes in `~/.nano-birdclaw/cache.json`.

Note: longer windows (`yesterday`, `week`) only see what the fetch reaches — raise `--limit` so the timeline extends far enough back.

## Credits

- [birdclaw](https://github.com/steipete/birdclaw) by Peter Steinberger — the timeline-digest feature this recreates (MIT; see LICENSE).
- [bird](https://github.com/steipete/bird) by steipete — the X/Twitter CLI doing all the fetching.
- Minimalism inspired by [nanocode](https://github.com/1rgs/nanocode) (1rgs) and [pi](https://github.com/earendil-works/pi) (earendil-works).

MIT licensed. Portions derived from birdclaw, Copyright (c) 2026 Peter Steinberger, also MIT.
