# Tiny LLMs for WatchTower — fast AI on any device

WatchTower's AI features do **not** need a heavy desktop app like LM
Studio, or even Ollama. Any OpenAI-compatible server works — and for
most of what WatchTower asks an LLM to do, a **tiny model (0.5–2B
parameters) running under llama.cpp** is enough. That keeps the whole
system fast on small devices: an old laptop, a mini-PC, even a
Raspberry Pi.

## Why tiny models are enough here

WatchTower uses the LLM for two distinct jobs:

| Job | What the model actually does | Model size needed |
|---|---|---|
| **Self-heal failure analysis** | Reads ~8 KB of failed build log, writes 2–5 sentences of root cause + fix. One completion, no tools, runs in the background. | **0.5–2B is fine** |
| **Agent chat** (`/api/agent/chat`) | Multi-turn conversation with tool calling (list projects, read logs, trigger deploys). | 3–8B recommended — tiny models fumble tool calls |

The self-heal loop is the one that runs unattended and keeps the system
maintaining itself — and it's deliberately designed to be cheap: the
pattern library (regexes) handles all the common failures with **zero**
LLM cost, and the model is only consulted for logs nothing matched. A
slow tiny model answering in 20 seconds in the background is perfectly
fine there.

> **"What about NanoGPT?"** NanoGPT-class models (Karpathy's nanoGPT,
> and similar from-scratch ~10–100M GPTs) are wonderful for learning
> how transformers work, but they're *base* models with no instruction
> tuning — they'll complete your log with more log, not analyze it.
> What you want is the same *spirit* at the smallest useful size:
> modern **distilled instruct models** like SmolLM2-360M or
> Qwen3-0.6B. They're nanoGPT-sized to run, but trained to follow
> instructions.

## The lightweight runtime: llama.cpp `llama-server`

[llama.cpp](https://github.com/ggml-org/llama.cpp) is a single small
binary, CPU-first, no GUI, no background services, best-in-class ARM
performance — and it serves the same OpenAI-compatible API WatchTower
already speaks.

```bash
# macOS
brew install llama.cpp

# Linux (incl. Raspberry Pi OS) — prebuilt binaries on the releases page,
# or build (takes a few minutes on a Pi):
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build && cmake --build build --config Release -j

# Start a server: downloads the quantized model from Hugging Face on
# first run (~700 MB for this one), then serves http://localhost:8080/v1
llama-server -hf Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M --port 8080
```

Then in WatchTower: **Settings → AI & Autonomy → llama.cpp preset →
Test connection → Save**. Done — the self-heal loop now has analysis on
every unknown failure, with ~1 GB of RAM in play and no GUI app running.

Single-file alternative: [llamafile](https://github.com/Mozilla-Ocho/llamafile)
bundles runtime + model into one executable (`./model.llamafile --server`),
useful when you can't install anything.

## Which model for which device

All sizes below are Q4_K_M GGUF quantizations (the best quality/size
balance). RAM numbers are what the model itself occupies — leave
headroom for WatchTower and your workloads.

| Device class | Model | RAM | What you get |
|---|---|---|---|
| **Raspberry Pi 4 (2–4 GB), very old machines** | `SmolLM2-360M-Instruct` or `Gemma-3-270M-it` | ~0.3 GB | Basic but real log analysis; instant responses |
| **Raspberry Pi 4 (4–8 GB)** | `Qwen3-0.6B` or `Llama-3.2-1B-Instruct` | ~0.5–0.8 GB | Good failure analysis; 8–12 tok/s on a Pi 4 |
| **Raspberry Pi 5 / N100 mini-PC** | `Qwen2.5-1.5B-Instruct`, `LFM2-1.2B`, or `SmolLM2-1.7B-Instruct` | ~0.9–1.2 GB | Solid analysis quality; 5–15 tok/s CPU-only. LFM2 is the most RAM-frugal of the three |
| **Any laptop from the last ~8 years** | `Qwen3-1.7B` or `EXAONE-4.0-1.2B` | ~1.2 GB | Strong reasoning for the size; comfortable speeds |
| **Modern laptop / desktop (16 GB+)** | `Qwen2.5-Coder-7B-Instruct` or `Qwen3-4B` | ~4–5 GB | Full agent-chat with reliable tool calling, plus best-quality self-heal analysis |

Each maps to a one-liner, e.g.:

```bash
llama-server -hf bartowski/SmolLM2-360M-Instruct-GGUF:Q4_K_M --port 8080   # tiniest
llama-server -hf Qwen/Qwen3-1.7B-GGUF:Q4_K_M --port 8080                   # sweet spot
llama-server -hf Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M --port 8080    # full agent
```

Practical tips for small devices:

- **Prefer K-quants** (`Q4_K_M`, `Q5_K_M`) over plain `Q4_0` — better
  quality at the same size.
- **Cap the context**: `llama-server ... -c 4096` keeps memory flat;
  WatchTower sends at most ~8 KB of log per analysis.
- **Run it as a service** so it survives reboots, e.g.
  `systemd-run --user --unit=llama llama-server -hf ... --port 8080`
  (or a proper systemd unit / launchd plist).
- The self-heal analysis is **best-effort by design**: if the LLM is
  slow, down, or unconfigured, the loop still files every failure into
  the intervention queue with its pattern-based diagnosis. AI analysis
  is an upgrade, never a dependency.

## When you do want a bigger model

If you use the **agent chat** heavily (conversational ops, "redeploy
the website and watch the logs"), tool calling is the bottleneck —
pick a 3–8B model (Qwen3-4B and Qwen2.5-Coder-7B are reliable), or
point WatchTower at any hosted OpenAI-compatible endpoint. You can
switch anytime in Settings; nothing else in WatchTower changes.
