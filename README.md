# Glowline

A local AI workspace for Windows: run **Claude Code**, **Codex**, **OpenCode**, **Antigravity** and more coding agents against **local models** (Ollama, LM Studio) or your own subscriptions and API keys, chat with any model, write prompts, and create **images, videos, upscales and voices** on your own GPU – all in one window with a live stats bar at the bottom.

*A vibe-coded side project – built together with AI, tested on a real gaming PC.*

![logo](build/icon.png)

## Express setup

On the first start Glowline looks at your PC (graphics card, VRAM, RAM, free space). One click on **Install everything** sets up all you need – nothing to do by hand:

- **Install everything** – the coding tools **Claude Code**, **Codex** and **OpenCode** (Glowline gets Node.js itself if it is missing, no admin rights needed), Ollama, three language models that fit your PC and the Studio.
- **Choose what to install** – pick a speed (**Fast**, **Balanced** or **Best quality**; the one that fits your PC is marked) and Glowline installs everything in one go: Ollama if it is missing, a **coder**, a **reasoning** and a **fast helper** model, plus the Studio models for **images, video, voice and upscaling**. Untick anything you don't want – the download size and free space are shown before you start. Optionally take the **uncensored (abliterated)** versions of the language models.
- **Skip for now** – set up everything yourself, like before.

| Speed | Coder | Reasoning | Fast helper |
|---|---|---|---|
| Fast | Qwen 3.5 4B (64k context) | Qwen 3 4B | LFM 3 1.7B |
| Balanced | Qwen 3.5 9B (64k context) | Qwen 3 8B | LFM 3 1.7B |
| Best quality | Qwen 3.5 35B (128k context) | Qwen 3 30B | LFM 3 1.7B |

Glowline saves each model with a fixed context size (e.g. `qwen3.5:9b-64k`) and tells Claude Code and OpenCode about it, so long sessions don't silently overflow. Afterwards the coder is the default in the terminal and the fast helper in Chat. You can open the setup again any time under **Models → Express setup**; it keeps running in the background if you hide it.

## What it shows

| | |
|---|---|
| **tok/s** | output speed, with a gauge and the session peak |
| **First token** | time until the first token arrives |
| **Prefill** | prompt processing speed (or `cached`) |
| **Prompt** | prompt tokens vs. the model's context window |
| **Output / Turn** | tokens of the last reply, duration of the current turn |
| **GPU power / VRAM** | live from `nvidia-smi` |
| **Saved costs** | what the same work would have cost in the cloud – split into Coding, Reasoning, Chat, Images, Video and Voice. Click it to compare each one with a well-known model (Claude, GPT-5, Gemini, GPT Image, Sora, Veo, ElevenLabs …) or enter your own prices |

## How it works

Glowline starts a small measuring proxy on `127.0.0.1:3460`. The coding tools talk to that proxy, which forwards every request to Ollama or LM Studio and measures the stream on the way back. Ollama serves the Anthropic (`/v1/messages`) and Responses (`/v1/responses`) formats natively, so no extra router is needed.

- **Claude Code** – the real `claude` CLI with `ANTHROPIC_BASE_URL` pointed at the proxy. Switch models in the bar (uses `/model`).
- **Codex** – `codex --oss` with `CODEX_OSS_BASE_URL`.
- **OpenCode** – `opencode --standalone` with an injected OpenAI-compatible provider.
- **Antigravity** – Google's coding agent (`agy`), with your own Google account and its own models.
- **More agents** (fold-out group in the tool menu):
  - **Qwen Code** – runs on your Glowline model (local or an OpenAI-compatible API key) through the proxy.
  - **Gemini CLI**, **GitHub Copilot**, **Droid** (Factory) and **Cline** – started in your folder with their own account and models.
- **PowerShell** – plain shell, no model.

Tools that are not installed get installed automatically when you pick them: Glowline runs the official installer in the terminal (and downloads Node.js first if needed), then starts the tool by itself.

The **folder button** in the bar shows the working folder – click it to pick another one. **Customize list** (bottom of the tool menu) lets you reorder the entries and hide the ones you don't need – e.g. keep only Codex and Claude Code.

Models can be loaded/unloaded from the model menu. Press **F11** for fullscreen.

## Cowork

Open **Cowork** from the tool menu at the bottom right – no extra windows.

- **One chat for everything** – Cowork picks the right model for each message: a fast one for quick questions, your coder for code and error messages, a thinking model for maths, plans and tricky decisions, a vision model for questions about an attached image – and the Studio for images, videos, voice and upscales. Follow-up questions stay with the same model. Your chats are kept on this PC across restarts.
- **Your models, your choice** – **Models → Cowork** shows which model does what; set any role to another model (local or cloud) or leave it on Auto. Name a model in your message (*“ask gemma: …”*) to use it just once, or pick one bottom right to use it for every message until you click **Back to Auto**. **Use recommended** picks (and downloads, if needed) the model that fits your PC for each role.
- **Commands** – type `/` for a list: `/clear`, `/stop`, `/retry`, `/copy`, `/export`, `/think …`, `/code …`, `/fast …`, `/thinking on|off`, `/image …`, `/video …`, `/voice …`, `/upscale`, `/file …`, `/goal …` (keeps every answer focused on a goal), `/model …`, `/auto`, `/models` and `/help`.
- **Create right in the chat** – just ask: *“create an image of a tree”*, *“make a TikTok video of a dancing cat”*, *“read this aloud: …”*. Glowline writes a better prompt and the Studio makes it on your GPU – the result appears in the chat. Follow-ups work too (*“make the sky purple”*), images get **Upscale 4×** and **Animate** buttons, videos an **Upscale** button, and you can attach your own image with 📎 or drag & drop. Needs the Studio set up.
- **Files on your PC** – *“make an HTML file on my desktop with a little jump game”*: the Code model writes it and Glowline saves it (Desktop, Documents, Downloads … or a folder path you name, only inside your user folder). The file appears in the chat with **Open** and **Show in folder**; follow-ups like *“make the background blue”* change the same file. Existing files are never overwritten, and nothing gets run. Or use `/file …`.

## Accounts

Under **Models → Accounts**:

- **Claude subscription** (Pro/Max) – used inside Claude Code with your own login. Glowline only measures; it never reads your login.
- **ChatGPT account** (Plus/Pro) – used inside Codex with its own login.
- **API keys** for Anthropic, OpenAI, OpenRouter, Google Gemini, DeepSeek, Groq, Mistral and xAI (Grok) – their models then appear in the model lists for Chat, OpenCode, Qwen Code (OpenAI-compatible ones), Claude Code (Anthropic) and Codex (OpenAI). Keys are encrypted with your Windows login and only sent to their provider.
- **Higgsfield API key** – for cloud video in the Studio (see below).
- **Hugging Face token** (optional) – for gated model downloads.

"Saved costs" only counts local work – cloud chats and cloud videos are not counted.

## Studio

Images, video, upscaling and voice – running fully inside Glowline. The first time, **Set up Studio** installs a private engine (Python, PyTorch, [ComfyUI](https://github.com/Comfy-Org/ComfyUI) running invisibly in the background, about 5 GB) into `%LOCALAPPDATA%\Glowline\studio`. Then download only the models you want:

| | Model | License | Download |
|---|---|---|---|
| Images | FLUX.2 klein 4B – fast, 4 steps | Apache-2.0 | 16 GB |
| Images | Z-Image Turbo – photorealistic, good with text | Apache-2.0 | 21 GB |
| Video | Wan 2.2 5B – text or image to video, up to 5 s | Apache-2.0 | 18 GB |
| Upscale | Real-ESRGAN x4 – images 4× bigger, videos sharper (~2560×1408, sound kept) | BSD-3 | 70 MB |
| Voice | Chatterbox Multilingual – speech + voice cloning, 20+ languages | MIT | ~4 GB |

**Cloud video (optional):** with a [Higgsfield API key](https://open.higgsfield.ai/api-keys) the Video tab also offers **Wan 3.0 Prime** and **Seedance 2.0** – up to 15 s with sound, no GPU needed. These run on Higgsfield's servers and are paid from your Higgsfield balance per second of video (the button says *(paid)*); a start image is uploaded to Higgsfield. Cancel is free while the job is still queued, and failed or filtered jobs are not charged. Coding agents can't start paid cloud jobs.

- **✨ Improve prompt** uses your chat model to turn a short idea into a strong prompt.
- **Advanced mode** *(use at your own risk)* – the simple settings are tuned for your PC; switch this on to set width, height, length, frames per second, steps, guidance and shift yourself. Empty fields keep the default, and values are limited to safe ranges.
- Results appear in a gallery per tab: *Animate →* sends an image to Video, *Upscale →* sends an image or video to Upscale. Everything is saved under `studio\ausgabe`.
- Before a job, Glowline unloads language models from the GPU (8 GB is not enough for both) and frees the GPU again when you chat with a local model.
- Interrupted model downloads resume where they stopped.
- Only clone voices you are allowed to use.

### Studio tools for coding agents

When the Studio is set up, Claude Code, Codex, OpenCode and Qwen Code started from Glowline get the tools `generate_image`, `generate_video`, `upscale_image`, `text_to_speech` and `studio_status` (MCP on `127.0.0.1:3461`, protected with a random key per start). Ask your agent for "a 16:9 hero image for the landing page" and it renders it locally.

### Favorites and downloads

- The model button in the bar only shows your **favorites** (split into Ollama and LM Studio when you have both). Click **All models & downloads** to open the big model window.
- **My models** lists everything from Ollama and LM Studio with readable names (long Hugging Face names are shortened, the uploader is shown in grey, the full name is in the tooltip). Click ☆ to add a model to your favorites, Load/Unload it, or click it to switch.
- **Download** gets GGUF models from Hugging Face: 1) choose where it goes (Ollama or LM Studio), 2) search, 3) pick a model and a size. Sizes that fit your VRAM are marked. Ollama downloads it itself (`hf.co/<repo>:<quant>`); for LM Studio, Glowline saves the file into the LM Studio models folder. Downloads show progress and can be cancelled.
- **Downloads** shows everything that is downloading right now in one place – models, Express setup steps, Studio models and installers – with progress and a Cancel button. While something downloads, a small chip in the bar shows the progress; click it to open the tab.

### Interface size

Glowline scales itself to your screen (bigger on large monitors). **Ctrl +** / **Ctrl −** make it bigger or smaller, **Ctrl 0** goes back to automatic.

## Requirements

If LM Studio's server runs on another port (it moves away from 1234 when that port is taken), Glowline finds it by itself. If the server is not running, the model window has a **Start LM Studio server** button.

Glowline tells you what is missing: if a tool is not installed it installs it for you, and if no model server is installed or running it says so and links to Ollama / LM Studio.

- Windows 10/11
- [Ollama](https://ollama.com) and/or [LM Studio](https://lmstudio.ai) (server started) – Express setup installs Ollama for you; if one is missing, **Models** has a button that downloads its installer to your Downloads folder
- The tools you want to use (`claude`, `codex`, `opencode`, `agy`, …) – Glowline installs them for you
- NVIDIA GPU for power/VRAM readings (optional) and for the Studio (8 GB VRAM or more recommended, plus 25–60 GB disk space for the models you pick)

## Build

```sh
npm install
npm start          # run from source
npm run dist       # build the installer -> dist/Glowline-Setup-<version>.exe
```

Older installers are moved to `dist/alt/` automatically.

## Config

`%APPDATA%\Glowline\config.json` – port, backends, default tool/model, chat model, the comparison model and token counter for "Saved costs", Claude Code environment, `studioOrdner` (another place for the Studio).
