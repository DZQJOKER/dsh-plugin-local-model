![dsh-cost-meter preview image](https://raw.github.com/DZQJOKER/dsh-plugin-local-model/main/images/仓库截图.png)


# dsh-plugin-local-model

Local model plugin for **DeepSeek Harness (dsh)**: manage local GGUF models in the settings,
**the first conversation auto-starts llama.cpp and loads the model, and after 5 consecutive minutes without interaction it auto-unloads and frees VRAM**;
at the top of the settings page there is also a **parameter presets** block that saves the whole set of parameters as named entries with one-click switching.

Models and the llama tools are downloaded by the user themselves and placed in the directories prescribed by the plugin — the plugin does not fetch models over the network, does not touch workspace files,
and listens on no ports other than the local loopback address.

## Changelog

- **0.7.0** — ① **Fixed "after installing a vision projection file it keeps reporting 400 `Failed to load image or audio file`"**. The root cause is neither in the plugin nor in the model: llama.cpp's built-in image decoder only recognizes the old formats png / jpeg / gif / bmp and **does not recognize WebP**; on encountering WebP it tries to launch external `ffprobe` for probing and `ffmpeg` for transcoding, and these two are looked up from **PATH** (this build dropped `--ffmpeg-path`, leaving PATH as the only route). When ffmpeg is not installed on the machine, the server logs `probe: failed to launch ffprobe` / `failed to decode webp buffer` and the client receives a 400 — while **JPEG in the same batch is recognized normally** (dsh produces both formats when transcoding; in practice both are present under `.dsh/attachments/v1/request-images/`), so the symptom is "works sometimes, fails sometimes", easily mistaken for a broken plugin or model. Now: **the plugin automatically finds ffmpeg and prepends its directory to the PATH of the llama-server subprocess** (no system PATH change needed, no dsh restart needed for this); if it cannot be found while vision is enabled, a warning is emitted explaining "which format will fail, why only that one, and how to fix it". Install: `winget install Gyan.FFmpeg`.
  ② **MTP and vision projection changed from "mutually exclusive" to "can coexist"** (new setting `mtpWithVision`, **enabled by default**). The original rule came from upstream llama.cpp (sending both at once fails to load), but **the kvmem branch's `llama-kvmem-server` is verified to support it**: when given both `--mmproj` and `--spec-type draft-mtp`, `clip_model_loader: has vision encoder` and `creating MTP draft context` appear simultaneously, the service starts normally, and image conversations are recognized (verified on this machine 2026-09-21). Users switching back to official llama.cpp should turn this toggle off to restore the old exclusive behavior (MTP active, `--mmproj` ignored with an explanation).
  ③ **New "launch parameters for this run" panel at the top of the settings page**: lists item by item, one line per item, **the full command line actually sent to llama-server this time** (not what is filled in on the settings page — between the two there are gating skips, build defaults and auto-convergence), plus a parameter summary (including the derived "GPU KV total = working set + decode reserve"), a "Copy command line" button, and **skipped options** as well as **options not covered by the recognition table** (the latter used to only sit in the log). Refresh follows the runtime status polling; after changing model/parameters it updates automatically.

- **0.6.0** — ① **Filled in all missing launch parameters of the kvmem branch (`kvmem/kvmem-llama.cpp`)**, 31 items total: the KVMem family, 18 items (`--kvmem` / `--kvmem-budget` / **`--kvmem-gen-reserve`** / `--kvmem-block-tokens` / `--kvmem-sink-tokens` / `--kvmem-recent-tokens` / `--kvmem-method` / `--kvmem-query-last` / `--kvmem-query-max-tokens` / `--kvmem-query-replay` / `--kvmem-query-policy` / `--kvmem-mtp-state` / `--kvmem-gpu-ratio` / `--kvmem-cpu-gb` / `--kvmem-nvme-gb` / `--kvmem-nvme-dir` / `--kvmem-harvest-v` / `--kvmem-raw-k-nvme`), plus `-n/--n-predict`, `-lm/--load-mode`, `--kv-dtype`, `--spec-kv-dtype`, `--spec-draft-n-max`, `--spec-draft-p-min`, `--frequency-penalty`, `--mmproj-offload`, `--chat-template-file`, `--chat-template-kwargs`, `--reasoning-effort`, `--reasoning-budget-message`. **All defaults are "do not send"** (numeric items use `-1` as a sentinel, strings use the empty string), so deployments with official llama.cpp have **not one word of behavior changed**; kvmem-specific items go through **strict gating** — if not detected, the whole group is skipped and explained in the log.
  ② **New "output limit overflow protection"** (`guardContextOverflow`, enabled by default). Upstream llama.cpp on `prompt + max_tokens > n_ctx` only emits a warning and then converges on its own, while that standalone kvmem server is a **hard reject**: `HTTP 400 {"error":"prompt + max_tokens exceeds n_ctx"}` — the error contains neither prompt length nor n_ctx, so users can only guess. Now the proxy first preventively clamps "certainly failing" limits (`max_tokens >= n_ctx`, no non-empty prompt fits) down to `n_ctx − 1024`, then for requests explicitly rejected by the server **retries with halving step by step** (only 400 is buffered; any other status code continues streaming through as before, zero extra overhead for normal conversations); when it truly cannot fit, the original message is replaced with an explanation containing the real `n_ctx` and the most likely cause.
  ③ New **load-time configuration consistency reminder**: when `maxTokens` is not greater than `ctxSize` (the root cause of this production incident), exceeds half, or `--kvmem-gen-reserve` is smaller than the single output limit, the load log directly names the consequence and a suggested value.
  ④ Fixed one **silent defect**: the summary hint for skipped options was previously settled right after the sampling parameters, so every item added later (`--kvmem-*` / `-n` / `-lm` …) would not appear in the log after being skipped.
  ⑤ New settings groups "**KVMem block cache**" and "**Multi-Token Prediction (MTP) details**".

- **0.5.3** — Fixed "**switch to a different llama branch and the plugin can no longer start**". The user swapped the executable for that `kvmem-v0.16.0-rc2` `llama-kvmem-server.exe` (a standalone OpenAI-compatible server whose option table is only a true subset of llama.cpp's), and loading failed outright:
  `unknown flag: --alias` + usage + exit 1. The root cause was that part of the group of options the plugin **sends unconditionally** simply does not exist in this branch — the detection mechanism previously only gated the 4 kinds of "only present in newer versions" options
  (`--kv-unified` / `--kv-stream-stage-mib` / `--image-*-tokens` / `--reasoning-budget`),
  and all the rest (`--alias`, `-t`, `--threads-batch`, `-ub`, `--repeat-last-n`, `--no-mmap`,
  `--mlock`, `--api-key`, that group of sampling parameters) were sent as usual. And this kind of branch, for unknown options, **does not ignore them but exits 1 directly**,
  and reports only one at a time — so "just fix `--alias`" is not enough; the next will be `-ub`.
  **Fix**: extend the existing contract of "only send options the build admits" to **all** options, split into two tiers of semantics:
  ① Only present in new builds / specific branches → strict gating (do not send even if detection fails, same as before);
  ② The rest → lenient gating (**if detection fails, send the full set as before**, behavior completely identical to history; only when the build explicitly does not expose an item is that one item skipped).
  Everything skipped is written to the log (`Skipped (does not affect loading): --alias, -ub, …`), never silent.
  **Also fixed a same-origin failure**: the default value of `--seed` is `-1` (= random), and this branch validates it as uint32;
  receiving `-1` directly yields `invalid --seed: seed out of range [0, 4294967295]` and exits —
  now **negative numbers never send this parameter** (equivalent to "random": llama.cpp's default was `-1` to begin with),
  and one rule simultaneously satisfies the standard build (semantics unchanged) and builds with a narrowed value range.
  Real-machine acceptance (with the user's real configuration, model swapped for a sentinel path):
  ① kvmem build — 63 options recognized, no more unknown items in the command line, all measured parameters pass;
  ② `llama.mtp-accelerated-optimized` (405 options) — the command line is **character-for-character identical** to before the fix (only the semantically equivalent `--seed -1` missing),
  all parameters pass. In other words, this version has zero behavior change for standard / near-upstream builds.
  New regression cases: in `scripts/selftest.mjs`, a group of assertions was built from the verbatim kvmem `--help` (including "every option sent must be publicly exposed"),
  and `scripts/verify-llama.mjs` had two kinds of criteria added, `unknown flag` / `invalid --xxx:` (previously this sentence would be missed as "no parameter error").

- **0.5.2** — Fixed **transparent overlap** on the settings page. **The diagnosis in 0.5.1 was wrong** — those three geometric problems did exist and were indeed fixed,
  but they were not the cause of the user seeing "text overlapping text". The real root cause is that **the plugin referenced CSS variables that do not exist in DSH at all**:
  the plugin as a whole uses the group `--color-background-primary` / `--color-border-tertiary` / `--color-text-primary`
  (generic tokens in Claude / Cursor style), while host DSH only provides one set of `--dsw-*`
  (a full scan of all 21810 files in `app.asar` shows the **definition count for the above `--color-*` is 0**).
  When the variable does not exist, `var(--x, fallback)` **silently** falls back to the fallback, so:
  ① The fallback written for `card` and the bottom save bar was `'transparent'` → **they really are transparent**,
  and the text of the lower "runtime status" card (current model / process / entry / total models / reasoning tier / multi-token prediction / vision projection)
  shows straight through; ② the pinned preset bar's fallback is `'#fff'` → in light theme **white background equals panel white background**,
  to the eye it still looks "transparent"; ③ input box / dropdown `--color-background-secondary` also falls through to `transparent`,
  becoming an area on the card where "the bottom cannot be seen"; ④ in dark theme `--color-text-primary` → `#111`,
  and the main button becomes black-on-black. **Fix**: migrate the color system wholesale to `--dsw-*`
  (panel background `--dsw-alias-bg-layer-2`, same color as host `.MI-_Aa_panel`; borders `--dsw-alias-border-l1..l4`;
  text `--dsw-alias-label-*`; semantic colors `--dsw-alias-state-*`), and add opaque backgrounds to all containers that "cover lower content". **Also fixed two related problems**: ⑤ the horizontal negative margins of the pinned bar and save bar —
  `.options` has 24px padding on left and right, sticky elements by default only cover the content area width, and in those 24px gaps on both sides, content that scrolls past shows directly
  (the old save bar with `padding: '10px 0'` even had a 10px gap top and bottom, and "current model" was showing through from this gap);
  ⑥ status badge background color is now mixed from the foreground color using `color-mix`, so in dark theme "light-on-light" no longer appears.
  `client/src/layoutCheck.js` adds two kinds of assertions: **variable whitelist** and **transparency**,
  plus one **reverse verification** (a bad sample with the bug must report an error) — because the biggest risk of this kind of probe is
  a false negative where "the rule never fires", which is more dangerous than having no rule.
- **0.5.1** — Fixed the geometric cause of **element overlap** on the settings page (three places, all layout problems that "only manifest at certain screen widths").
  The root cause is that the Host settings panel has only **564px** usable width in measurement (panel 800 − left nav 188 − padding 48),
  while the client wrote the content area as `maxWidth: 720`, **156px wider than the usable width**:
  ① Field rows are a three-column `grid`, and the second column is written as bare `1fr` — grid's automatic minimum size defaults to `auto`,
  which **refuses to be compressed below the input box's min-content**, so when usable width is insufficient, the second column is pushed to the next line,
  the "Default" button returns to the right side, and two rows of content visually overlap (always occurs on panels `≤800px`, i.e. any laptop);
  ② The containing block for the pinned preset bar's `position: sticky` is the **padding box** of the scroll container `.options`,
  and `top:0` lands exactly on the panel's 32px rounded corner, so scrolling cuts off the top edge of the card and covers the panel title and close button;
  ③ `.options`'s top padding is 0 and sticky does not claim it, leaving a **scrollable transparent gap** above the card,
  through which the lower card shows. Now: content area changed to `maxWidth: 100%`; all three columns are `minmax(0, …)`
  and all controls have `minWidth: 0` added (field row minimum requirement dropped to about 204px, even a 480px-wide window has room);
  the pinned bar seals itself with **opaque background + top padding + `isolation: isolate`**, no longer competing with the panel for layering.
  Also fixed: overly long preset names push the chip's `✎ / ×` out of the card (now capped at 240px with ellipsis),
  and the metadata grid's `minmax(220px, 1fr)` hard floor overflows the whole block on narrow panels (now `minmax(0, 220px)`).
  **Only styles changed; no component structure, routing, or interaction touched at all**; new `client/src/layoutCheck.js` turns these
  geometric constraints into assertions, and `client-check` verifies one by one at common resolutions that "settings items fit on one line".
  ⚠️ The transparent background problem is **not** in this version's fix scope; see 0.5.2.
- **0.5.0** — New **parameter presets**: save the whole set of load/inference parameters (including the selected model and vision projection) as named entries;
  multiple groups can be saved, renamed, overwritten, deleted; one click switches. The preset bar is fixed at the **top of the settings page**,
  and you can switch directly even when scrolled to the parameter area. Presets only collect "parameters", not "environment" — the 9 items port, listen address, model/runtime directories,
  keys, log level do not go into presets; switching presets does not touch them (otherwise switching a parameter preset would also change the port).
  Storage is at `<DSH_HOME>/local-model/state/presets.json` (same directory as `config.json`, an independent file,
  does not pollute existing configuration). **New features do not touch existing behavior**: all original settings items, buttons, request rewrites, load/unload logic are not one word changed;
  the preset application path is the same path as "Save Settings" (write user layer → unload with new parameters → reload on next conversation).
- **0.4.2** — Fixed "toggling the reasoning tier causes 500". After `0.4.1` made dsh write the tier into `chat_template_kwargs`, two new problems were exposed: ① The model template **directly `raise_exception`s on unrecognized tiers** (in practice this model only recognizes `xhigh`/`medium`/`low`), and the plugin passes the panel tier through as-is, and dsh even sends `off` as boolean `false` — one conversation directly 500; ② The plugin in some situations **still overwrites the request's own tier selection** (when the toggle is off, it also presses High down to no-thinking). Now: after loading, **read the model template and parse out the table of tiers it supports** (shown in both log and status card), remap the panel tier by the table (`high → xhigh`); if it cannot be mapped, do not send this field; normalize all forms like `false`/`null`/`true`; on/off **defers to the request**, and the plugin toggle only takes effect when the request says nothing.
- **0.4.1** — Fixed "dsh's reasoning level slider is a mere decoration". Two causes, both fixed: ① The route profile the plugin registered with dsh **did not declare this is a reasoning model** (missing `reasoningEfforts`), so pi-ai sends no thinking parameters at all and the slider is just decoration; now it declares `compat.thinkingFormat = chat-template` and a seven-tier mapping, letting dsh write the tier into `chat_template_kwargs` (the **only** channel llama.cpp recognizes). ② The plugin's "Enable thinking" toggle **unconditionally** rewrote `enable_thinking` to `true`, even overwriting the Off that dsh chose — now when the toggle is on it only acts as a **default value**: if the request already explicitly writes `enable_thinking` or carries a tier, pass it through as-is; when off it is still a hard overwrite. In addition, the proxy **sinks** top-level `reasoning_effort` into `chat_template_kwargs` — top-level fields are silently discarded by llama-server (no error, no log), a pitfall the community has stepped in.
- **0.4.0** — ① **13 new settings**: 2 KV cache policy items (`kvUnified`, `kvStreamStageMib`, of which streaming staging is a private parameter of a specific llama.cpp branch), 8 sampling parameters (`temp` / `topK` / `topP` / `minP` / `presencePenalty` / `repeatPenalty` / `repeatLastN` / `seed`), 3 multimodal and reasoning budget items (`imageMinTokens` / `imageMaxTokens` / `reasoningBudget`). These parameters are now **explicitly sent on every load, overriding llama.cpp's own defaults** (`temp` 0.8→0.75, `top-k` 40→20, `min-p` 0.05→0, `repeat-penalty` 1.1→1.0), and the differences are noted item by item on the settings page. ② **Deleted the entire "dsh integration" settings group** (`routeName` / `modelAlias` / `routeModelId` / `contextWindow` / `registerRoute` / `exposeTool` / `allowModelControl`): these 7 items became constants in `configResolve.ts`, values following the original defaults, **behavior completely identical to default installation but no longer configurable from now on**. ③ `maxTokens` (maximum output tokens per run) is retained, moved from "dsh integration" into "inference parameters". ④ Also fixed a bug that would silently destroy decimal settings: `clamp()` has rounding inside, and `temp 0.75` would become `1`; decimal items now use the new `clampFloat()`.
- **0.3.1** — New "Multi-Token Prediction (MTP)" toggle (`mtp`, **off by default**). When enabled, loading sends `--spec-type draft-mtp`, using the model's built-in prediction head for speculative decoding; local generation speed usually improves 1.2–2x. **Enabling MTP automatically disables the vision projection file (`--mmproj`)** — the two cannot coexist in llama.cpp, and forcing them together leads to load failure; this mutual exclusion rule is written in the parameter assembly layer (`src/llama/args.ts`), so as long as `mtp` is true, `--mmproj` can never leak through; the corresponding dropdown on the UI immediately grays out, and the status card explains the reason. After turning off MTP, the user-chosen `mmprojFile` is not cleared, it just temporarily does not take effect. Off by default, so **after upgrade, old deployments have zero behavior change**.
- **0.3.0** — Two inference-side capabilities: ① Inference parameters add two toggles "Enable thinking" and "Preserve historical think", sent in the request body of **every request** via `chat_template_kwargs` (`enable_thinking` / `preserve_thinking`); when "Preserve historical think" is off, it also strips `reasoning_content` / think text from historical assistant messages, so thinking content no longer accumulates in multi-turn context; ② Models and directories add a "Vision projection file" selection item, where you can directly pick an mmproj (sent as `--mmproj` on load); **leaving it empty preserves the original "same-directory auto-association" behavior**. These two toggles go through the request body rather than llama-server launch parameters: old builds will only ignore them, never affect model loading, and there is no need to restart the model just to flip a toggle.
- **0.7.1** — Removed version gate: deleted `engines.dsh`, and the peer range of `@deepseek-ai/dsh-tools` reverts from an explicit pre-release branch to `"*"`. The original practice of adding `|| ^X.Y.Z-0` branches per minor is inevitably delayed when the harness releases a new pre-release, causing the marketplace to misjudge "incompatible with current DSH" and pop up a crash warning. Plugin features are not one word changed; compatibility is left for the host to decide.
- **0.2.3** — Release preparation: added `repository` / `homepage` / `engines.dsh`; `peerDependencies` changed from `"*"` to an explicit pre-release branch (the original `*` would silently fail to match the harness's `-rc.x` builds); loader entry id changed from bare `local-model` to `dzqjoker-local-model` to avoid collision with other plugins; removed `private` and `prepare` (artifacts are published with the repo, no build needed at install time); added `LICENSE`, `.gitignore`, `.gitattributes`; aligned `PLUGIN_VERSION` with `package.json`. Also fixed `npm run verify`: it previously did not read DSH Desktop's `activeHome`, so after the data directory was moved it would miss scanning the profile actually in use and report a false conclusion of "this plugin is not installed".
- **0.2.2** — Fixed CUDA OOM: new `gpuLayersMode` (auto / all / custom). The default `auto` sends `-ngl auto`, letting llama.cpp's `--fit` adaptively offload based on available VRAM — previously the default pinned `-ngl` to `-1`, skipping this layer of protection, and when the model did not fit it went from "place fewer layers" to "direct OOM". At the same time, failure logs are translated into readable diagnostics (fit-blocked-by-pinned-layers / cuda-oom / shape mismatch / model missing, a dozen or so patterns).
- **0.2.1** — Fixed `--flash-attn` shape mismatch: old builds sent it as a bare flag, and the argument parser ate the next token as its value; new capability detection and three-state configuration (auto / on / off); auto never sends, which is always the safest.
- **0.2.0** — Fixed dsh.bundle declaration shape + settings sidebar panel; new browser half-side bundle + same-origin data bridge.
- **0.1.0** — Initial version: settings items / launch / idle unload / path conventions / dsh route integration.

---

## 1. Requirements → Implementation mapping

| Requirement | Where it lands |
| --- | --- |
| ① A new independent "Local model" configuration item in settings, selectable model, fillable launch parameters | **Settings sidebar top-level page**: schemastery `Config` in `src/config.ts` (single source of truth) + `src/webBridge.ts` (data plane) + `client/` (browser half-side panel). See [Section 4](#4-settings-page-and-settings-items) for field descriptions |
| ② User downloads llama tools and models themselves, stored in plugin-prescribed directories | `src/paths.ts` defines directory conventions and writes placement instructions on first run; `scripts/fetch-llama.mjs` is an optional one-click download |
| ③ After model selection, the first conversation auto-launches and loads | `src/proxy.ts` (resident lightweight entry) + `ensureReady()` single-flight load in `src/lifecycle.ts` |
| ④ Auto-unload after 5 consecutive minutes without interaction to free resources | `idleUnloadMinutes` (default 5); the decision rule is extracted into a pure function `shouldUnload()`, `src/lifecycle.ts` |
| ⑤ **Parameter presets**: save multiple named parameter groups, fixed at the top of the page, one-click apply | `src/presets.ts` (independent persistence to `state/presets.json` + scope definition) + 5 `/presets/*` routes in `webBridge.ts` + browser-side `client/src/presets.jsx` (top preset bar). See [Section 4](#parameter-presets-new-in-050) |

"Does not occupy resources" is a hard metric: **when there is no conversation, there is only one resident HTTP proxy process on disk (no model loaded, no VRAM occupied)**,
and llama-server is spawned only when the first request comes in. This has an end-to-end test as backstop (see Section 9).

---

## 2. Installation

```bash
# 1) Install into profile — this step also writes dependencies + registers it in dsh.profile.bundles
dsh plugin --profile desktop add github:DZQJOKER/dsh-plugin-local-model
#    For local development, change to a local path:
#    dsh plugin --profile desktop add D:/path/to/dsh-plugin-local-model

# 2) Restart dsh — bundle composition is fixed at startup; installing/uninstalling plugins always requires a restart (refreshing the browser has no effect)
```

After installation, open **Settings → Local model** and you will see the independent configuration group.

### Installing from GitHub does not require building on the user's machine

This repository **already contains pre-built artifacts** — `lib/` (host half-side) and `client/client.js` (browser half-side).
The package intentionally has **no `prepare` script**: pnpm by default refuses to execute build scripts for git dependencies, aborting installation before materialization with
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` (`needs to execute build scripts but is not in the
"allowBuilds" allowlist`). Artifacts in the repo + removing `prepare` — that is the only way this path works.

The cost is that **after changing `src/` or `client/src/`, you must re-run `npm run build` before committing**,
otherwise users will install the previous artifacts. After changes, run `npm test` once (it first `build`s and then self-checks).

### Self-check after installation

```bash
npm run verify
```

It checks two things: whether this package is a **valid dsh bundle**, and in which profiles it is **installed but not active**.
The latter is exactly the cause of the plugin management page showing "installed, not active"; the output looks like this:

```
A. Bundle manifest
  ✓ dsh.bundle.patch = ./cordis.patch.yml
  ✓ patch name is package name: dsh-plugin-local-model
B. Profile mount status
  ✗ desktop → installed as dependency, but not in dsh.profile.bundles (this is "installed, not active")
```

### Why `dsh.bundle` must be declared

dsh's installation mechanism is built on two manifest concepts, both written in the `dsh` field of `package.json`:

| Concept | What it is | How to declare |
| --- | --- | --- |
| **bundle** | An npm package with a configuration layer, explaining "what this package contributes" | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| **client** | Browser half-side (settings UI, panels, cards) | `"dsh": { "client": { "inject": [...], "platform": "web" } }` + `exports["./client"]` |
| **profile** | A directory under `$DSH_HOME/profiles/`, explaining "which bundles compose this configuration in what order" | The profile's own `dsh.profile.bundles` |

**A package without `dsh.bundle` can still be installed, but it only exists as an ordinary dependency; dsh will not activate any layer it contributes.**
This design is for libraries that are "imported by other plugin packages, not directly enabled by users"; for a plugin that should be directly enabled,
missing this field is the same as installing in vain. Declaring the shape wrong (e.g. writing string `"bundle": "package-name"`) has the same consequence as not writing it.

**The host-side `Config` schema is only responsible for reading and writing configuration; it does not grow a UI by itself.** Every item in dsh's settings sidebar is
contributed by a client UI plugin, so to make "Local model" appear in settings, you must separately provide the browser half-side
(a bundle in the form of `dsh.client` + lazy-CJS factory). The official `dsh-client-ui-settings-plugins` documentation states this very plainly:

> A card still needs a browser bundle: the browser half-side must be built as a lazy-CJS factory format
> `dsh.client` package following the client module system, and the `clientBundle` preset that produces it is in `packages/client/tsdown.client.ts`,
> **not a published package, so plugins outside this repo must replicate the build themselves**.

This plugin's replication is `scripts/build-client.mjs` (esbuild bundling + manually wrapping with a `window.__ModuleLoader__.load`
shell), and `scripts/client-check.mjs` runs it once with a fake loader to ensure the format does not drift.

The layering order of configuration layers is: each bundle's patch in the profile (in declaration order) → the profile's own `cordis.patch.yml`
→ `$DSH_HOME/cordis.patch.yml` → command line `--patch`. **Later layers override earlier ones, and it is whole-block replacement of config, not deep merge.**

## 3. Placing models and llama tools

On first run, the plugin creates the directories and places instruction files:

```
$DSH_HOME/local-model/            # Windows default C:\Users\<you>\.dsh\local-model
├── models/                       # ← Put GGUF here (subdirectories allowed)
│   └── PUT_GGUF_MODELS_HERE.txt
├── runtime/                      # ← Unzip llama.cpp here (can be placed in one level of subdirectory)
│   └── PUT_LLAMA_RUNTIME_HERE.txt
└── state/                        # Plugin self-managed: pid, logs, settings and presets — don't worry about it
    ├── config.json               # User layer configuration saved by the settings page
    └── presets.json              # Parameter presets (since 0.5.0; this file does not exist if no group has ever been saved)
```

**llama tools**: download the package for the corresponding platform from <https://github.com/ggml-org/llama.cpp/releases> and unzip to `runtime/`
(NVIDIA choose `win-cuda-x64`, no discrete GPU choose `win-cpu-x64`, macOS choose `macos-arm64`).
You can also let a script do it:

```bash
node scripts/fetch-llama.mjs                 # Auto-detect platform and backend
node scripts/fetch-llama.mjs --variant=cuda  # Specify backend: cuda / vulkan / hip / cpu
node scripts/fetch-llama.mjs --dry-run       # Only preview which package to download
```

**Models**: download `.gguf` and put it in `models/`. The plugin supports three layouts, all auto-detected:

- Single file: `Qwen3-8B-Q4_K_M.gguf`
- Shards: `xxx-00001-of-00003.gguf` ×3 — automatically merged into one model; **missing shards produce an explicit prompt rather than loading a half model**
- Vision: place `mmproj-*.gguf` in the same directory — auto-associated only when ownership can be determined (better to miss than to mis-associate);
  if there are multiple models / multiple projection files in the directory and auto-association cannot resolve it, just go to **Settings → Local model → Vision projection file** and pick one manually.

After placing, return to **Settings → Local model**, click "Rescan", and select the model from the dropdown.

## 4. Settings page and settings items

### Where is the panel

After restarting dsh, open **Settings**; a top-level entry **"Local model"** appears in the sidebar (after "General settings / Models").
The panel contains, in order:

- **Parameter presets** (since `0.5.0`, the pinned block at the top): click a name to apply, `✎` to rename, `×` to delete, input box + "Save as preset" to create new;
  after applying you can also "Update 'X' with current parameters". See [a separate section below](#parameter-presets-new-in-050).
- **Runtime status**: status badge (idle / loading / ready / unloaded / failed), current model, process pid, entry address,
  expected auto-unload time, most recent error; with "Rescan / Load now / Unload / Refresh status" buttons.
- **Model dropdown**: lists all GGUFs scanned from the model directory, with quantization, parameter count, size, shard completeness, presence of vision projection.
  Incomplete shards are grayed out and explained in the text.
- **Six parameter groups**: Models and directories / Service and port / Inference parameters / Sampling and KV cache / Loading and unloading / Diagnostics and advanced.
  Every field has a description; **the text and default values come directly from the schema in `src/config.ts`**; fields that have been changed are marked "overridden",
  with a "Default" button next to them for individual restoration.
- **Directory conventions**: three absolute paths — model directory, runtime directory, user configuration file — just place files accordingly.
- **Bottom**: Save / Discard changes / Restore defaults; the number of unsaved items is shown in real time.

The panel is **data-driven**: field list, types, default values, descriptions are all sent by the host after serializing the schema
(`Config.toJSON()` → `src/schemaForm.ts`), so adding a field to `config.ts` automatically appears in the UI.
Two exceptions are fields that **need a dropdown** (`selectedModel` for model selection, `mmprojFile` for vision projection file selection) —
options come from scan results and cannot be expressed in the schema, so the client renders them specially; all other fields appear automatically.

### Layout constraints (since 0.5.1, must read before changing styles)

The settings panel has **only 564px usable width**; this is measured, not estimated:

```
Host .panel    width: 800px (max-width: calc(100vw - 48px))
Left nav .nav    width: 188px (flex:none)
.options        padding: 0 24px 24px
                 ────────────────────────────────
Content area          800 − 188 − 48 = 564px
```

Therefore the client styles have two hard constraints, asserted one by one by `scripts/client-check.mjs` (the rule body is in `client/src/layoutCheck.js`;
when new styles hit the same kind of problem, add a line there):

1. **Do not write a `maxWidth` exceeding the usable width.** The content area uses `maxWidth: '100%'`.
2. **Any container inside flex / grid gets `minWidth: 0`, and column widths use `minmax(0, …)`.**
   Grid's automatic minimum size defaults to `auto` (= not smaller than the content's minimum width), so bare `1fr` refuses to compress —
   when usable width is insufficient, cells get pushed to the next line and visually overlap adjacent elements. This has been stepped in once:
   field row `minmax(140px, 190px) 1fr auto` minimum requirement about 420px, always occurs on panels ≤800px.

The pinned `position: sticky` bar has three more points that must be satisfied together (reasons written in the `cardPinned` comment in `styles.js`):
opaque background (cover lower content), horizontally covering `.options`' 24px padding (no gap on either side),
`isolation: isolate` (build own stacking context, do not compete with panel title bar for layering).

### Color variables: only `--dsw-*` allowed (since 0.5.2, a clause written in blood)

**There are no `--color-*` variables at all in DSH.** Host `@deepseek-ai/dsh-client-ui-theme` only defines one set of `--dsw-*`:

```
--dsw-alias-bg-base / bg-layer-1|2|3 / bg-overlay / bg-mask-1
--dsw-alias-border-l1|l2|l3|l4
--dsw-alias-label-primary|secondary|tertiary|dimmed|caption
--dsw-alias-button-primary-fill|hover / button-ghost-active-fill|border
--dsw-alias-interactive-bg-hover
--dsw-alias-state-error|success|warn-primary / -secondary / -tertiary
--dsw-static-neutral-bluish-{00,50,60,75,100,…,1000} and other static palettes
```

After writing code like `var(--color-background-primary, 'transparent')`, **there will be no error, no warning** —
the variable does not exist, `var()` falls back directly to the fallback, and the fallback is hand-written and easily written as `transparent`.
The symptom is "elements are transparent, lower text shows through", and then you start suspecting `z-index`, `position`,
stacking context…… **all wrong**, because nothing is being drawn at all.

Three rules (blocked by `client-check.mjs`):

1. **Only use `--dsw-*` / `--font-*` / `--dsh-*`**; any other prefix is considered not provided by the host.
2. **Containers that cover lower content (`card` / `cardPinned` / `footer`) must have opaque backgrounds.**
   Panel background uniformly uses `--dsw-alias-bg-layer-2` — host `.MI-_Aa_panel` itself is this value;
   only when both sides are the same color can sticky elements "blend into" the panel without a visible seam.
3. **Sticky bars must cover `.options`' horizontal padding**: `marginLeft/Right: -24` + `paddingLeft/Right: 24`.
   Otherwise a 24px gap remains on each side of the card, and during scrolling lower content passes through the gap.

> General method for troubleshooting this kind of problem: scan variable definitions from the full `app.asar` (`find.mjs` / `pick.mjs` are in
> `D:\日常工作区\_dev-tools\dsh-asar-tools\`). As long as a variable appears 0 times among 21810 files,
> it **does not exist**, and every `var()` in the code is walking the fallback.

### Parameter presets (new in 0.5.0)

The block at the **very top** of the settings page, pinned to the top with `position: sticky`: the dozens of parameters below are for tuning,
and when switching the whole set of parameters, you should not have to scroll back to the top of the page to find the button.

| Operation | How to do it |
| --- | --- |
| Create new | Enter a name (Enter or click "Save as preset"). Name max 40 characters, duplicates rejected (case-insensitive), max 100 groups |
| Apply | **Click the preset name**. Unload the model with new parameters, reload on next conversation — same path and same consequence as "Save Settings" |
| Rename / Delete | `✎` / `×` on the preset. Deleting a parameter group does not affect currently active settings |
| Update one group | After applying, "Update 'X' with current parameters" appears — writes this set of parameters from the UI back to it, name unchanged |
| See differences | Each preset is marked "N items different"; the one completely identical to the currently active configuration is marked "currently active" and highlighted |

**Which settings go into presets, which do not:**

| | Fields | Why |
| --- | --- | --- |
| ✅ Into presets (41 items) | Current model, vision projection file, MTP, context length, GPU layers, threads/batch size, Flash Attention, KV precision and policy, 8 sampling parameters, image token budget, reasoning budget, three thinking toggles, Jinja/template, mmap/mlock, extra parameters, environment variables, idle unload and timeout retry, single maximum output | These are the content of "a set of parameters". A preset like "image viewing" should originally switch along with the model |
| ❌ Not into presets (9 items) | `enabled`, `modelsDir`, `runtimeDir`, `llamaServerPath`, `host`, `port`, `llamaPort`, `apiKey`, `logLevel` | These belong to **this machine**, not **this set of parameters**: ports are related to whether other services occupy them, paths are deployment environment, keys should not be stored in plaintext again in the preset file, log level is a temporary switch for troubleshooting. Switching a parameter preset but changing the port would only be an incident |

The scope is uniquely defined by `PRESET_EXCLUDED_KEYS` in `src/presets.ts`, and the description text on the UI also comes from the same place
(the host sends `keys` / `excluded` together into `/state`), so there is no possibility of writing one copy on each side and drifting.

**Two interaction rules worth knowing:**

1. **What is saved is the current set of parameters on the UI**, including unsaved changes — the UI states "includes N unsaved changes".
   When a number box is cleared, it is treated as "unset" (falls back to the saved value), not written as 0;
2. **Applying a preset discards unsaved drafts**, so if there is a draft, a confirmation pops up first; after successful application the draft is cleared —
   otherwise a bunch of fake "unsaved" impressions would remain on the UI.

Presets are stored at `<DSH_HOME>/local-model/state/presets.json`, same directory as `config.json` but **an independent file**:
one configuration + several switchable parameter sets, not interfering with each other. File corruption, unreasonable content (missing name, missing id, duplicate id, no parameter items at all)
only **degrades to "no presets" and is explained on the panel**, never affecting the main line of model loading — it is just a convenience feature.

### Three layers of settings

Following dsh's own three-layer semantics, the user layer lands in the plugin directory:

```
schema defaults  →  composition layer (cordis.patch.yml / deployment configuration)  →  <DSH_HOME>/local-model/state/config.json
```

What the panel saves writes to the topmost file; "Restore defaults" clears it, falling back to composition layer + schema defaults.
The JSON sent by the browser is only coerced according to the type table in `src/configStore.ts`; keys not in the table are all discarded —
the UI cannot write dirty data that would pollute the llama-server command line.

**"Apply preset" writes to the same file and passes through the same gate**: preset values are first filtered by scope (see previous section),
then go through `ConfigStore.update()` — so "clicking a preset" and "clicking save" are completely identical in persistence, unloading, and prompting;
there is no possibility of two sets of logic each running their own. The preset file itself is not exempt: values read back from `presets.json` also pass through the gate once;
dirty data hand-edited into the configuration file will not reach the command line.

> Why not use dsh's settings namespace: the current dsh version's settings apiproxy only serves a hardcoded namespace whitelist,
> third-party plugin namespaces are uniformly answered with `settings-not-exposed`, and the browser side can neither read nor write.
> Building one's own same-origin HTTP bridge (`/api/local-model`, registered on the host webServer) is the only reliable channel on this version of the host.

### Bridge security posture

Local tool, no account system, so relying on three hard constraints rather than authentication:

1. **Only accept requests from loopback origin** — configuration changes and process start/stop should not be triggered by anyone on the LAN (`/presets/*` too);
2. **Write operations require `content-type: application/json`** — ordinary cross-site form submission cannot do this,
   so even if a malicious page is running in the browser, it cannot send requests that can change configuration;
3. Request body has a size limit.

Therefore: **when accessing dsh via LAN / remote Web UI, this panel will be rejected** (this is intentional). Local models are inherently local capabilities.

### Field overview

Types, default values, and descriptions are all written in the settings panel; here only the key groups are listed:

| Group | Key fields |
| --- | --- |
| Models and directories | `enabled`, `selectedModel`, `mmprojFile` (vision projection file), **`mtp` (multi-token prediction; enabling automatically disables vision projection)**, **`imageMinTokens` / `imageMaxTokens` (token budget floor/ceiling per image)**, `modelsDir`, `runtimeDir`, `llamaServerPath`, `preload` |
| Service and port | `host` (default listens only on loopback), `port` (default 18080), `llamaPort` (default 0 = auto-pick a free port each time) |
| Inference parameters | `ctxSize`, **`maxTokens` (maximum output tokens per run)**, **`nPredict` (server-side default output limit)**, **`guardContextOverflow` (output limit overflow protection, on by default)**, `gpuLayers`, `loadMode`, `threads`, `batchSize`/`ubatchSize`, `flashAttention`, `mmprojOffload`, **`mtpWithVision` (MTP and vision coexist, on by default)**, **`reasoningBudget` (reasoning token budget)**, `reasoningBudgetMessage`, `reasoningEffort`, `jinja`, `chatTemplate`, `chatTemplateFile`, `chatTemplateKwargs`, `enableThinking`, `preserveThinking`, `mmap`, `mlock` |
| Multi-Token Prediction (MTP) details | `specKvDtype`, `specDraftNMax`, `specDraftPMin` (only effective when the above "Multi-Token Prediction (MTP)" is on) |
| KVMem block cache (kvmem branch exclusive) | `kvmemEnabled`, `kvmemBudget`, **`kvmemGenReserve` (decode reserve = single generation limit; build default only 256)**, `kvmemBlockTokens`, `kvmemSinkTokens`, `kvmemRecentTokens`, `kvmemMethod`, `kvmemQueryLast`, `kvmemQueryMaxTokens`, `kvmemQueryReplay`, `kvmemQueryPolicy`, `kvmemMtpState`, `kvmemGpuRatio`, `kvmemCpuGb`, `kvmemNvmeGb`, `kvmemNvmeDir`, `kvmemHarvestV`, `kvmemRawKNvme`. **All defaults in the whole group are "do not send"** (numeric `-1`, strings left empty); on official llama.cpp builds they are skipped as a whole and logged |
| **Sampling and KV cache** | **`kvUnified` (unified KV cache)**, **`kvStreamStageMib` (KV host memory staging MiB)**, **`temp`, `topK`, `topP`, `minP`, `presencePenalty`, `repeatPenalty`, `repeatLastN`, `seed`** |
| Loading and unloading | `idleUnloadMinutes` (default 5), `startupTimeoutMs`, `shutdownGraceMs`, `autoRestart`, `maxRestarts` |
| Diagnostics and advanced | `apiKey`, `extraArgs`, `envOverrides`, `logLevel` (set to `debug` when troubleshooting loading problems) |

> There was originally a group of "dsh integration" (`routeName` / `modelAlias` / `routeModelId` / `contextWindow` /
> `registerRoute` / `exposeTool` / `allowModelControl`). Since `0.4.0`, this group has **been removed from the schema**,
> becoming constants in `src/configResolve.ts` (values = original defaults), so behavior is unchanged but no longer configurable.
> See [Section 4 "Where did the dsh integration settings go"](where-did-the-dsh-integration-settings-go).

After saving, the model is unloaded once, and the next conversation reloads with new parameters — the user just changed settings, and this is exactly the behavior expected.

### The plugin first probes your llama.cpp before assembling parameters

The same parameter changes shape in different versions of llama.cpp. The most typical is `--flash-attn`:

| Build | Shape | How the plugin sends it |
| --- | --- | --- |
| New (e.g. b10822) | `-fa, --flash-attn [on|off|auto]` with value | `--flash-attn on` / `--flash-attn off` |
| Old | `-fa, --flash-attn` bare switch | `--flash-attn` (only when set to `on`) |

**If you do not probe and directly send a bare flag in the old shape, the new build's argument parser will eat the next token as its value**,
and what is reported is `unknown value for --flash-attn: '--mmproj'` — the error message points to the swallowed parameter,
and the troubleshooting direction goes completely off.

So the plugin first runs `--help` before starting the process, asking two things: **which options this build recognizes**,
**what shape `--flash-attn` is in** (results are cached per executable; each load only pays the cost once). Two side benefits:

- **Unrecognized options are not sent** (see the "switching to a different llama branch also starts" section) —
  many branches directly `unknown flag: xxx` + exit 1 for unknown options, not ignore them;
- In case the probe result does not match reality (or detection failure causes the sent shape to be wrong), after the service reports an error the plugin **automatically removes this parameter and retries once**,
  and writes "changed to not send" into the log — no need for the user to guess.

`flashAttention` is therefore three-state, not a switch: **`auto` (default) never sends this parameter**. Because `auto` in all builds supporting three states
equals the default value, and in old builds that only support bare switches it cannot be expressed at all — not sending is the only semantically correct approach on both kinds of builds.
Historical configurations' `true/false` automatically converge to `on/off`.

> In addition: newer llama.cpp has marked `--mlock` / `--no-mmap` as DEPRECATED (recommending use of `--load-mode`),
> but both are still usable, and the plugin continues to use them; if they are removed in the future (or a build without them is used), gating will skip directly and name them.

### Multi-Token Prediction (MTP)

New in `0.3.1`, **off by default**. When enabled, loading sends `--spec-type draft-mtp`, letting the model use its **built-in prediction head**
to guess and verify multiple tokens at once (speculative decoding); local generation speed usually improves 1.2–2x, more obvious for longer replies.

**The relationship between MTP and vision projection is in the next section "MTP and vision coexistence"** — since `0.7.0`, the two can be enabled simultaneously by default;
the mutual exclusion rule only recovers when `mtpWithVision` is turned off (upstream llama.cpp needs that).

### MTP and vision coexistence (`0.7.0`)

Setting item `mtpWithVision`, **on by default**. In upstream llama.cpp, MTP and image input cannot be sent simultaneously (load failure),
but **the kvmem branch's `llama-kvmem-server` supports it**: when given both `--mmproj` and `--spec-type draft-mtp`,
`clip_model_loader: has vision encoder` and `creating MTP draft context` appear simultaneously, the service starts normally,
and image conversations are also recognized (measured on this machine 2026-09-21). So by default "using images with MTP on" is allowed.

Turning it off recovers the old mutual exclusion: MTP active, `--mmproj` ignored — the dropdown on the UI grays out, the status card explains the reason,
**your chosen `mmprojFile` is not cleared** (so as not to lose configuration when switching the toggle back and forth). Users who switch back to official llama.cpp should turn off this item.

### Launch parameters panel for this run (`0.7.0`)

At the **very top** of the settings page, the **full command line actually sent to llama-server this time** is displayed (one line per item), plus a parameter summary
(including the derived "GPU KV total = working set + decode reserve") and a "Copy command line" button.

Two deliberate trade-offs:

- **The data source is the sent args, not the configuration on the settings page.** Between the two there are gating skips, build defaults, and auto-convergence
  (like `-ub <= -b`, `-np 1`); only args can answer "what parameters is it actually running with right now".
- **It also lists "options not covered by the recognition table."** The recognition table becomes outdated as builds change; if missed items are not spoken,
  users will never know they were sent — invisible parameters are more dangerous than wrong values.

| Fact | Description |
| --- | --- |
| Toggle name | `--spec-type draft-mtp` (not `-mtp` / `--spec mtp`; those are remnants of early writing, already standardized away) |
| Does a draft model need to be required? | No. MTP uses the model's built-in prediction head; this is where it is less hassle than traditional speculative decoding |
| llama.cpp version | Requires builds after 2026-05 (PR #22673 merged MTP support) |
| Model requirement | Must be a **GGUF with an MTP head** (filename often contains `MTP` characters). Enabling this toggle on an ordinary GGUF has **zero effect and no error** |
| With image input | **Mutually exclusive**. With MTP on, `--mmproj` cannot be sent |
| Draft depth | `--spec-draft-n-max` (llama.cpp default 16, community recommends 2~3; too large is actually slower). The plugin **does not send** this value; use "extra parameters" when needed |

> The easiest pitfall to step in is item 4: **enabling the toggle on an ordinary GGUF has no acceleration at all and no error**. If you enabled MTP but feel it did not get faster,
> first check if the model filename contains `MTP` characters, then look at llama.cpp's build date.

### Sampling parameters and KV cache policy (new in 0.4.0)

This group is **explicitly sent on every load**, so it **overrides llama.cpp's own defaults**. The differences are also written item by item in the settings page descriptions;
here they are summarized into a table:

| Parameter | Plugin default | llama.cpp default | Description |
| --- | --- | --- | --- |
| `--temp` | 0.75 | 0.80 | Temperature: higher is more random |
| `--top-k` | 20 | 40 | Only sample from the K most probable tokens; 0 = no filter |
| `--top-p` | 0.95 | 0.95 | Nucleus sampling threshold (identical) |
| `--min-p` | 0.0 | 0.05 | 0 = turn off minimum probability filter |
| `--presence-penalty` | 0.0 | 0.0 | Presence penalty (identical) |
| `--repeat-penalty` | 1.0 | 1.10 | 1.0 = no repeat penalty |
| `--repeat-last-n` | 64 | 64 | How many recent tokens to check (identical); skipped when the build does not expose it (see "branch builds" section) |
| `--seed` | -1 | -1 | -1 = use a random seed on every startup (identical). **Negative numbers are not sent**: the minus sign is just the way of writing "random", and not sending is random — but some branches validate the value range as uint32, and receiving `-1` directly reports an error and exits |

**So after upgrading to 0.4.0, generation style changes**: more deterministic (lower temp), narrower candidates (top-k halved),
no longer penalizing repeats, min-p filter turned off. To revert to the original, fill in the values from the right column of the table above back into the settings page.

The two KV items are for long context:

| Parameter | Plugin default | Role |
| --- | --- | --- |
| `--kv-unified` | Off | Manage the KV cache with one unified buffer, reducing VRAM fragmentation caused by "per-layer allocation", making long context easier to fit. The cost is that this buffer is reserved at load time for the **full context** — it occupies VRAM even if it rarely runs full |
| `--kv-stream-stage-mib` | 1024 | Stage this many MiB of KV cache into host memory to relieve VRAM pressure. 0 = do not send. **This is a private parameter of the "adaptive KV streaming" llama.cpp branch**; upstream builds do not recognize it. When enabled, the plugin **automatically appends `-np 1`** (see explanation below) |

> ⚠️ **`--kv-stream-stage-mib` has a precondition: block-level KV streaming requires "exactly one sequence."**
> And llama.cpp's `-np` default is `-1` (auto), which lands on multi-sequence — so "turning on staging makes it unable to load":
>
> ```
> E llama_init_from_model: failed to initialize the context:
>     block KV streaming requires exactly one sequence (-np 1)
> ```
>
> So as long as the staging value > 0 and the build supports it, the plugin **automatically appends `-np 1`** (and explains in the log),
> not leaving this pitfall for you to guess. The side effect is that concurrent slots become 1 — no impact on local single-user use.
> If you wrote `-np` / `--parallel` yourself in "extra parameters", the plugin **will not override** your explicit setting,
> but will warn in the log: if it is not 1 there, loading will fail.

The two image items (`--image-min-tokens` / `--image-max-tokens`) only take effect on vision models with **dynamic resolution**, and a vision projection file must be attached first;
when `max` is smaller than `min`, the plugin lifts it to `min` in place (otherwise llama.cpp refuses to start).
`--reasoning-budget` limits the maximum length of the thinking chain; 0 = turn off thinking, -1 = unlimited.

### How dsh's "reasoning level" slider connects to local models

For **Off / Low / Medium / High** in the dialog box to truly take effect, it must pass three gates. `0.4.1` and earlier only got half through,
so "toggling has no response" occurred; `0.4.2` got all three through:

| Stage | Who is responsible | Description |
| --- | --- | --- |
| ① dsh knows this is a reasoning model | **Your route configuration** | The model entry must have `reasoningEfforts`. Without it, pi-ai considers this not a reasoning model and **sends no thinking parameters at all** |
| ② Tier sent to llama-server | Proxy layer | The tier must land in `chat_template_kwargs.reasoning_effort`. **Top-level `reasoning_effort` is silently discarded** (no error, no log); the plugin moves it in |
| ③ Value sent to template must be one it recognizes | Proxy layer | The plugin **reads the model's conversation template** and remaps the tier to the few the template actually supports |

Item ③ is key, and also the pitfall `0.4.1` stepped in: **the model template directly throws on unrecognized tiers, not ignores them.**
In practice, this model's template says:

```jinja
{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
    {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ ...) }}
```

It only recognizes `xhigh` / `medium` / `low` (default `xhigh`). So choosing High on the panel, or dsh writing `off` as boolean `false`,
both cause **the whole conversation to 500**. The plugin's approach since `0.4.2`:

- After loading, read the model template once and parse out the table of tiers it supports (printed in the log, also shown on the settings page status card);
- Panel tier → map to the closest one in the table (when distances are equal, take the higher one, so `high → xhigh`);
- Cannot be mapped, or no tier table parsed at all → **just do not send this field**, letting the template use its own default.

The passing of `off` is also fixed together: dsh turns "tier = off" into **boolean `false`** after a round trip through `settings.yaml`
(YAML reads `off` as boolean). The plugin now recognizes this form and translates it to `enable_thinking: false`.

When the toggle remains on, what is finally sent to llama-server:

| Dialog tier | Actually sent |
| --- | --- |
| Off | `{"enable_thinking": false, "preserve_thinking": true}` |
| Low | `{"enable_thinking": true, "reasoning_effort": "low", "preserve_thinking": true}` |
| Medium | `{"enable_thinking": true, "reasoning_effort": "medium", "preserve_thinking": true}` |
| High | `{"enable_thinking": true, "reasoning_effort": "xhigh", "preserve_thinking": true}` ← rewritten by template |

> To know the tier table actually parsed on your machine: look at the line "Reasoning tiers supported by the model template" in the log,
> or look at "Reasoning tier" in the status card of **Settings → Local model**. It determines what the panel tier will finally become.
>
> Another more reliable lever is **"reasoning token budget"** (`--reasoning-budget`, engine-level hard limit):
> tier is "ask the model to think for itself how deep", budget is "force interruption if thinking exceeds N tokens". The two are complementary, not conflicting.

### Three settings related to "thinking", how they work together

There are three items on the settings page that all affect the model's thinking behavior. They **do not conflict, but act at different layers** — mixing them up easily leads to wrong conclusions:

| Setting | Acting layer | Effective timing | What it does |
| --- | --- | --- | --- |
| **Enable thinking** | Template level | **Every request** | Tells the conversation template: whether to enter thinking mode. **Only takes effect when the request says nothing** — if the request carries `enable_thinking` or a reasoning tier, defer to the request |
| **Preserve historical think** | Template level | Every request (`preserve_thinking`; when off, also strips think text from history) | In multi-turn conversations, whether historical assistant thinking content stays in context |
| **Reasoning token budget** | Engine level | **At load time** (`--reasoning-budget`) | Counts thinking tokens; force-ends thinking when exceeded |

Why "enable thinking" goes through the request body while budget goes through launch parameters: the former is a preference that may change every turn; changing it in the request body takes effect immediately,
and old builds at worst only ignore it; the latter is a constraint of the sampling phase, and llama.cpp only provides the launch parameter as an entry.

Two combinations to avoid:

| Combination | What happens |
| --- | --- |
| Enable thinking **off** + budget **> 0** | The budget will never be triggered — the template doesn't even enter thinking, so where would thinking tokens come from. Looks like "budget not working", but actually it is bypassed |
| Enable thinking **on** + budget **0** | The model first enters thinking, then is immediately cut off. Usually produces an empty thinking block; on some models it directly goes off the rails |

**To completely not think, use "Enable thinking = off"** (fast, stable, recognized by old builds); **only use the budget to set an upper limit on the thinking chain.**

> The budget has a side effect worth knowing: when exhausted, the model is **hard-cut**, and llama.cpp's transition prompt
> (`--reasoning-budget-message`) is not sent by the plugin. Official maintainers measured with HumanEval: when the budget is set too tight and there is no prompt,
> scores drop from 94% to 78%. If a prompt is needed, add `--reasoning-budget-message "…"` yourself via "extra parameters".
> Also `--reasoning-budget` requires a newer build (the plugin probes first; if the build does not recognize it, skip and explain in the log).

### Switching to a different llama branch also starts: only send options the build admits

`--kv-unified`, `--kv-stream-stage-mib`, `--image-*-tokens`, `--reasoning-budget` are all relatively new,
and streaming staging is exclusive to a specific branch. And **unrecognized options cause the service to fail to start directly** —
that equals "switched to a branch / added a toggle, and the plugin instead cannot start".

So the plugin first runs `--help` before starting the process (this probe was introduced at the beginning of this section), and **only sends options the build admits**.
Two levels of strictness, each solving a specific problem:

| Which kind of option | When detection fails | When the build explicitly does not expose it | Example |
| --- | --- | --- | --- |
| Only present in new builds / specific branches | **Do not send** (better to fall back to build defaults than to bet on recognition) | Do not send | `--kv-unified`, `--kv-stream-stage-mib`, `--image-*-tokens`, `--reasoning-budget` |
| The rest (aliases, threads, batch size, sampling parameters…) | **Send as before** (completely identical to historical behavior; one `--help` failure should not lose your sampling settings) | **Do not send** | `--alias`, `-t`, `--threads-batch`, `-ub`, `--repeat-last-n`, `--no-mmap`, `--mlock`, `--api-key`, that group of `--temp` |

Everything skipped is written to the log (`This llama-server does not recognize the following options; skipped (does not affect loading): …`),
never silent — what you can see is "which options were not sent", not "one item missing from the command line".

Measured counter-example (that standalone `llama-kvmem-server.exe` of `kvmem-v0.16.0-rc2`, whose option table is a true subset of llama.cpp's):

```
unknown flag: --alias
usage: ...\llama-kvmem-server.exe -m model.gguf [options]
```

It reports only one unknown option at a time and then exits 1 — so "just fixing `--alias`" is not enough:
`-t` / `-ub` / `--repeat-last-n` / `--no-mmap` / `--api-key` will be next.
`--seed -1` is another form: the option is recognized, but the value exceeds its validated uint32 range (see the table in the previous section).

> To know which options your copy of llama.cpp recognizes and what the plugin will actually send? Run `npm run verify:llama`:
> it assembles the full command line with your real configuration (model swapped for a non-existent sentinel path, no VRAM occupied), really starts the service once and reports the conclusion;
> it also reports "which options were skipped" and whether parameter errors like `unknown flag` appeared in the measurement.

### Where did the "dsh integration" settings go

`0.4.0` deleted the entire "dsh integration" settings group at the user's request. They **became constants** (`src/configResolve.ts`),
values being the original defaults:

| Original setting | Current constant | Impact |
| --- | --- | --- |
| `routeName` | `local-llama` | Route name fixed; no need to change dsh-side `settings.yaml` |
| `modelAlias` / `routeModelId` | `local` | The id in the model selector is fixed as `local` (answered by the plugin's own `/v1/models`); `--alias` just incidentally lets upstream also call it this name; skipped when the build does not recognize it, dsh-side id unaffected |
| `contextWindow` | **Follows `ctxSize`** | See below |
| `registerRoute` | Always true | Always tries to register the route; when the host has no interface, degrades as before to printing pasteable YAML |
| `exposeTool` | Always true | The `local_model` tool is registered as before |
| `allowModelControl` | Always false | **Capability trade-off**: `local_model`'s `start` / `stop` are always rejected from now on, cannot be turned on again |

`contextWindow` is the only one whose **value changed**: it was previously independently configurable (default 32768), while `ctxSize` defaults to 8192 —
the inconsistency between the two is exactly the "declared larger than actual → crashes mid-long-conversation" that the plugin has always warned about. Now the declared window directly takes `ctxSize`,
both from the same source, can never be misaligned again, and the post-startup reconciliation warning is also more accurate.

> Side effect reminder: the `start` / `stop` actions of the `local_model` tool are now always rejected (this was originally the default behavior,
> but previously `allowModelControl` could turn it on). To restore controllability, you must change the constants in `src/configResolve.ts`.

## 5. Model route integration

On startup, the plugin tries to register the local endpoint into dsh's llm seam. **Registration success** (visible in the log
as `Registered local model route via llm.<method>()`) lets you directly select `local` in the model selector.

**If the host does not expose a registration interface**, the plugin does not report an error and does not affect model loading; it only prints a piece of configuration
that can be pasted directly in the log; merge the content of `examples/settings-route.yaml` into `$DSH_HOME/settings.yaml`
(if `providers` already exists, **merge**, do not overwrite the whole thing):

```yaml
llm-pi-ai:
  providers:
    local-llama:
      displayName: Local model (llama.cpp)
      api: openai-completions
      baseURL: http://127.0.0.1:18080/v1
      streamIdleTimeoutMs: 600000      # Local/CPU inference is slow; this must be relaxed
      models:
        - id: local
          contextWindow: 8192          # Follows "Settings → Context length"; when changing ctxSize, change here too
          maxTokens: 8192
```

> Above is the minimum connectable version. **The full version (including `compat` and `reasoningEfforts` for "reasoning tier") is in
> `examples/settings-route.yaml`** — without that part, dsh's "reasoning level" slider malfunctions;
> when the plugin auto-registers it carries that, and what `/local-model route` prints is also the full version.
>
> Since `0.4.0`, the two names `local-llama` and `local`, as well as the rule `contextWindow = ctxSize`, are all **fixed**
> (the original `routeName` / `modelAlias` / `routeModelId` / `contextWindow` settings have been deleted).
> When hand-writing configuration, just copy the ids above; `contextWindow` is the only value you need to keep up with `ctxSize`.
> The route the plugin itself registers auto-fills this field with `ctxSize`, so only hand-written configurations need to worry about it.

In a conversation you can also use `/local-model route` to print this configuration at any time.

## 6. Operating mechanism

**Why have a resident proxy?** The most direct approach is to let dsh connect to llama-server's port. But after the model is unloaded, that port
is no longer listened on, and **the next conversation will necessarily fail to connect** — and "on-demand loading" requires the endpoint to normally not be there. This is a dead end.

The solution is to have the plugin resident an extremely lightweight HTTP entry (no model loaded, no VRAM occupied), which digests "the model is not yet loaded":

```
First conversation ──▶ Plugin proxy :18080 ──ensureReady()──▶ Launch llama-server (internal random free port)
                     │                                   │
                     │◀────── Wait for /health ready ────────────┘
                     └──Forward as-is (including SSE streaming)──▶ llama-server
                                         │
               5 consecutive minutes without interaction ◀────────┘ Unload → Port released → Back to idle
```

For dsh, the endpoint is always online; for the user, VRAM is only occupied when truly in use.

**The proxy rewrites one kind of request body: chat completions**

"Forward as-is" has one exception — the request body of `POST /v1/chat/completions` is rewritten according to two thinking toggles:

```
Request body ──▶ Merge chat_template_kwargs (enable_thinking / preserve_thinking)
        └─▶ When "Preserve historical think" is off: strip reasoning_content and think text from historical assistant messages
```

Why change in the request body rather than llama-server launch parameters (`--chat-template-kwargs`):

1. Launch parameters do not exist at all on old builds; once sent it becomes "model cannot start"; one extra field in the request body,
   old build's JSON parser directly ignores it, **at worst only the toggle is ineffective**, and the main line of model loading is never affected;
2. These two toggles have "every request" semantics; changes take effect immediately, no need to restart the model just to flip a toggle;
3. "Not preserving historical think" needs to touch `messages` itself, which launch parameters cannot express.

Other paths (`/v1/models`, `/health`, `/v1/embeddings`…) do not even read the request body; they remain zero-change streaming passthrough;
unrecognized request bodies (non-JSON, non-object) are all passed through as-is — a degradable configuration problem should not become a request failure.

**State machine**

```
disabled ──enable──▶ idle ──first conversation──▶ starting ──ready──▶ ready
                     ▲                                    │
                     └──── 5 minutes idle / model switch / manual ────┘
                                                          │
                                           Crash and not over limit ─┘──▶ starting (backoff retry)
```

## 7. Stability design

These are concrete commitments to "startup and unload logic being stable and reliable", most with test coverage:

- **Load single-flight**: concurrent requests share the same load; no duplicate spawning of multiple processes competing for VRAM.
- **Residual process reclamation**: force-killing dsh leaves orphan llama-servers holding VRAM. On next startup, the plugin first reclaims it according to `state/llama-server.pid`, then starts a new one — reversing the order means OOM.
- **Crash self-healing**: on unexpected exit, restart with 1s/2s backoff; exceeding `maxRestarts` enters `failed` and stops retrying (no infinite restarts maxing out CPU).
- **Port adaptation**: `llamaPort=0` auto-picks a free port each time; if the external port is occupied, look forward for 20; if still no good, let the kernel assign and prompt.
- **Process tree reclamation**: after timeout, force-kill the whole process tree (`taskkill /T /F` / `SIGKILL`), avoiding backend workers becoming orphans.
- **Do not interrupt generation**: set `requestTimeout`/`timeout` to 0; client interruption (clicking stop) synchronously cuts off upstream inference, no longer burning VRAM in vain.
- **Unload protection**: never unload when there are active requests; unload requests before loading completes first wait for loading to end.
- **Parameter self-correction**: combinations like `-ub > -b` that would cause llama.cpp to fail to start directly are converged at the parameter assembly stage.
- **Keys do not land in logs**: `--api-key` in command line logs is always displayed as `***`; marked as a sensitive field on the settings page.

## 8. Troubleshooting

| Symptom | Cause and handling |
| --- | --- |
| Plugin management shows "installed, not active" | Two causes: ① `package.json` does not declare `dsh.bundle`, or the declaration shape is wrong (correct shape in Section 2); ② the package is not registered in the profile's `dsh.profile.bundles`. Run `npm run verify` to locate directly, then `dsh plugin --profile <name> add <this plugin path>` once to complete |
| Plugin is active, but **no "Local model" in settings** | ① dsh not restarted after changing manifest (bundle composition is fixed at startup); ② `dsh.client` missing or `exports["./client"]` not pointing to the artifact — run `npm run verify` and `npm run test:client` to self-check |
| Settings panel opens blank / keeps "Reading configuration…" | Look at the browser console for the return of `/api/local-model/state`. If 403, you are accessing via LAN address — the panel deliberately only serves local (see Section 4) |
| Changed settings in the panel have no effect | After saving, the model is unloaded once, and the next conversation loads with new parameters; confirm you clicked "Save" rather than just changed the input box (the bottom shows the number of unsaved items) |
| Behavior unchanged after changing code / rebuilding | Bundle composition is fixed at dsh **startup**: installing, uninstalling, updating all require restarting the profile. Client bundles too; after changes `npm run build:client` then restart |
| Load failure, log shows `error while handling argument "--xxx": unknown value for --xxx: '--yyy'` | **Parameter shape mismatch**: the parser ate the next parameter as the previous one's value. The plugin has built-in detection and auto-retry (see Section 4); if you still encounter it on an old version, upgrade to 0.2.1+; diagnose with `npm run verify:llama` |
| Load failure after switching llama branch, log shows `unknown flag: --alias` (or `-ub` / `--repeat-last-n` / `-t` / `--no-mmap` / `--api-key`) | This branch is **not** llama.cpp's `llama-server` (e.g. a standalone OpenAI-compatible server like `llama-kvmem-server.exe`); its option table is only a subset of llama.cpp, and it directly exits 1 for unknown options. The plugin probes by `--help` before startup and skips options it does not recognize (0.5.3+); the log shows "Skipped: --alias, -ub, …"; upgrade to that version. If you are on an old version, a temporary measure is to switch back to the official llama.cpp build in "Settings → Local model → llama-server path" |
| Load failure, log shows `invalid --seed: seed out of range [0, 4294967295]` | This branch validates `--seed` as uint32, and the plugin's default value is `-1` (= random). Since 0.5.3+ **negative numbers never send this parameter** (equivalent to "random": llama.cpp's default was `-1` to begin with), so it will no longer appear; on old versions, fill "random seed" with 0 or any positive number to bypass |
| **Every** conversation fails, returns `400 {"error":"prompt + max_tokens exceeds n_ctx"}` | **This is a mismatch between dsh-side route declaration and launch parameters**, not a broken model. That standalone kvmem server judges `prompt + max_tokens > n_ctx` as a hard error (upstream llama.cpp only warns then converges on its own), and the error contains **neither prompt length nor n_ctx**. The most common cause is that the **hand-written** route in `settings.yaml` fills `contextWindow` / `maxTokens` larger than the actual `-c` (measured: declared `maxTokens: 128000`, actual `-c 32768`, so `128000 > 32768` always holds, every message must fail). Three steps to resolve: ① Look at **Settings → Local model → Context length** (or the plugin log line "Launched: … `-c` N") to get the real `n_ctx`; ② Change that model's `contextWindow` to this value, `maxTokens` to about 1/4 of it (e.g. 32768 / 8192); ③ **0.6.0+ has built-in fallback**: `guardContextOverflow` (on by default) preventively clamps certainly-failing oversized limits, and retries with halving step by step after server rejection; the log shows "Clamped output limit from X to Y and retried" |
| Model "stops mid-sentence" / every reply is especially short (clearly not at context limit) | Look at **Settings → Local model → KVMem block cache → Decode reserve (`--kvmem-gen-reserve`)**. It is the **single generation limit** in kvmem (including thinking), and this build's default is only **256** — without setting it, each reply can write at most 256 tokens, and **no error of any kind**. Set it to not less than "maximum output tokens per run" (e.g. 8192～16384). There is a dedicated reminder in the load log; seeing "Decode reserve… currently 256" means this problem |
| Want to tune KVMem's block retrieval (budget / block size / retrieval algorithm / NVMe overflow…) | 0.6.0+ added an entire group of "**KVMem block cache (kvmem branch exclusive)**" to the settings page, 18 items total, corresponding to the `--kvmem-*` family; plus a "Multi-Token Prediction (MTP) details" group (`--spec-kv-dtype` / `--spec-draft-n-max` / `--spec-draft-p-min`). **All defaults in the whole group are "do not send"** (numeric items filled with `-1`, strings left empty); not touching them equals using the build's own default behavior. These are kvmem branch exclusive parameters; on official llama.cpp builds they are skipped as a whole and explained in the log |
| Want to know "will my llama.cpp accept the parameters sent by the plugin" | Run `npm run verify:llama`. It reads your real configuration, assembles parameters, really starts llama-server once (model swapped for a non-existent sentinel path, so no VRAM occupied), and gives pass/fail with the full command line |
| Request returns 503 "No local model selected yet" | Go to **Settings → Local model** and select a model; the model must be placed under `modelsDir` |
| 503 "llama-server executable not found" | The error message lists the three locations searched; use `scripts/fetch-llama.mjs` or manually fill `llamaServerPath` |
| 503 "Selected model no longer in model directory" | Model was moved/deleted; select again |
| Stuck on "Loading model…" forever | Look at llama-server's output in the plugin log (`logLevel=debug`); probably insufficient VRAM or `-ngl` too large |
| Load failure, log shows `n_gpu_layers already set by user to N, abort` + `cudaMalloc failed: out of memory` | **OOM + adaptation pinned**: change "Settings → Local model → GPU layers policy" to "Auto" (this is the default since 0.2.2+). `--fit` only adjusts parameters "not explicitly set by the user"; once `-ngl` is pinned to a specific number, adaptation is skipped, and when the model does not fit it goes from "place fewer layers" to "direct OOM". At the same time reduce context length and switch to lower-bit quantization |
| Model cannot see tools, does not call tools | Check `jinja=true`; then try `chatTemplate=chatml` or specify a template file |
| Toggled "Enable thinking / Preserve historical think" but output unchanged | Two preconditions: ① llama.cpp must support `chat_template_kwargs` in the request body (builds after 2025-06; old builds ignore the field, manifesting as toggle ineffective); ② the model template must recognize `enable_thinking` / `preserve_thinking` (only templates with thinking chains like Qwen3 / Qwen3.6 recognize them). `logLevel=debug` prints the reason for "failed to rewrite request body" |
| Load failure, log shows `failed to load mmproj` / `clip_model_load` | Vision projection file and model do not match, or path is wrong. Go to **Settings → Local model → Vision projection file**, restore the option to "Auto" and let the plugin re-associate by same directory; pure text models can keep "Auto" |
| Dialog box reports `400 "Failed to load image or audio file"`, while **some images in the same batch are recognized normally** | What is failing is **WebP** images. dsh produces both WebP and JPEG during transcoding (in practice both are present under `request-images/`), and llama.cpp's built-in image decoder **does not recognize WebP** — it needs external `ffprobe` + `ffmpeg` for transcoding, and these two are found from **PATH** (this build dropped `--ffmpeg-path`). How to judge: look at the plugin log (`logLevel=debug`) for `probe: failed to launch ffprobe` / `failed to decode webp buffer`. Fix: `winget install Gyan.FFmpeg`. **Since 0.7.0, the plugin automatically finds ffmpeg and prepends its directory to the PATH of the llama-server subprocess** (takes effect immediately after installation, no system PATH change needed, no dsh restart needed for this); if it cannot be found while you have vision projection on, there is a warning in the load log explaining "which format will fail, why only that one, how to fix" |
| After enabling MTP, the vision projection setting turned gray / status card says "Vision projection was pushed out by MTP" | **Since 0.7.0 this does not happen by default**: MTP and vision projection can now coexist (`mtpWithVision` on by default; kvmem branch measured to support simultaneous loading of vision head and MTP draft context). Seeing it gray only means you turned **off** this toggle — then the old mutual exclusion behavior is restored (upstream llama.cpp needs that). To use MTP and images simultaneously, turn it on; your chosen `mmprojFile` is not cleared (see Section 4 "Multi-Token Prediction (MTP)") |
| Enabled MTP but generation speed did not change at all | The two preconditions are not met simultaneously: ① the model must be a **GGUF with an MTP head** (filename often contains `MTP` characters); enabling the toggle on an ordinary GGUF has **zero effect and no error**; ② the llama.cpp build must support MTP (PR #22673 after 2026-05). First look at the model filename, then the build date. Also draft depth can use the default value; tuning it too large is actually slower |
| Load failure, log shows `unknown argument: --spec-type` / `--spec-type: invalid value` | This llama.cpp build does not support MTP (before 2026-05), or the build only recognizes other values. Upgrade llama.cpp; the plugin probes by `--help` before startup and prints a "does not recognize this option" warning; seeing the warning means this is the cause |
| Load failure, log simultaneously shows MTP and mmproj-related words | Means the command line sent both `--spec-type` and `--mmproj`. **Since 0.7.0 this is the default behavior** (the kvmem branch's `llama-kvmem-server` supports coexistence; measured that simultaneous loading of both has no problem); if you switched back to **official llama.cpp**, it will fail to load because of this — turn off "MTP and vision coexistence" (`mtpWithVision`) to restore mutual exclusion. Also check **Settings → Local model → Extra parameters** for hand-written versions of these two parameters (they would duplicate what the plugin sends) |
| After upgrading to 0.4.0, generation style changed (more conservative / more prone to repetition / candidates more monotonous) | **This is expected**: the 8 new sampling parameters are explicitly sent on every load, overriding llama.cpp's own defaults — `temp` 0.8→0.75, `top-k` 40→20, `min-p` 0.05→0, `repeat-penalty` 1.1→1.0. To revert to the original, go to **Settings → Local model → Sampling and KV cache** and fill these values with llama.cpp's defaults (see the comparison table in Section 4) |
| Toggling any tier of "reasoning level" in the dialog box has no response | First look at "Reasoning tier" in the status card of **Settings → Local model** and "Reasoning tiers supported by the model template" in the log: if the tier table cannot be parsed, the plugin only controls thinking on/off via the toggle and does not touch tiers. If it was parsed and still doesn't work, the model template did not define the tier you chose — try a different tier |
| Conversation directly reports 500, error contains `Unexpected reasoning effort xxx` | The model template does not recognize this tier value. Since `0.4.2`, the plugin reads the template and remaps by the tiers it supports; normally it will no longer appear; if it still appears, send out the log line "Reasoning tiers supported by the model template" |
| Selected Off but the model is still thinking | Three possibilities: ① using `0.4.1` or earlier (presses Off back to `true`, or sends `false` as-is to the template causing 500); ② the model template does not recognize `enable_thinking` (since 0.4.2, selecting Off sends `{"enable_thinking": false}`; if the template ignores it, it still thinks); ③ the dsh-side tier was not passed at all. The latter can force-cut thinking with "reasoning token budget = 0" |
| After upgrade, model "disappears" in dsh or route registration failure is reported | If the new `compat` / `reasoningEfforts` declarations are not accepted by this dsh version, registration fails — the plugin does not affect the local endpoint because of this (degrades as before to printing pasteable YAML); just send out the log line `llm.<method>() registration failed` |
| Cannot find "Route name / Model alias / Model ID / Declared context / Auto-register route" in the settings page | **0.4.0 deleted the entire "dsh integration" settings group as requested**; they became constants in `src/configResolve.ts` (route name `local-llama`, id `local`, rest always true/false). Function unchanged, just not configurable. Among them "Declared context" now directly follows `ctxSize`; see Section 4 "Where did the dsh integration settings go" |
| Log says "This llama-server does not recognize the following options; skipped: `--kv-stream-stage-mib`…" | This is **expected behavior**, not a fault: this build does not expose that item, so the plugin does not send it (especially for branches that directly exit on unknown options). The list in the log may contain both kinds simultaneously: ① only present in new builds (`--kv-unified` / `--kv-stream-stage-mib` / `--image-*-tokens` / `--reasoning-budget`); ② this branch simply does not have (`--alias`, `-ub`, `--repeat-last-n`, etc.). To use an item, upgrade to a build that supports it; loading itself is unaffected |
| Load failure, log shows `block KV streaming requires exactly one sequence (-np 1)` | KV streaming staging requires single sequence, and the sequence count llama-server received is not 1. The plugin already auto-appends `-np 1` when staging is enabled, so this appearing **usually means "extra parameters" has `-np` / `--parallel` overriding it** — delete it, or set "KV host memory staging" to 0. The plugin has this diagnostic built in and gives the conclusion directly without you reading English logs |
| `local_model` tool's `start` / `stop` always returns "unavailable" | **Always so since 0.4.0**: control toggle `allowModelControl` deleted, fixed to false. To restore controllability, change `ALLOW_MODEL_CONTROL` in `src/configResolve.ts` to `true` and rebuild |
| After setting `kvStreamStageMib`, startup got slower / more prone to OOM instead | This value is the **upper limit** of "staging to host memory"; the value depends on model, context, graphics card, and other VRAM occupancy; there is no universal optimum. Setting it too large may make host memory tight. Start from a conservative value, gradually increase and observe startup and peak VRAM; fill 0 to not send this parameter at all |
| Crashes mid-long-conversation | `contextWindow` larger than `ctxSize`; align the two and leave margin |
| Reply stutters then disconnects | `streamIdleTimeoutMs` in settings page or route is too short (local inference slow); refer to Section 5 and set to 600000 |
| VRAM not released | Look at the status of the `local_model` tool or `/local-model status`; confirm `idleUnloadMinutes` is not 0 |
| Changed settings have no effect | Port/directory-type changes require restarting dsh; model/parameter-type changes take effect with new values after idle unload or `/local-model reload` |
| Cannot find the "Parameter presets" block, or clicking a preset has no response | It is at the very top of the **Settings → Local model** page (the pinned one). When there are no presets at all, only the input box — enter a name and click "Save as preset". If it does not appear after upgrade, first check if the version number in the status card is `v0.5.2`, then run `npm run verify` |
| Clicking a preset prompts "Preset not found; may have been deleted" | Another tab/window deleted this preset group. Click "Refresh status" to re-fetch |
| Why no port / model directory / key in presets | **By design, not a miss**: these 9 items belong to "this machine", not "this set of parameters"; switching presets keeps them as-is (otherwise one parameter switch would change the port). Scope in Section 4 "Parameter presets" |
| After applying a preset, the model was unloaded and reloaded once | Expected behavior: it goes through the same path as "Save Settings" — parameters changed means unload, next conversation loads with new parameters |
| Elements on the settings page overlap / input box pressed by "Default" button | Fixed in `0.5.1` (panel usable width only 564px; old `maxWidth: 720` + bare `1fr` three columns wrap and overlap on narrow windows). If still present after upgrade, first confirm the version number in the status card is `v0.5.2`; then run `node scripts/client-check.mjs`, and the two "layout" test suites directly point out which style constraint was broken |
| Preset bar's top edge cut off when scrolling / covers panel title | Same as above, fixed in `0.5.1`. The three related constraints (opaque background, horizontally covering 24px padding, `isolation: isolate`) see `cardPinned` in `client/src/styles.js` |
| **Whole settings block is semi-transparent, lower card text shows through and overlaps** | Fixed in `0.5.2`. Root cause was the plugin referencing `--color-*` variables that do not exist in the host; `var()` silently fell to the `transparent` fallback (see "Color variables" section for details). First confirm the version number is `v0.5.2`; then run `node scripts/client-check.mjs`, and the three "theme" test suites directly report which variable or container background is wrong |
| Dark theme main button black-on-black / input box bottom invisible | Same as above, fixed in `0.5.2` (`--color-text-primary` falls through to `#111`, `--color-background-secondary` falls through to `transparent`) |
| Preset cannot be created (says name duplicate / empty) | Name cannot be empty, cannot duplicate (case-insensitive), max 40 characters, max 100 groups. Change the name or delete the old one first |
| Panel prompts "Preset file failed to parse; treated as 'no presets'" | `state/presets.json` was externally corrupted. The plugin does not fail to start because of this, and model loading is unaffected; only that batch of presets cannot be read back; just delete the file to start over |

## 9. Development and testing

```bash
npm run build       # tsc → lib/, then bundle client bundle → client/client.js
npm run build:client # Only re-bundle browser half-side (use after changing client/src)
npm run verify      # Manifest self-check: bundle validity + client half-side compliance + in which profiles installed but not active
npm run verify:llama # Parameter acceptance: really start the local llama-server once, confirm it accepts the parameters sent by the plugin
npm test            # Runs all five suites below (180 items total: 118 unit + 13 e2e + 32 load + 17 client + 12 manifest checks)
npm run test:client # Browser bundle: really loads once with a fake loader, verifying format, slot registration, and preset bar contract
npm run test:load   # Host-like running apply(): directory skeleton, proxy port, settings panel data plane, parameter presets and security constraints
npm run test:unit   # Parameter assembly / capability detection / shard merging / path and configuration parsing / parameter preset read-write
npm run test:e2e    # Real process runs full load and idle unload lifecycle
```

**Parameter acceptance** (`verify-llama.mjs`) is the fastest entry for troubleshooting "cannot load": it assembles parameters with your real configuration,
really starts llama-server once (model swapped for a non-existent sentinel path, so no VRAM occupied),
thereby separating the two kinds of failures "parameters rejected" and "model/VRAM problem" at once:

```
Build capability: 417 options recognized, flash-attn shape is value
Parameters to be sent: … --flash-attn on --jinja
✓ All sent options are recognized by this build
✓ Parameters accepted (the failure point has reached the model-reading stage, meaning all parameter parsing passed)
```

**Client verification** (`client-check.mjs`) runs the artifact once with a fake `window.__ModuleLoader__` and a fake `react`:

```
✓ Artifact can be accepted by dsh's module loader              ✓ Factory id equals package name
✓ External dependencies all go through injected require (react not bundled) ✓ Exports apply / inject, no default export
✓ apply registered settings.section with id local-model ✓ Sidebar title word is "Local model"
✓ Everything registered is reversible (mounted / disposer)
✓ Presets: the 5 routes the client calls all exist on the host side (prevents the two sides' paths from quietly drifting)
✓ Presets: preset bar is before the status card (the "fixed at top" requirement is pinned by tests)
✓ Preset snapshot: draft priority / empty number fallback / string empty value preserved
```

**Load verification** (`load-check.mjs`) builds a fake profile in a temporary directory, pointing `@deepseek-ai/schemastery`
back to the **real local schemastery** (not a self-made stub), copies compiled artifacts in to load, pins down dsh's hard conventions and incidentally
also verifies the settings panel data plane and parameter presets:

```
✓ Export symbols complete / no default export / schema can produce defaults     ✓ apply() still runs when all host services are missing
✓ Directory skeleton and placement instructions created                              ✓ Proxy port listenable, status endpoint accessible
✓ Form groups ≥5, fields ≥30 and text from schema             ✓ Save persists and takes effect immediately; restore defaults clears user layer
✓ Presets: save / read / apply / rename / overwrite / delete full chain        ✓ Presets: environment fields blocked outside presets (port unaffected)
✓ Presets: duplicate names and empty values have readable errors, failures leave no half record            ✓ Presets: can still read back the same file after restart
✓ Rejects non-local origin (403, including preset interface)                      ✓ Write operations require JSON content-type (415)
✓ Only accepts GET/POST (405); invalid JSON has clear error           ✓ Port released on unload
```

**End-to-end tests** use `scripts/fixtures/fake-llama-server.mjs` to stand in for llama-server, but go through the **real
spawn / health probe / process tree kill flow**:

```
✓ No process launched after initialization (no VRAM occupied)        ✓ First conversation auto-launches → waits ready → forwards as-is
✓ 4 concurrent requests only spawn once (single-flight)      ✓ SSE streaming passes through block by block
✓ Process reclaimed and port released after idle           ✓ Can be launched again after unload (repeatable)
✓ Actionable errors for no model selected / missing llama-server ✓ Cleans up process and port on plugin unload
```

### Directory structure

```
package.json         dsh.bundle.patch → cordis.patch.yml; dsh.client → client/client.js
cordis.patch.yml     Bundle patch: insert the plugin line into the profile's plugin tree
src/                 Host side (Node)
├── index.ts          Plugin entry: name / inject / Config / apply (named exports only)
├── config.ts         Single source of truth for settings items (schemastery schema, 50 fields)
├── configResolve.ts  Configuration resolution: path placeholders, range convergence (no host dependencies, testable standalone)
├── configStore.ts    User layer configuration read-write + write whitelist/type gate
├── presets.ts        Parameter presets: scope definition + persistence (independent of schemastery, testable standalone)
├── paths.ts          $DSH_HOME and directory conventions, first-time initialization
├── schemaForm.ts     Serialize schema into settings panel form description (including groups)
├── webBridge.ts      Same-origin HTTP data plane (state / config / operations / presets), loopback + JSON constraints
├── registry.ts       Model scanning: GGUF shard merging, quantization/parameter count recognition, mmproj association and selection
├── requestRewrite.ts Request body rewriting: thinking toggles (chat_template_kwargs + historical think stripping)
├── lifecycle.ts      State machine: single-flight load, idle unload, crash self-healing, hot configuration change
├── proxy.ts          Resident entry: first request triggers load, SSE passthrough, status endpoint, rewrite request body by toggle
├── llmBridge.ts      dsh llm seam integration (probe + degradation)
├── tools.ts          local_model tool (status / list / start / stop)
└── commands.ts       /local-model commands (status / list / start / stop / reload / route)
client/src/          Browser half-side
├── index.jsx         Register settings.section top-level page + words
├── section.jsx       Panel: preset bar, status, model/vision projection dropdown (grayed out when MTP on), schema-rendered group form
├── presets.jsx       Pinned "Parameter presets" bar: save / apply / rename / overwrite / delete
├── presetSnapshot.js Pure logic of preset snapshot (can be unit-tested directly by node)
├── layoutCheck.js    Layout geometry + theme variable self-check rules (prevent element overlap / prevent host variable misuse, called by client-check)
├── api.js            Same-origin fetch
└── styles.js         Inline styles (no CSS modules, one less load failure surface)
scripts/
├── verify-bundle.mjs  Manifest self-check (bundle + client + profile mount status)
├── verify-llama.mjs  Parameter acceptance (run parameter parsing once with real llama-server)
├── build-client.mjs  esbuild bundling + wrap lazy-CJS factory shell
├── client-check.mjs  Fake loader load verification + preset contract, snapshot logic and layout geometry self-check
├── load-check.mjs    Host-like environment load verification
├── selftest.mjs      Pure logic unit self-check (including parameter preset read-write and fault tolerance)
├── e2e.mjs           Real process end-to-end
└── fetch-llama.mjs   Download llama.cpp runtime
```

## 10. Known limitations and version adaptation

dsh is currently in the developer preview period, interfaces are still changing, so **all host integration points have explicit degradation; better to do less than report errors**:

- This plugin's `inject` is empty: `llm` / `tools` / `commands` / `timer` all read via `ctx.get()`;
  when missing or interface mismatch, only the corresponding enhancement is skipped, and **the main line of model loading and idle unload is always available**.
- `llmBridge` probes `registerProvider / upsertProvider / registerRoute / addRoute / setRoute` in sequence;
  when none match, prints a directly pasteable `settings.yaml` fragment (Section 5), not failing.
- The `/local-model` command has both `execute` and `run` entry names, to adapt to different versions of the commands service.
- The output format of `src/commands.ts` and `/local-model status` may change with host adjustments — they are just convenience features;
  the real status is based on `GET http://127.0.0.1:18080/local-model/status`.
- `types/dsh-ambient.d.ts` is an environment declaration **for offline compilation** (only covers the interfaces this plugin uses).
  When developing inside the dsh repo, take the main repo's real types as authoritative; if duplicate declaration warnings appear, just remove it from
  `tsconfig.json`'s `include`.
- Not done: multiple models resident simultaneously (strictly one at a time, matching the "release resources" goal), end-to-end verification of image input passthrough,
  graceful shutdown of llama-server on Windows (llama.cpp has no state to flush; directly kill the process tree).

### The browser half-side is a replicated build, not an official preset

dsh officially clearly states that the `clientBundle` preset producing the `dsh.client` bundle is **not in a published package**;
plugins outside the repo must replicate it themselves. This project's replication is in `scripts/build-client.mjs`: esbuild bundles to CJS
(all `react` / `react/jsx-runtime` external, provided by the host), then manually wraps with
`window.__ModuleLoader__.load({ id, factory })` shell; the shape was compared byte by byte against the artifacts of three **already active**
local `dsh.client` packages, and `npm run test:client` runs it once with a fake loader to guard it.
If the settings page does not appear after upgrading dsh, first run these two scripts, then check whether the client package name in `dsh.client.inject` still exists.

The panel's data plane is **a self-built same-origin HTTP bridge**, not dsh's settings namespace (reason in Section 4),
so settings are written to the plugin's own `<DSH_HOME>/local-model/state/config.json`. This is a deliberate trade-off:
it does not depend on the version of host internal interfaces; the cost is that these settings do not appear in `settings.yaml`, and therefore cannot follow
dsh's credential/sync mechanism. The bridge only serves loopback origin — when accessing dsh via LAN, the panel is unavailable.

The UI text is now in English (section titles are registered for both zh and en).

### This package's manifest was confirmed by real-machine comparison

The shapes of `dsh.bundle` and `dsh.client` were not guessed from documentation; they were matched field by field against several **already active**
third-party plugins on this machine (`dshmarket`, `@linxin666/dsh-web-all`, `dsh-better-sidebar`):

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"], "platform": "web" }
}
```

Both `engines.dsh` and the peer range of `@deepseek-ai/dsh-tools` are **no longer declared**; only `engines.node` remains.

Historically, explicit pre-release branches were written here (`^0.1.0-rc.1 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.5-0`),
because of a node-semver rule: **comparators without a pre-release tag in the range do not match pre-release versions** —
so bare `"*"` actually fails to match the harness's `-rc.x` builds, and `|| ^X.Y.Z-0` branches must be added per minor.
But this path is a dead end: every time the harness releases a new minor pre-release (e.g. `0.2.0-rc.1`), a branch must be added;
a missed addition makes the marketplace judge "incompatible with current DSH" and pop up a crash warning, while the plugin itself actually works as usual —
this is pure declaration-side maintenance cost, not a real functional dependency.

Now changed to **no version gate**: deleted `engines.dsh`, `dsh-tools`' peer range reverts to `"*"`.
The plugin's coupling to the harness is actually weak, all going through runtime capability probing — `lib/tools.js` uses
`await import()` on `dsh-tools` and only warns and skips tool registration on failure; client dependencies go through `dsh.client.inject` resolved by the host;
nowhere is a harness version number hardcoded. Therefore the version upper limit is left for the host/marketplace to manage itself; the plugin no longer asserts on its behalf.
Official `@deepseek-ai/*` are still all written into `peerDependencies` (not `dependencies`), and all marked
`optional`.

The loader entry id in `cordis.patch.yml` has an author prefix (`dzqjoker-local-model`), not bare
`local-model`: cordis refuses to load plugin trees with duplicate entry ids, and the plugin marketplace, once it finds a newly installed plugin's id
colliding with a loaded one, directly unloads that plugin (otherwise the whole profile would fail to start on next startup).

`exports` only declares four entries: `.` / `./client` / `./cordis.patch.yml` / `./package.json`,
consistent with the style of the above packages.

The `repository` field must point back to this repo — the plugin marketplace uses it to associate the npm package with the list entry.
This package no longer has a `private` field: it is a plugin to be publicly installed.

## License

MIT
