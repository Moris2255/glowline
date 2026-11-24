# Glowline

A local AI workspace for Windows: run **Claude Code**, **Codex**, **OpenCode**, **Antigravity** and more coding agents against **local models** (Ollama, LM Studio) or your own subscriptions and API keys, chat with any model, write prompts, and create **images, videos, upscales and voices** on your own GPU – all in one window with a live stats bar at the bottom. Or skip the window: type **`gl`** in any terminal and Cowork answers right there, greeted by **Glim**, Glowline's firefly mascot.

*A vibe-coded side project – built together with AI, tested on a real gaming PC.*

![logo](build/icon.png)

## Express setup

On the first start Glowline looks at your PC (graphics card, VRAM, RAM, free space). One click on **Install everything** sets up all you need – nothing to do by hand:

- **Install everything** – the coding tools **Claude Code**, **Codex** and **OpenCode** (Glowline gets Node.js itself if it is missing, no admin rights needed), Ollama, three language models that fit your PC and the Studio.
- **Choose what to install** – pick a speed (**Fast**, **Balanced** or **Best quality**; the one that fits your PC is marked) and Glowline installs everything in one go: Ollama if it is missing, a **coder**, a **reasoning** and a **fast helper** model, **voice input** (Parakeet), plus the Studio models for **images, video, voice and upscaling**. Untick anything you don't want – the download size and free space are shown before you start. Optionally take the **uncensored (abliterated)** versions of the language models.
- **Skip for now** – set up everything yourself, like before.

| Speed | Coder | Reasoning | Fast helper |
|---|---|---|---|
| Fast | Qwen 3.5 4B (64k context) | Qwen 3 4B | LFM 3 1.7B |
| Balanced | Qwen 3.5 9B (64k context) | Qwen 3 8B | LFM 3 1.7B |
| Best quality | Qwen 3.5 35B (128k context) | Qwen 3 30B | LFM 3 1.7B |

Glowline saves each model with a fixed context size (e.g. `qwen3.5:9b-64k`) and tells Claude Code and OpenCode about it, so long sessions don't silently overflow. Afterwards the coder is the default in the terminal and the fast helper in Chat. You can open the setup again any time under **Models → Express setup**; it keeps running in the background if you hide it.

## Updates

Glowline updates itself from the [releases on GitHub](https://github.com/Moris2255/glowline/releases): it checks every few hours, downloads a new version in the background, checks it (SHA-256) and installs it when you quit – a pop-up tells you about it, and **Restart now** installs right away. Change it under **Start & list → Updates**: *Automatic*, *Just tell me* or *Off*. Works from 5.0 on (older versions: install 5.0 once by hand). Glowline Link updates itself the same way.

## Stats

**Models → Stats** shows a heatmap of the last 12 months (like GitHub), your current and longest streak, active days, tokens and requests, what you saved, your most used models and what the Studio made. Only local use is counted, and everything stays on your PC.

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

The **folder button** in the bar shows the working folder – click it to pick another one. **Start & list** (bottom of the tool menu) lets you pick what opens when Glowline starts (last used, a tool, Cowork or Studio), how the window starts (full screen, maximized, window or minimized – F11 switches full screen), what the close button does (quit, minimize, or keep running in the tray – right-click the tray icon → Quit), and reorder or hide the entries – e.g. keep only Codex and Claude Code.

Models can be loaded/unloaded from the model menu. Press **F11** for fullscreen.

## Cowork

Open **Cowork** from the tool menu at the bottom right – no extra windows.

- **One chat for everything** – Cowork picks the right model for each message: a fast one for quick questions, your coder for code and error messages, a thinking model for maths, plans and tricky decisions, a vision model for questions about an attached image – and the Studio for images, videos, voice and upscales. Follow-up questions stay with the same model. Your chats are kept on this PC across restarts.
- **Your models, your choice** – **Models → Cowork** shows which model does what; set any role to another model (local or cloud) or leave it on Auto. Name a model in your message (*“ask gemma: …”*) to use it just once, or pick one bottom right to use it for every message until you click **Back to Auto**. **Use recommended** picks (and downloads, if needed) the model that fits your PC for each role. Under **Studio** on the same page you set the default model for images, video, upscale and voice – Cowork uses it, and the Studio picks it first. Cloud video models (Higgsfield) are only used when you choose them there, since they cost money.
- **Voice input** – click the microphone next to **Send** (or press **Ctrl+Shift+Space**) and talk; click again to stop and your words appear in the box. The speech recognition is **Parakeet** (670 MB – NVIDIA's Parakeet TDT v3 via whisper.cpp): very fast and accurate, finds the language by itself, 25 European languages incl. German and English. **Install everything** in the setup downloads it right away; otherwise the microphone offers it the first time. It runs on your PC's processor, also in Glowline Link on a laptop – nothing you say leaves your computer. Tool menu → Start & list → Voice input shows it or removes it again.
- **Commands** – type `/` for a list: `/clear`, `/stop`, `/retry`, `/copy`, `/export`, `/think …`, `/code …`, `/fast …`, `/thinking on|off`, `/image …`, `/video …`, `/voice …`, `/upscale`, `/file …`, `/goal …` (keeps every answer focused on a goal), `/model …`, `/auto`, `/models` and `/help`.
- **Create right in the chat** – just ask: *“create an image of a tree”*, *“make a TikTok video of a dancing cat”*, *“read this aloud: …”*. Glowline writes a better prompt and the Studio makes it on your GPU – the result appears in the chat. Follow-ups work too (*“make the sky purple”*), images get **Upscale 4×** and **Animate** buttons, videos an **Upscale** button, and you can attach your own image with 📎 or drag & drop. Needs the Studio set up.
- **Files on your PC** – *“make an HTML file on my desktop with a little jump game”*: the Code model writes it and Glowline saves it (Desktop, Documents, Downloads … or a folder path you name, only inside your user folder). The file appears in the chat with **Open** and **Show in folder**; follow-ups like *“make the background blue”* change the same file. Existing files are never overwritten, and nothing gets run. Or use `/file …`.

## Obsidian – your second brain

Have an [Obsidian](https://obsidian.md) vault? Glowline finds it by itself (it reads Obsidian's own vault list) – nothing to set up.

- **Cowork knows your notes** – before each message, Glowline searches your vault (fast, offline, German and English) and quietly passes the notes that really fit to the model. They show up under the answer as **From your notes** chips – click one to open it in Obsidian. Questions your notes don't cover (*“what's the capital of France?”*) get no notes.
- **Save to Obsidian** – every answer has a **Save to Obsidian** button: it becomes a note in the folder `Glowline` of your vault, with date, source and model in the front matter.
- **Agents can read and write it – without asking** – Claude Code, Codex, OpenCode and Qwen Code started from Glowline get the `glowline-obsidian` MCP server with `search_notes`, `read_note`, `list_notes`, `write_note`, `edit_note`, `append_to_note`, `move_note` (updates `[[links]]` in all other notes), `delete_note` and `note_links`. They're allowed without a permission prompt (Claude Code `--allowedTools`, Codex `default_tools_approval_mode = "approve"`, Qwen Code `trust`), so an agent can tidy or extend your vault overnight.
- **Nothing gets lost** – before a note is changed, moved or deleted, Glowline copies the old version to `%APPDATA%\Glowline\gehirn-sicherung\<vault>\<date>\` (kept 30 days). Deleted notes go to the vault's `.trash`, like in Obsidian. Agents can't touch anything outside the vault or in hidden folders (`.obsidian`, `.trash`, `.git`).
- **Glowline Code** (`gl`) uses your notes the same way and lists them under the answer.
- **On/off with one click** – the **◆ Obsidian** button in the bar at the bottom turns it off (*Obsidian off*) and on again, back to the vault you had. It only shows up when Obsidian knows a vault.
- Tool menu → **Customize → Obsidian**: *Auto* (the vault you opened last), a specific vault, or *Off*.

## Working memory – per task

Long agent tasks fill up the context. Claude Code, Codex, OpenCode and Qwen Code started from Glowline get a small **working memory** for the current task (MCP server `glowline-memory`: `read_memory`, `write_memory`, `append_memory`, `edit_memory`, allowed without asking).

- The agent keeps it up to date by itself: goal, what's done, decisions, key files, next steps. After `/clear`, after the context gets compacted, or when you switch the model, it reads the memory first and carries on – without dragging the whole old conversation along.
- It belongs to **this task only**: switching the model or tool in the same folder keeps it; a new folder starts a new task with an empty memory; quitting Glowline erases it. Nothing goes into your Obsidian vault or anywhere else.
- The **✦ Memory** button in the bar at the bottom (terminal view) shows up as soon as the agent has saved something – click it to see what it remembers, **Forget** erases it.
- **Archive – a virtual context of 256k, 512k or 1M tokens.** Besides the short note, the agent gets a searchable archive for the task (`archive_save`, `archive_search`, `archive_read`). Whatever it reads or works out in detail – docs, long files, logs, analyses – goes there; later only the matching passages come back into the real context. The context window itself stays the same size, but the agent can work with far more than fits into it. When the archive is full, nothing more is added. The Memory window shows how full it is.
- Claude Code also gets a short start instruction to read the memory first – it loads MCP tools only on demand and would otherwise skip it now and then.
- Tool menu → **Customize → Memory**: *Note + 256k / 512k / 1M archive*, *Note only* or *Off*.

## Glowline Code – the terminal (`gl`)

**Glowline Code** is Cowork in your terminal – the app window stays plain **Glowline**. Open any terminal (PowerShell, cmd, Windows Terminal, Git Bash) and type **`gl`** or **`glowline`**:

```
╭───────────────────────────────────────────────────────────────────────────╮
│    ▀▄      ▄▀      Glowline Code 6.0.21                                   │
│ ▄▄ ███▀███▀██ ▄▄   Cowork · RTX 4060 Ti · 2.6 / 8 GB VRAM                 │
│ ▀██ ▀██████▀ ██▀   ~\Projekte\my-game                                     │
│     ▄██████▄                                                              │
│ ▄▄▄▄▄██████▄▄▄▄▄   /help for all commands · drag in an image · Esc stops  │
╰───────────────────────────────────────────────────────────────────────────╯
```

Say hi to **Glim**, Glowline's mascot – a little firefly. When it flies, it leaves a glowing line behind: a *glow line*. In the terminal its belly glows softly and it blinks now and then. The input box always stays at the bottom of the window, answers stream in above it.


- Same Cowork as in the window: Auto picks the model, images / videos / voice / upscales are made by the Studio, follow-ups work.
- **Images and videos** show up as a small colour preview right in the terminal, plus a clickable path – **Ctrl+O** opens the last result.
- **Upscale**: drag an image or video into the terminal (or type its path) and say *upscale*, or use `/upscale <path>`. Drag an image in and ask *“what is in it?”* to use the vision model.
- **Files** you ask for (*“make an HTML jump game”*, `/file …`) are saved in the folder you started `gl` in.
- Commands: type `/` – the same as in the window plus `/open` and `/exit`, and the everyday ones: `/model` (pick a model), `/effort low|medium|high` (fast model, Auto or always the reasoning model), `/usage` (tokens and saved costs for this chat, today and all time, plus GPU and VRAM) and `/stats` (a heatmap of your last weeks, streak, favourite models and Studio results). **Esc** stops an answer, **↑/↓** brings back earlier messages, **Ctrl+J** or `\` + Enter for a new line, **Ctrl+C** twice to leave.
- **Hold Space to talk** – keep the space bar pressed, talk, let go: your words land in the input (send with Enter). Glowline records and recognises the speech on this PC with the same voice input as the window, even when the window is hidden in the tray. `/mic` sets it up once.
- `gl "question"` starts with a message, `gl -p "question"` answers once and exits (for scripts).
- The Glowline app does the work: if it isn't running, `gl` starts it in the tray. Type `/autostart on` once and Glowline starts with Windows (hidden in the tray), so `gl` is ready right after you turn on your PC. Set up automatically after the update – open a **new** terminal window once. In PowerShell, `gl` normally means *Get-Location*; Glowline turns that alias off in your PowerShell profile so `gl` starts Glowline (`Get-Location` / `pwd` still work).

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
| Images | FLUX.2 klein 4B – fast, 4 steps, takes a **reference image** (a character, person or object as a template) | Apache-2.0 | 16 GB |
| Images | Z-Image Turbo – photorealistic, good with text | Apache-2.0 | 21 GB |
| Video | Wan 2.2 5B – text or image to video, up to 5 s | Apache-2.0 | 18 GB |
| Upscale | Real-ESRGAN x4 – images 4× bigger, videos sharper (~2560×1408, sound kept) | BSD-3 | 70 MB |
| Voice | Chatterbox Multilingual – speech + voice cloning, 20+ languages | MIT | ~4 GB |

**Cloud video (optional):** with a [Higgsfield API key](https://open.higgsfield.ai/api-keys) the Video tab also offers **Wan 3.0 Prime** and **Seedance 2.0** – up to 15 s with sound, no GPU needed. These run on Higgsfield's servers and are paid from your Higgsfield balance per second of video (the button says *(paid)*); a start image is uploaded to Higgsfield. Cancel is free while the job is still queued, and failed or filtered jobs are not charged. Coding agents can't start paid cloud jobs.

- **Improve prompt** uses your chat model to turn a short idea into a strong prompt.
- **Advanced mode** *(use at your own risk)* – the simple settings are tuned for your PC; switch this on to set width, height, length, frames per second, steps, guidance and shift yourself. Empty fields keep the default, and values are limited to safe ranges.
- Results appear in a gallery per tab: *Animate →* sends an image to Video, *Upscale →* sends an image or video to Upscale. Everything is saved under `studio\ausgabe`.
- Before a job, Glowline unloads language models from the GPU (8 GB is not enough for both) and frees the GPU again when you chat with a local model.
- Interrupted model downloads resume where they stopped.
- Only clone voices you are allowed to use.
- **Night queue** – *Add to night queue* collects jobs instead of starting them. Glowline makes them one after another at night (default 23:00 until 05:00 – at the end time it stops, and an unfinished job continues the next night). **Start now** doesn't wait for the night. Leave Glowline open or in the tray. Cloud models can't go in the queue (they cost money).

### Film maker

**Studio → Film** turns a topic into a short film (30, 60 or 90 s, 16:9 or 9:16). Or just ask Cowork: *“create a 60 second film about a hamster who flies to the moon”*.

1. Your chat model writes the script: a title, the main character, a look, and one scene per 5 seconds – picture, motion and narrator text.
2. You can change everything: texts, order, add or remove scenes, a narrator voice sample, your own music, subtitles – and a **character picture**: pick an image of your main character and it is used as a reference in every scene, so the character really looks the same throughout (needs FLUX.2 klein).
3. The Studio makes every scene on your GPU – a picture (the same character description in every scene), then a 5 s video from that picture, then the narrator.
4. Glowline cuts everything into one MP4 with crossfades, the narrator, ducked music, subtitles burned in and an `.srt` file next to it (`studio\ausgabe\Filme`).

**Send to phone** shows a QR code: scan it with your phone (same Wi-Fi) to watch or save the film. Works for Studio images and videos too. The link only works in your home network, has a random key and stops after one hour (or when you click **Stop sharing**).

Needs an image model, Wan 2.2 5B and (for the narrator) the voice. A 60 s film can take an hour or more – **Add to night queue** is ideal. If it stops (Cancel, end of the night, crash), it continues where it stopped; changing a text only remakes that part. Use only music you are allowed to use.

### Studio tools for coding agents

When the Studio is set up, Claude Code, Codex, OpenCode and Qwen Code started from Glowline get the tools `generate_image`, `generate_video`, `upscale_image`, `text_to_speech` and `studio_status` (MCP on `127.0.0.1:3461`, protected with a random key per start). Ask your agent for "a 16:9 hero image for the landing page" and it renders it locally.

### Favorites and downloads

- The model button in the bar only shows your **favorites** (split into Ollama and LM Studio when you have both). Click **All models & downloads** to open the big model window.
- **My models** lists everything from Ollama and LM Studio with readable names (long Hugging Face names are shortened, the uploader is shown in grey, the full name is in the tooltip). Click ☆ to add a model to your favorites, Load/Unload it, or click it to switch.
- **Download** gets GGUF models from Hugging Face: 1) choose where it goes (Ollama or LM Studio), 2) search, 3) pick a model and a size. Sizes that fit your VRAM are marked. Ollama downloads it itself (`hf.co/<repo>:<quant>`); for LM Studio, Glowline saves the file into the LM Studio models folder. Downloads show progress and can be cancelled.
- **Downloads** shows everything that is downloading right now in one place – models, Express setup steps, Studio models and installers – with progress and a Cancel button. While something downloads, a small chip in the bar shows the progress; click it to open the tab.

### Interface size

Glowline scales itself to your screen (bigger on large monitors). **Ctrl +** / **Ctrl −** make it bigger or smaller, **Ctrl 0** goes back to automatic.

## ARTEX – autonomous pentest

If you use [ARTEX](https://github.com/BaaRai/ARTEX) (a local, autonomous LLM pentest tool), it opens as its own view inside Glowline. Tool menu → **ARTEX**.

- Glowline looks for ARTEX in the usual places (`~/Projekte/ARTEX`, `~/ARTEX`, …). If it isn't there, **Select ARTEX folder…** lets you point at it once; a valid folder has a `pg` and an `app` folder inside.
- **Start** launches PostgreSQL and ARTEX for you and shows ARTEX's own web interface (`localhost:8787`) right in the window once it's up. **Stop** shuts the ARTEX process down again, and **Browser ↗** opens the same interface in your normal browser.
- Glowline only stops the parts it started itself, and it closes ARTEX when you quit Glowline.
- **Only point ARTEX at systems you own or are explicitly allowed to test.**

## Glowline Link – use your PC from your laptop

Got a PC with a strong graphics card and a laptop without one? Install **Glowline** on the PC and **Glowline Link** (its own small installer, `Glowline-Link-Setup-<version>.exe`) on the laptop.

1. On the PC: **Models → Link → Share this PC**. Glowline shows a 6-digit code.
2. On the laptop: open Glowline Link. It finds the PC in your network by itself – pick it, type the code, **Connect**.

That's it: Claude Code, Codex, OpenCode and Cowork on the laptop now run with the models on the PC. Downloads go to the PC too. Only devices in your home network can connect, and only after entering the code; **New code** on the PC disconnects all laptops. If Windows asks whether Glowline may use the network, allow it for private networks.

- **Studio over Link** – the Studio tab on the laptop uses the PC's graphics card: images, videos, upscales and voice are made on the PC and saved on the laptop. Set up the Studio and download its models on the PC.
- **Wake up the PC** – if the PC is asleep or off, **Wake up PC** in Link sends a Wake-on-LAN signal. On the PC turn on **Start with Windows** (in Models → Link) so Glowline is ready after waking, and allow waking once: network adapter → Properties → Power management → *Allow this device to wake the computer* (for a PC that is shut down, Wake-on-LAN must also be on in the BIOS). Works best from sleep mode.

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
npm run dist:link  # build Glowline Link -> dist-link/Glowline-Link-Setup-<version>.exe
```

Older installers are moved to `dist/alt/` automatically.

## Config

`%APPDATA%\Glowline\config.json` – port, backends, default tool/model, chat model, the comparison model and token counter for "Saved costs", Claude Code environment, `studioOrdner` (another place for the Studio), `obsidian` (`auto`, `aus` or a vault folder).
