# Glowline

A minimal Windows terminal for running **Claude Code**, **Codex** and **OpenCode** against **local models** (Ollama, LM Studio) – with a live stats bar at the bottom.

![logo](build/icon.png)

## What it shows

| | |
|---|---|
| **tok/s** | output speed, with a gauge and the session peak |
| **First token** | time until the first token arrives |
| **Prefill** | prompt processing speed (or `cached`) |
| **Prompt** | prompt tokens vs. the model's context window |
| **Output / Turn** | tokens of the last reply, duration of the current turn |
| **GPU power / VRAM** | live from `nvidia-smi` |
| **Saved** | what the same tokens would have cost on the Claude API |

## How it works

Glowline starts a small measuring proxy on `127.0.0.1:3460`. The coding tools talk to that proxy, which forwards every request to Ollama or LM Studio and measures the stream on the way back. Ollama serves the Anthropic (`/v1/messages`) and Responses (`/v1/responses`) formats natively, so no extra router is needed.

- **Claude Code** – the real `claude` CLI with `ANTHROPIC_BASE_URL` pointed at the proxy. Switch models in the bar (uses `/model`).
- **Codex** – `codex --oss` with `CODEX_OSS_BASE_URL`.
- **OpenCode** – `opencode --standalone` with an injected OpenAI-compatible provider.
- **PowerShell** – plain shell, no model.

Models can be loaded/unloaded from the model menu. Press **F11** for fullscreen.

## Requirements

- Windows 10/11
- [Ollama](https://ollama.com) and/or [LM Studio](https://lmstudio.ai) (server started)
- The tools you want to use: `claude`, `codex`, `opencode` on your PATH
- NVIDIA GPU for power/VRAM readings (optional)

## Build

```sh
npm install
npm start          # run from source
npm run dist       # build the installer -> dist/Glowline-Setup-<version>.exe
```

Older installers are moved to `dist/alt/` automatically.

## Config

`%APPDATA%\Glowline\config.json` – port, backends, default tool/model, prices for the "Saved" estimate, Claude Code environment.
