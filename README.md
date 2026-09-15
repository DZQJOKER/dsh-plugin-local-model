![dsh-cost-meter 预览图](https://raw.github.com/DZQJOKER/dsh-plugin-local-model/main/images/仓库截图.png)


# dsh-plugin-local-model

给 **DeepSeek Harness（dsh）** 用的本地模型插件：在设置里管理本地 GGUF 模型，
**第一条对话自动拉起 llama.cpp 载入模型，连续 5 分钟无交互自动卸载并释放显存**。

模型和 llama 工具由用户自己下载，放进插件规定的目录即可 —— 插件不联网拉模型、不碰工作区文件、
除本机回环地址外不监听任何端口。

## 更新日志

- **0.4.0** — ① **新增 13 项设置**：KV 缓存策略 2 项（`kvUnified`、`kvStreamStageMib`，其中流式暂存是特定 llama.cpp 分支的私有参数）、采样参数 8 项（`temp` / `topK` / `topP` / `minP` / `presencePenalty` / `repeatPenalty` / `repeatLastN` / `seed`）、多模态与推理预算 3 项（`imageMinTokens` / `imageMaxTokens` / `reasoningBudget`）。这些参数现在会在每次加载时**显式下发并覆盖 llama.cpp 自身的默认值**（`temp` 0.8→0.75、`top-k` 40→20、`min-p` 0.05→0、`repeat-penalty` 1.1→1.0），设置页里逐项注明了差异。② **删除「接入 dsh」整组设置**（`routeName` / `modelAlias` / `routeModelId` / `contextWindow` / `registerRoute` / `exposeTool` / `allowModelControl`）：这 7 项改为 `configResolve.ts` 里的常量，取值沿用原默认值，**行为与默认安装完全一致但从此不可配置**。③ `maxTokens`（单次最大输出 tokens）保留，从「接入 dsh」挪进「推理参数」。④ 顺带修掉一处会静默毁掉小数设置的 bug：`clamp()` 内部有四舍五入，`temp 0.75` 会被它变成 `1`；小数项改用新的 `clampFloat()`。
- **0.3.1** — 新增「多 Token 预测（MTP）」开关（`mtp`，**默认关闭**）。开启后加载时下发 `--spec-type draft-mtp`，用模型自带的预测头做投机解码，本地生成速度通常提升 1.2～2 倍。**开启 MTP 会自动禁用视觉投影文件（`--mmproj`）** —— 两者在 llama.cpp 里不能共存，强行一起下发会导致加载失败；这条互斥规则写在参数拼装层（`src/llama/args.ts`），只要 `mtp` 为真 `--mmproj` 就不可能漏下去，界面上对应的下拉框会立即置灰并在状态卡里说明原因。关掉 MTP 后用户选的 `mmprojFile` 不会被清空，只是暂时不生效。默认关闭，因此**升级后老部署的行为一字不变**。
- **0.3.0** — 两项推理侧能力：① 推理参数新增「启用思考」「保留历史 think」两个开关，按 `chat_template_kwargs`（`enable_thinking` / `preserve_thinking`）在**每次请求**的请求体上下发，关闭「保留历史 think」时还会顺手剥掉历史 assistant 消息里的 `reasoning_content` / think 文本，让多轮上下文中不再堆积思考内容；② 模型与目录新增「视觉投影文件」选择项，可直接挑选 mmproj（加载时作为 `--mmproj` 下发），**留空即保持原有的「同目录自动关联」行为**。这两项开关走请求体而不是 llama-server 启动参数：旧构建只会忽略它，绝不会影响模型加载，也不必为切一次开关重启模型。
- **0.2.3** — 发布准备：补 `repository` / `homepage` / `engines.dsh`；`peerDependencies` 从 `"*"` 改为显式的预发布分支（原来的 `*` 会静默匹配不到 harness 的 `-rc.x` 构建）；loader entry id 由裸 `local-model` 改为 `dzqjoker-local-model` 避免与其他插件撞车；去掉 `private` 与 `prepare`（产物随仓库发布，安装时不再需要构建）；补 `LICENSE`、`.gitignore`、`.gitattributes`；`PLUGIN_VERSION` 与 `package.json` 对齐。另修 `npm run verify`：它过去不读 DSH Desktop 的 `activeHome`，数据目录被搬走后会漏扫真正在用的 profile，报出「未安装本插件」的假结论。
- **0.2.2** — 修复 CUDA OOM：新增 `gpuLayersMode`（auto / all / custom）。默认 `auto` 会下发 `-ngl auto`，让 llama.cpp 的 `--fit` 按可用显存自适应卸载 —— 之前默认把 `-ngl` 钉成 `-1` 跳过了这层保护，模型放不下时从「少放几层」变成「直接 OOM」。同时把失败日志翻译成可读诊断（fit-blocked-by-pinned-layers / cuda-oom / 形状不匹配 / 模型缺失 等十几种模式）。
- **0.2.1** — 修复 `--flash-attn` 形状不匹配：老构建按裸 flag 发，参数解析器把下一个 token 当成它的值吃掉；新增能力探测与三态配置（auto / on / off），auto 永远不下发最安全。
- **0.2.0** — 修复 dsh.bundle 声明形状 + 设置侧栏面板；新增浏览器半侧 bundle + 同源数据桥。
- **0.1.0** — 初版：设置项 / 拉起 / 空闲卸载 / 路径约定 / 接入 dsh 路由。

---

## 1. 需求 → 实现对照

| 需求 | 落点 |
| --- | --- |
| ① 设置里新增独立「本地模型」配置项，可选模型、可填启动参数 | **设置侧栏一级页面**：`src/config.ts` 的 schemastery `Config`（唯一真源）+ `src/webBridge.ts`（数据面）+ `client/`（浏览器半侧面板）。字段说明见 [第 4 节](#4-设置页与设置项) |
| ② 用户自行下载 llama 工具与模型，存入插件规定目录 | `src/paths.ts` 定义目录约定并在首次运行时写入放置说明；`scripts/fetch-llama.mjs` 可选一键下载 |
| ③ 选定模型后首条对话自动拉起并载入 | `src/proxy.ts`（常驻轻量入口）+ `src/lifecycle.ts` 的 `ensureReady()` 单飞加载 |
| ④ 连续 5 分钟无交互自动卸载释放资源 | `idleUnloadMinutes`（默认 5）；判定规则抽成纯函数 `shouldUnload()`，`src/lifecycle.ts` |

「不占资源」是硬指标：**没有对话时磁盘上只有一个常驻 HTTP 代理进程（不加载模型、不占显存）**，
llama-server 只在第一个请求进来时才被 spawn。这一条有端到端测试兜底（见第 9 节）。

---

## 2. 安装

```bash
# 1) 装进 profile —— 这一步同时写入依赖 + 把它登记进 dsh.profile.bundles
dsh plugin --profile desktop add github:DZQJOKER/dsh-plugin-local-model
#    本地开发时改成本地路径：
#    dsh plugin --profile desktop add D:/path/to/dsh-plugin-local-model

# 2) 重启 dsh —— bundle 组合在启动时固定，装/卸插件都必须重启（刷浏览器不生效）
```

装完打开 **设置 → 本地模型**，就能看到独立的配置组。

### 从 GitHub 安装不需要在用户机器上构建

本仓库**已包含预构建产物** —— `lib/`（宿主半侧）与 `client/client.js`（浏览器半侧）。
包里刻意**没有 `prepare` 脚本**：pnpm 对 git 依赖默认拒绝执行构建脚本，会以
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（`needs to execute build scripts but is not in the
"allowBuilds" allowlist`）在物化之前就中止安装。产物入库 + 去掉 `prepare`，这条路才是通的。

代价是**改了 `src/` 或 `client/src/` 之后必须重新 `npm run build` 再提交**，
否则用户装到的是上一次的产物。改完用 `npm test` 跑一遍（它会先 `build` 再自查）。

### 装完先自查一次

```bash
npm run verify
```

它会检查两件事：本包是不是一个**合法的 dsh bundle**，以及它在哪些 profile 里**装了却没生效**。
后者正是插件管理页显示「已安装，未生效」的成因，输出长这样：

```
A. bundle 清单
  ✓ dsh.bundle.patch = ./cordis.patch.yml
  ✓ patch 的 name 是包名：dsh-plugin-local-model
B. profile 挂载状态
  ✗ desktop → 已安装为依赖，但不在 dsh.profile.bundles 里（这就是「已安装，未生效」）
```

### 为什么必须声明 `dsh.bundle`

dsh 的安装机制建立在两个 manifest 概念上，都写在 `package.json` 的 `dsh` 字段里：

| 概念 | 是什么 | 声明方式 |
| --- | --- | --- |
| **bundle** | 一个附带配置层的 npm 包，说明「这个包贡献什么」 | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| **client** | 浏览器半侧（设置界面、面板、卡片） | `"dsh": { "client": { "inject": [...], "platform": "web" } }` + `exports["./client"]` |
| **profile** | `$DSH_HOME/profiles/` 下的目录，说明「这套配置由哪些 bundle 按什么顺序组成」 | profile 自己的 `dsh.profile.bundles` |

**没有 `dsh.bundle` 的包照样能装上，但只会作为普通依赖存在，dsh 不会激活它贡献的任何层。**
这个设计是给「被别的插件包 import、而不是供用户直接启用」的库用的；对一个要直接启用的插件来说，
漏掉这个字段就等于白装。声明形状写错（比如写成字符串 `"bundle": "包名"`）和没写是同一个后果。

**宿主侧的 `Config` schema 只负责配置的读写，不会自己长出界面。** dsh 设置侧栏的每一项都是
一个客户端 UI 插件贡献的，所以要让「本地模型」出现在设置里，必须另外提供浏览器半侧
（`dsh.client` + lazy-CJS factory 形式的 bundle）。官方 `dsh-client-ui-settings-plugins` 的文档把这句
写得很直白：

> 卡片仍然需要一份浏览器 bundle：浏览器半侧必须是按客户端模块系统的 lazy-CJS factory 格式构建的
> `dsh.client` 包，而产出它的 `clientBundle` 预设位于 `packages/client/tsdown.client.ts`，
> **并非已发布的包，因此本仓库之外的插件得自行复刻该构建**。

本插件的复刻方式是 `scripts/build-client.mjs`（esbuild 打包 + 手工套上 `window.__ModuleLoader__.load`
外壳），并由 `scripts/client-check.mjs` 用假 loader 真跑一遍来保证格式没跑偏。

配置层的叠加顺序是：profile 里各 bundle 的 patch（按声明顺序）→ profile 自己的 `cordis.patch.yml`
→ `$DSH_HOME/cordis.patch.yml` → 命令行 `--patch`。**后一层覆盖前一层，且是整块替换 config 而不是深合并。**

## 3. 放模型和 llama 工具

首次运行插件会建好目录并放入说明文件：

```
$DSH_HOME/local-model/            # Windows 默认 C:\Users\<你>\.dsh\local-model
├── models/                       # ← 把 GGUF 放这里（可建子目录）
│   └── PUT_GGUF_MODELS_HERE.txt
├── runtime/                      # ← 把 llama.cpp 解压到这里（可放在一层子目录里）
│   └── PUT_LLAMA_RUNTIME_HERE.txt
└── state/                        # 插件自管：pid、日志，不用管
```

**llama 工具**：去 <https://github.com/ggml-org/llama.cpp/releases> 下载对应平台的包，解压到 `runtime/`
（NVIDIA 选 `win-cuda-x64`，无独显选 `win-cpu-x64`，macOS 选 `macos-arm64`）。
也可以让脚本代劳：

```bash
node scripts/fetch-llama.mjs                 # 自动判断平台与后端
node scripts/fetch-llama.mjs --variant=cuda  # 指定后端：cuda / vulkan / hip / cpu
node scripts/fetch-llama.mjs --dry-run       # 只预览要下载哪个包
```

**模型**：下载 `.gguf` 放进 `models/`。插件支持三种布局，全自动识别：

- 单文件：`Qwen3-8B-Q4_K_M.gguf`
- 分片：`xxx-00001-of-00003.gguf` ×3 —— 会自动归并成一个模型，**缺片会明确提示而不是加载半截模型**
- 视觉：同目录放 `mmproj-*.gguf` —— 只在能确定归属时自动关联（宁可漏配，不可错配）；
  目录里有多个模型/多个投影文件而自动关联不出来时，去 **设置 → 本地模型 → 视觉投影文件** 手动选一个即可。

放好后回 **设置 → 本地模型** 点「重新扫描」，在下拉框里选模型。

## 4. 设置页与设置项

### 面板在哪

重启 dsh 后，打开 **设置**，侧栏会出现一级条目 **「本地模型」**（排在「通用设置 / 模型」之后）。
面板里依次是：

- **运行状态**：状态徽标（待机 / 加载中 / 已就绪 / 已卸载 / 失败）、当前模型、进程 pid、入口地址、
  预计自动卸载时间、最近一次错误；配「重新扫描 / 立即加载 / 卸载 / 刷新状态」按钮。
- **模型下拉框**：列出模型目录里扫到的全部 GGUF，带量化、参数量、体积、是否分片完整、是否含视觉投影。
  分片不完整的会置灰并在文案里说明。
- **六个参数分组**：模型与目录 / 服务与端口 / 推理参数 / 采样与 KV 缓存 / 加载与卸载 / 诊断与高级。
  每个字段都带中文说明，**文案与默认值直接来自 `src/config.ts` 的 schema**，字段被改过的会标「已覆盖」，
  旁边有「默认」按钮可单独恢复。
- **目录约定**：模型目录、运行时目录、用户配置文件三个绝对路径，照着放文件即可。
- **底部**：保存 / 放弃修改 / 恢复默认；未保存项数会实时标出。

面板是**数据驱动**的：字段列表、类型、默认值、说明全部由宿主把 schema 序列化后送过来
（`Config.toJSON()` → `src/schemaForm.ts`），因此往 `config.ts` 加一个字段，界面上会自动出现。
两个例外是**需要下拉框**的字段（`selectedModel` 选模型、`mmprojFile` 选视觉投影文件）——
选项来自扫描结果、schema 表达不了，所以由客户端特判渲染，其余字段一律自动出现。

### 设置的三个层级

沿用 dsh 自己的三层语义，用户层落在插件目录里：

```
schema 默认值  →  组合层（cordis.patch.yml / 部署配置）  →  <DSH_HOME>/local-model/state/config.json
```

面板保存写入的是最上层那个文件；「恢复默认」清空它，于是回落到组合层 + schema 默认值。
浏览器发来的 JSON 只按 `src/configStore.ts` 里的类型表做强制转换，表里没有的键一律丢弃 ——
界面写不进一条会污染 llama-server 命令行的脏数据。

> 为什么不用 dsh 的 settings 命名空间：当前 dsh 版本的 settings apiproxy 只服务硬编码的命名空间白名单，
> 第三方插件的命名空间一律答复 `settings-not-exposed`，浏览器侧既读不到也写不进。
> 自建一条同源 HTTP 桥（`/api/local-model`，注册在宿主 webServer 上）是这一版宿主上唯一可靠的通道。

### 桥的安全姿态

本机工具、没有账号体系，所以靠三条硬约束而不是鉴权：

1. **只接受回环来源的请求** —— 配置变更与进程启停不该被局域网里的谁触发；
2. **写操作要求 `content-type: application/json`** —— 普通表单跨站提交做不到这一点，
   于是即便有恶意页面在浏览器里跑，也发不出能改配置的请求；
3. 请求体有大小上限。

因此：**通过局域网/远程 Web UI 访问 dsh 时，这个面板会被拒绝**（这是刻意的）。本地模型本来就是本机能力。

### 字段一览

类型、默认值与说明都写在设置面板里，这里只列关键分组：

| 分组 | 关键字段 |
| --- | --- |
| 模型与目录 | `enabled`、`selectedModel`、`mmprojFile`（视觉投影文件）、**`mtp`（多 Token 预测，开启后自动禁用视觉投影）**、**`imageMinTokens` / `imageMaxTokens`（每张图的 token 预算下限/上限）**、`modelsDir`、`runtimeDir`、`llamaServerPath`、`preload` |
| 服务与端口 | `host`（默认只听回环）、`port`（默认 18080）、`llamaPort`（默认 0 = 每次自动挑空闲端口） |
| 推理参数 | `ctxSize`、**`maxTokens`（单次最大输出 tokens）**、`gpuLayers`、`threads`、`batchSize`/`ubatchSize`、`flashAttention`、**`reasoningBudget`（推理 token 预算）**、`jinja`、`chatTemplate`、`enableThinking`、`preserveThinking`、`mmap`、`mlock` |
| **采样与 KV 缓存** | **`kvUnified`（统一 KV 缓存）**、**`kvStreamStageMib`（KV 主机内存暂存 MiB）**、**`temp`、`topK`、`topP`、`minP`、`presencePenalty`、`repeatPenalty`、`repeatLastN`、`seed`** |
| 加载与卸载 | `idleUnloadMinutes`（默认 5）、`startupTimeoutMs`、`shutdownGraceMs`、`autoRestart`、`maxRestarts` |
| 诊断与高级 | `apiKey`、`extraArgs`、`envOverrides`、`logLevel`（排查加载问题设 `debug`） |

> 原先还有一组「接入 dsh」（`routeName` / `modelAlias` / `routeModelId` / `contextWindow` /
> `registerRoute` / `exposeTool` / `allowModelControl`）。`0.4.0` 起这一组**已从 schema 删除**，
> 改为 `src/configResolve.ts` 里的常量（取值 = 原默认值），因此行为不变但不再可配置。
> 详见 [第 4 节「接入 dsh 那些设置去哪了」](#接入-dsh-那些设置去哪了)。

保存后模型会被卸载一次，下次对话按新参数重新加载 —— 用户刚改完设置，期望的就是这个行为。

### 插件会先探测你的 llama.cpp 再拼参数

同一个参数在不同版本的 llama.cpp 里形状会变。最典型的是 `--flash-attn`：

| 构建 | 形状 | 插件怎么发 |
| --- | --- | --- |
| 新（如 b10822） | `-fa, --flash-attn [on|off|auto]` 带值 | `--flash-attn on` / `--flash-attn off` |
| 老 | `-fa, --flash-attn` 裸开关 | `--flash-attn`（仅当设为 `on`） |

**如果不探测就直接按老形状发裸 flag，新构建的参数解析器会把下一个 token 当成它的值吃掉**，
报出来的却是 `unknown value for --flash-attn: '--mmproj'` —— 错误信息指向被吞掉的那个参数，
排查方向会完全跑偏。

所以插件在起进程前先跑一次 `llama-server --help`，问清楚两件事：**这个构建认识哪些选项**、
**`--flash-attn` 是哪种形状**（结果按可执行文件缓存，每次加载只付一次代价）。顺带得到两个好处：

- 下发的选项如果构建不认识，会在**启动前**就打一条可读的警告；
- 万一探测结果与实际不符（或探测失败导致下发形状不对），llama-server 报错后插件会**自动去掉这个参数重试一次**，
  并把「已改为不下发」写进日志 —— 不必让用户去猜。

`flashAttention` 因此是三态而不是开关：**`auto`（默认）永远不下发该参数**。因为 `auto` 在所有支持三态的构建里
都等于默认值，在只支持裸开关的老构建里又根本表达不出来 —— 不下发是唯一在两种构建上语义都正确的做法。
历史配置里的 `true/false` 会自动收敛成 `on/off`。

> 另外：较新的 llama.cpp 已把 `--mlock` / `--no-mmap` 标记为 DEPRECATED（建议改用 `--load-mode`），
> 但两者仍然可用，插件继续沿用；将来若被移除，上面的启动前警告会直接点名。

### 多 Token 预测（MTP）

`0.3.1` 新增，**默认关闭**。开启后加载时下发 `--spec-type draft-mtp`，让模型用它**自带的预测头**
一次猜测并校验多个 token（投机解码），本地生成速度通常能提升 1.2～2 倍，回复越长越明显。

**开启 MTP 会自动禁用视觉投影文件（`--mmproj`）** —— 这两者在 llama.cpp 里目前不能共存，强行一起下发
会导致加载直接失败。所以这条互斥规则写在**参数拼装层**（`src/llama/args.ts` 的 `buildLlamaServerArgs`）：
只要 `mtp` 为真，`--mmproj` 就绝不可能漏下去，无论界面上选了什么、也无论调用方传了什么。
界面上对应的下拉框会**立即置灰**（读的是未保存的草稿值，不必先保存），状态卡则说明「视觉投影已被 MTP 顶掉」。
关掉 MTP 后你选的 `mmprojFile` **不会被清空**，只是暂时不生效 —— 免得来回切开关时丢配置。

| 事实 | 说明 |
| --- | --- |
| 开关名 | `--spec-type draft-mtp`（不是 `-mtp` / `--spec mtp`，那两个是早期写法的残留，已被标准化掉） |
| 需要草稿模型吗 | 不需要。MTP 用的是模型自带的预测头，这是它比传统投机解码省事的地方 |
| llama.cpp 版本 | 需要 2026-05 之后的构建（PR #22673 合并了 MTP 支持） |
| 模型要求 | 必须是**带 MTP 头的 GGUF**（文件名常带 `MTP` 字样）。普通 GGUF 打开这个开关**零效果且不报错** |
| 与图像输入 | **互斥**。开了 MTP 就不能下发 `--mmproj` |
| 草稿深度 | `--spec-draft-n-max`（llama.cpp 默认 16，社区推荐 2~3，太大反而更慢）。插件**不下发**这个值，需要时用「附加参数」 |

> 最容易踩的坑是第 4 条：**普通 GGUF 打开开关不会有任何加速，而且不报错**。如果你开了 MTP 却感觉没变快，
> 先确认模型文件名里有没有 `MTP` 字样，再看 llama.cpp 的构建日期。

### 采样参数与 KV 缓存策略（0.4.0 新增）

这一组**每次加载都会显式下发**，因此会**覆盖 llama.cpp 自身的默认值**。差异也逐项写在设置页的说明里，
这里汇总成表：

| 参数 | 插件默认 | llama.cpp 默认 | 说明 |
| --- | --- | --- | --- |
| `--temp` | 0.75 | 0.80 | 温度：越高越随机 |
| `--top-k` | 20 | 40 | 只从概率最高的 K 个 token 里采样；0 = 不过滤 |
| `--top-p` | 0.95 | 0.95 | 核采样阈值（一致） |
| `--min-p` | 0.0 | 0.05 | 0 = 关掉最小概率过滤 |
| `--presence-penalty` | 0.0 | 0.0 | 存在惩罚（一致） |
| `--repeat-penalty` | 1.0 | 1.10 | 1.0 = 不做重复惩罚 |
| `--repeat-last-n` | 64 | 64 | 检查最近多少个 token（一致） |
| `--seed` | -1 | -1 | -1 = 每次启动都用随机种子（一致） |

**所以升级到 0.4.0 之后生成风格会变**：更确定（temp 更低）、候选更窄（top-k 减半）、
不再惩罚重复、关掉了 min-p 过滤。想退回原样，把上表右列的值填回设置页即可。

KV 两项用于长上下文：

| 参数 | 插件默认 | 作用 |
| --- | --- | --- |
| `--kv-unified` | 关闭 | 用一整块统一缓冲管理 KV 缓存，减少「按层分配」造成的显存碎片，长上下文更容易装下。代价是这块缓冲在加载时就按**完整上下文**预留 —— 即使很少跑满也占着显存 |
| `--kv-stream-stage-mib` | 1024 | 把这么多 MiB 的 KV 缓存暂存到主机内存，以减轻显存压力。0 = 不下发。**这是「自适应 KV 流式」那个 llama.cpp 分支的私有参数**，上游构建不认识它 |

图像两项（`--image-min-tokens` / `--image-max-tokens`）只对**动态分辨率**的视觉模型生效，且要先挂上视觉投影文件；
`max` 小于 `min` 时插件会就地把它抬到 `min`（否则 llama.cpp 拒绝启动）。
`--reasoning-budget` 限制思考链的最大长度，0 = 关掉思考、-1 = 不限。

### 新参数不会把你的老构建搞崩

`--kv-unified`、`--kv-stream-stage-mib`、`--image-*-tokens`、`--reasoning-budget` 都比较新，
其中流式暂存更是特定分支独有。而**不认识的选项会让 llama-server 直接启动失败** ——
那等于「加了个开关，插件反而起不来了」。

所以插件在起进程前先跑一次 `llama-server --help`（本节开头介绍过这套探测），并且**只下发构建承认的选项**：

- 构建不认识 → 跳过该选项，日志里写明被跳过的是哪些，**不影响加载**；
- 探测失败（`--help` 拿不到）→ 同样全部跳过，与 `--flash-attn` 的取舍一致：宁可退回构建默认值，也不赌它认；
- 采样参数（`--temp` 那一组）**不受门控** —— 它们在几乎所有版本里都存在，门控只会让一次探测失败
  就把你的采样设置全丢掉。

> 想知道你的 llama.cpp 认哪些选项、插件实际会下发什么？跑 `npm run verify:llama`：
> 它用你的实际配置拼出完整命令行（模型换成不存在的哨兵路径，不占显存），真的起一次 llama-server 并报告结论。

### 「接入 dsh」那些设置去哪了

`0.4.0` 按用户要求删掉了整组「接入 dsh」设置。它们**改成了常量**（`src/configResolve.ts`），
取值就是原来的默认值：

| 原设置 | 现在的常量 | 影响 |
| --- | --- | --- |
| `routeName` | `local-llama` | 路由名固定，dsh 侧 `settings.yaml` 不用改 |
| `modelAlias` / `routeModelId` | `local` | `--alias` 与模型选择器里的 id 固定 |
| `contextWindow` | **跟随 `ctxSize`** | 见下 |
| `registerRoute` | 恒为真 | 始终尝试注册路由；宿主没接口时照旧降级为打印可粘贴的 YAML |
| `exposeTool` | 恒为真 | `local_model` 工具照旧注册 |
| `allowModelControl` | 恒为假 | **能力取舍**：`local_model` 的 `start` / `stop` 从此恒被拒绝，无法再打开 |

`contextWindow` 是唯一一个**取值发生变化**的：它过去独立可配（默认 32768），而 `ctxSize` 默认 8192 ——
两者不一致正是插件一直警告的「声明比实际大 → 长会话中途崩」。现在声明的窗口直接取 `ctxSize`，
两者同源、不可能再错位，启动后的对账警告也因此更准。

> 副作用提醒：`local_model` 工具的 `start` / `stop` 动作现在恒被拒绝（这本是原默认行为，
> 但过去能用 `allowModelControl` 打开）。要恢复可控，得改 `src/configResolve.ts` 里的常量。

## 5. 接入模型路由

插件启动时会尝试把本地端点注册进 dsh 的 llm 缝。**注册成功**（日志里能看到
`已通过 llm.<method>() 注册本地模型路由`）就可以直接在模型选择器里选 `local`。

**如果宿主没暴露注册接口**，插件不会报错、也不会影响模型加载，只在日志里打印一段
可以直接粘贴的配置；把 `examples/settings-route.yaml` 的内容并进 `$DSH_HOME/settings.yaml`
即可（已存在 `providers` 时是**并入**，不要整体覆盖）：

```yaml
llm-pi-ai:
  providers:
    local-llama:
      displayName: 本地模型（llama.cpp）
      api: openai-completions
      baseURL: http://127.0.0.1:18080/v1
      streamIdleTimeoutMs: 600000      # 本地/CPU 推理慢，这个必须放宽
      models:
        - id: local
          contextWindow: 8192          # 跟随「设置 → 上下文长度」，改 ctxSize 时这里也要跟着改
          maxTokens: 8192
```

> `0.4.0` 起 `local-llama` 与 `local` 这两个名字、以及 `contextWindow = ctxSize` 的规则都是**固定的**
> （原 `routeName` / `modelAlias` / `routeModelId` / `contextWindow` 设置已删除）。
> 手写配置时照抄上面的 id 即可；`contextWindow` 是唯一需要你自己跟上 `ctxSize` 的值。
> 插件自己注册的那条路由会用 `ctxSize` 自动填这个字段，所以只有手写配置时才需要操心它。

会话里也可以用 `/local-model route` 随时打印这段配置。

## 6. 运行机制

**为什么要有一个常驻代理？** 最直接的做法是让 dsh 连 llama-server 的端口。但模型卸载后那个端口
就没人监听了，**下一条对话必然连接失败** —— 而「按需加载」又要求端点平时不在。这是个死结。

解法是让插件常驻一个极轻量的 HTTP 入口（不加载模型、不占显存），由它消化掉「模型还没加载」这件事：

```
第一条对话 ──▶ 插件代理 :18080 ──ensureReady()──▶ 拉起 llama-server（内部随机空闲端口）
                    │                                   │
                    │◀────── 等 /health 就绪 ────────────┘
                    └──原样转发（含 SSE 流式）──▶ llama-server
                                        │
              连续 5 分钟无交互 ◀────────┘ 卸载 → 端口释放 → 回到待机
```

对 dsh 来说端点始终在线；对用户来说显存只在真正用的时候才被占。

**代理会改一种请求体：对话补全**

「原样转发」有一个例外 —— `POST /v1/chat/completions` 的请求体会按两个思考开关改写：

```
请求体 ──▶ 合并 chat_template_kwargs（enable_thinking / preserve_thinking）
        └─▶ 关闭「保留历史 think」时：剥掉历史 assistant 消息的 reasoning_content 与 think 文本
```

为什么改在请求体而不是 llama-server 启动参数（`--chat-template-kwargs`）：

1. 启动参数在旧构建上根本不存在，一旦下发就是「模型起不来」；请求体里多一个字段，
   旧构建的 JSON 解析器直接忽略，**最坏也只是开关无效**，模型加载这条主线绝不受影响；
2. 这两个开关是「每次请求」的语义，改完即生效，不必为切一次开关重启模型；
3. 「不保留历史 think」要动的是 `messages` 本身，启动参数表达不了。

其余路径（`/v1/models`、`/health`、`/v1/embeddings`…）连请求体都不读，仍是零改动的流式直通；
认不出的请求体（非 JSON、非对象）一律原样放行 —— 一个可以降级的设置问题，不该变成一次请求失败。

**状态机**

```
disabled ──启用──▶ idle ──首条对话──▶ starting ──就绪──▶ ready
                    ▲                                    │
                    └──── 空闲 5 分钟 / 切换模型 / 手动 ────┘
                                                         │
                                          崩溃且未超上限 ─┘──▶ starting（退避重试）
```

## 7. 稳定性设计

这些都是「启动与卸载逻辑稳定可靠」的具体承诺，且多数有测试覆盖：

- **加载单飞**：并发请求共享同一次加载，不会重复 spawn 出多个进程抢显存。
- **残留进程回收**：dsh 被强杀会留下握着显存的孤儿 llama-server。插件下次启动时按 `state/llama-server.pid`
  先回收它，再启动新的 —— 顺序反了就是 OOM。
- **崩溃自愈**：非预期退出时按 1s/2s 退避重启，超过 `maxRestarts` 进入 `failed` 并停止重试（不无限重启打满 CPU）。
- **端口自适应**：`llamaPort=0` 每次自动挑空闲端口；对外端口被占用会向后找 20 个，仍不行则交给内核分配并提示。
- **进程树回收**：超时后强制结束整棵进程树（`taskkill /T /F` / `SIGKILL`），避免后端 worker 变成孤儿。
- **不打断生成**：`requestTimeout`/`timeout` 置 0；客户端中断（点停止）会同步掐掉上游推理，不继续空烧显存。
- **卸载保护**：有活跃请求时绝不卸载；加载未完成时的卸载请求会先等加载结束。
- **参数自纠**：`-ub > -b` 这类会让 llama.cpp 直接启动失败的组合，在拼参数阶段就收敛掉。
- **密钥不落日志**：命令行日志里 `--api-key` 一律显示为 `***`；设置页标记为敏感字段。

## 8. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 插件管理里显示「已安装，未生效」 | 两种成因：① `package.json` 没声明 `dsh.bundle`，或声明形状不对（正确形状见第 2 节）；② 该包没被登记进 profile 的 `dsh.profile.bundles`。跑 `npm run verify` 直接定位，再 `dsh plugin --profile <名字> add <本插件路径>` 一次补全 |
| 插件已生效，但**设置里没有「本地模型」** | ① 改完 manifest 后没重启 dsh（bundle 组合在启动时固定）；② `dsh.client` 缺失或 `exports["./client"]` 没指向产物 —— 跑 `npm run verify` 与 `npm run test:client` 自查 |
| 设置面板打开是空白 / 一直「正在读取配置…」 | 浏览器控制台看 `/api/local-model/state` 的返回。若是 403，说明你是通过局域网地址访问的 —— 面板刻意只服务本机（见第 4 节） |
| 面板里改了设置不生效 | 保存后模型会卸载一次，下次对话按新参数加载；确认点的是「保存」而不是只改了输入框（底部会显示未保存项数） |
| 改完代码 / 重新 build 后行为没变 | bundle 组合在 dsh **启动时**固定：装、卸、更新都必须重启 profile。客户端 bundle 也一样，改完要 `npm run build:client` 再重启 |
| 加载失败，日志里出现 `error while handling argument "--xxx": unknown value for --xxx: '--yyy'` | **参数形状不匹配**：解析器把下一个参数当成前一个的值吃掉了。插件已内置探测与自动重试（见第 4 节），若你仍在旧版本上遇到，升级到 0.2.1+ 即可；诊断用 `npm run verify:llama` |
| 想知道「我的 llama.cpp 会不会接受插件下发的参数」 | 跑 `npm run verify:llama`。它会读你的实际配置、拼出参数、真的起一次 llama-server（把模型换成不存在的哨兵路径，因此不会占显存），并给出通过/失败与完整命令行 |
| 请求返回 503「还没有选择本地模型」 | 去 **设置 → 本地模型** 选模型；模型要放在 `modelsDir` 下 |
| 503「没有找到 llama-server 可执行文件」 | 错误信息里会列出查找过的三个位置；用 `scripts/fetch-llama.mjs` 或手填 `llamaServerPath` |
| 503「选中的模型已不在模型目录里」 | 模型被移动/删除，重新选一下 |
| 一直卡在「正在加载模型…」 | 看插件日志里 llama-server 的输出（`logLevel=debug`）；多半是显存不足或 `-ngl` 太大 |
| 加载失败，日志里出现 `n_gpu_layers already set by user to N, abort` + `cudaMalloc failed: out of memory` | **OOM + 自适应被钉住**：把「设置 → 本地模型 → GPU 层数策略」改成「自动」（这是 0.2.2+ 的默认）。`--fit` 只会调整「用户没显式设置」的参数；一旦把 `-ngl` 钉成具体数字，自适应就被跳过，模型放不下时从「少放几层」变成「直接 OOM」。同时把上下文长度调小、换更低比特量化 |
| 模型看不到工具、不调用工具 | 检查 `jinja=true`；再试 `chatTemplate=chatml` 或指定模板文件 |
| 切了「启用思考 / 保留历史 think」但输出没变化 | 两条前提：① llama.cpp 要支持请求体里的 `chat_template_kwargs`（2025-06 之后的构建，旧构建会忽略该字段，表现为开关无效）；② 模型模板要认 `enable_thinking` / `preserve_thinking`（带思维链的模板如 Qwen3 / Qwen3.6 才认）。`logLevel=debug` 会把「未能改写请求体」的原因打出来 |
| 加载失败，日志里出现 `failed to load mmproj` / `clip_model_load` | 视觉投影文件与模型不配套，或路径不对。去 **设置 → 本地模型 → 视觉投影文件**，把选项恢复成「自动」让插件重新按同目录关联；纯文本模型保持「自动」即可 |
| 开了 MTP 之后，视觉投影设置变成了灰色 / 状态卡说「视觉投影已被 MTP 顶掉」 | 这是**设计行为**，不是故障：MTP 与图像输入在 llama.cpp 里不能共存。要图像输入就关掉 MTP；要 MTP 就保持视觉投影空着。你选的 `mmprojFile` 没被清空，关掉 MTP 即恢复生效（见第 4 节「多 Token 预测（MTP）」） |
| 开了 MTP，但生成速度没有任何变化 | 两条前提没同时满足：① 模型必须是**带 MTP 头的 GGUF**（文件名常带 `MTP` 字样），普通 GGUF 打开开关**零效果且不报错**；② llama.cpp 构建要支持 MTP（2026-05 之后的 PR #22673）。先看模型文件名，再看构建日期。另外草稿深度用默认值即可，调得过大反而更慢 |
| 加载失败，日志里出现 `unknown argument: --spec-type` / `--spec-type: invalid value` | 这个 llama.cpp 构建不支持 MTP（早于 2026-05），或该构建只认别的取值。升级 llama.cpp；插件在启动前会通过 `--help` 探测并打一条「不认识这个选项」的警告，看到警告就说明是这个原因 |
| 加载失败，同时出现 MTP 与 mmproj 相关字样 | 说明命令行里同时下发了 `--spec-type` 和 `--mmproj` —— 0.3.1 的拼装层不会产生这种组合，所以要么是你在「附加参数」里手写了其中一个、要么是旧版本。检查 **设置 → 本地模型 → 附加参数**，删掉手写的 `--mmproj` 或 `--spec-type` |
| 升级到 0.4.0 后生成风格变了（更保守 / 更容易重复 / 候选更单调） | **这是预期内的**：新增的 8 个采样参数每次加载都会显式下发，并覆盖 llama.cpp 自身默认值 —— `temp` 0.8→0.75、`top-k` 40→20、`min-p` 0.05→0、`repeat-penalty` 1.1→1.0。想退回原样，去 **设置 → 本地模型 → 采样与 KV 缓存** 把这些值填成 llama.cpp 的默认值（见第 4 节的对照表） |
| 设置页里找不到「路由名 / 模型别名 / 模型 ID / 声明上下文 / 自动注册路由」了 | **0.4.0 按需求删掉了整组「接入 dsh」设置**，它们变成了 `src/configResolve.ts` 里的常量（路由名 `local-llama`、id `local`，其余恒为真/假）。功能不变，只是不可配置。其中「声明上下文」现在直接跟随 `ctxSize`，见第 4 节「接入 dsh 那些设置去哪了」 |
| 日志说「这个 llama-server 不认识以下选项，已跳过：`--kv-stream-stage-mib`…」 | 这是**预期行为**，不是故障：`--kv-unified` / `--kv-stream-stage-mib` / `--image-*-tokens` / `--reasoning-budget` 只在构建确实支持时才下发（`--kv-stream-stage-mib` 是特定分支的私有参数）。要么升级到支持它的构建，要么把这些设置留在 0（不下发），加载不受影响 |
| `local_model` 工具的 `start` / `stop` 一直返回「不可用」 | **0.4.0 之后恒如此**：控制开关 `allowModelControl` 已删除、固定为假。要恢复可控，需把 `src/configResolve.ts` 里的 `ALLOW_MODEL_CONTROL` 改成 `true` 并重新构建 |
| 设了 `kvStreamStageMib` 之后启动变慢 / 反而更容易 OOM | 这个值是「暂存到主机内存」的**上限**，取值取决于模型、上下文、显卡与其它显存占用，没有通用最优解。设得过大可能让主机内存吃紧。从保守值起步，逐步加大并观察启动情况与峰值显存；填 0 即完全不下发该参数 |
| 长会话中途崩 | `contextWindow` 比 `ctxSize` 大；把两者对齐并留余量 |
| 回复一卡一卡然后断开 | 设置页或路由里的 `streamIdleTimeoutMs` 太短（本地推理慢），参考第 5 节调到 600000 |
| 显存没释放 | 看 `local_model` 工具或 `/local-model status` 的状态；确认 `idleUnloadMinutes` 不是 0 |
| 改完设置不生效 | 端口/目录类改动需重启 dsh；模型/参数类改动被空闲卸载后或 `/local-model reload` 后会按新值生效 |

## 9. 开发与测试

```bash
npm run build       # tsc → lib/，再打包客户端 bundle → client/client.js
npm run build:client # 只重打浏览器半侧（改 client/src 后用它）
npm run verify      # 清单自检：bundle 合法性 + 客户端半侧合规 + 在哪些 profile 装了却没生效
npm run verify:llama # 参数验收：拿本机的 llama-server 真起一次，确认它接受插件下发的参数
npm test            # 下面五套全跑（共 127 项：单测 85 + e2e 12 + 加载 22 + 客户端 8 + 清单 12 项检查）
npm run test:client # 浏览器 bundle：用假 loader 真加载一遍，校验格式与插槽注册规格
npm run test:load   # 类宿主跑 apply()：目录骨架、代理端口、设置面板数据面与安全约束
npm run test:unit   # 参数拼装 / 能力探测 / 分片归并 / 路径与配置解析
npm run test:e2e    # 真进程跑完整加载与空闲卸载生命周期
```

**参数验收**（`verify-llama.mjs`）是排查「加载不起来」最快的入口：它按你的实际配置拼参数、
真的把 llama-server 起一次（模型换成一个不存在的哨兵路径，因此不会占显存），
从而把「参数被拒绝」和「模型/显存问题」这两类故障一次分开：

```
构建能力：识别到 417 个选项，flash-attn 形状为 value
将要下发的参数：… --flash-attn on --jinja
✓ 下发的选项这个构建全都认识
✓ 参数被接受（失败点已经走到读模型这一步，说明参数解析全部通过）
```

**客户端校验**（`client-check.mjs`）用假的 `window.__ModuleLoader__` 与假的 `react` 把产物跑一遍：

```
✓ 产物能被 dsh 的模块加载器接收              ✓ 工厂 id 等于包名
✓ 外部依赖都走注入的 require（react 没被打进包） ✓ 导出 apply / inject，且没有 default 导出
✓ apply 注册了 id 为 local-model 的 settings.section ✓ 侧栏标题取词为「本地模型」
✓ 注册的一切都可逆（mounted / disposer）
```

**加载验证**（`load-check.mjs`）在临时目录里搭一个假 profile，让 `@deepseek-ai/schemastery`
指回**本机真实的 schemastery**（不是自造的桩），把编译产物拷进去加载，钉死 dsh 的硬约定并顺带
把设置面板的数据面也验一遍：

```
✓ 导出符号齐全 / 没有默认导出 / schema 能产出默认值     ✓ 宿主服务全缺失时 apply() 仍能跑起来
✓ 目录骨架与放置说明被创建                              ✓ 代理端口可监听、状态端点可访问
✓ 表单分组 ≥5 组、字段 ≥30 且文案来自 schema             ✓ 保存落盘并即时生效；恢复默认清空用户层
✓ 拒绝非本机来源（403）                                 ✓ 写操作要求 JSON content-type（415）
✓ 只接受 GET/POST（405）；非法 JSON 有明确报错           ✓ 卸载时端口被释放
```

**端到端测试**用 `scripts/fixtures/fake-llama-server.mjs` 顶替 llama-server，但走的是**真实的
spawn / 健康探测 / 进程树 kill 流程**：

```
✓ 初始化后不拉起进程（不占显存）        ✓ 首条对话自动拉起 → 等就绪 → 原样转发
✓ 4 个并发请求只 spawn 1 次（单飞）      ✓ SSE 流式逐块透传
✓ 空闲后进程被回收、端口被释放           ✓ 卸载后能再次拉起（可反复）
✓ 未选模型 / 缺 llama-server 的报错可操作 ✓ 卸载插件时清理进程与端口
```

### 目录结构

```
package.json         dsh.bundle.patch → cordis.patch.yml；dsh.client → client/client.js
cordis.patch.yml     bundle patch：把插件行 insert 进 profile 的插件树
src/                 宿主侧（Node）
├── index.ts          插件入口：name / inject / Config / apply（只用具名导出）
├── config.ts         设置项的唯一真源（schemastery schema，50 个字段）
├── configResolve.ts  配置解析：路径占位符、区间收敛（无宿主依赖，可单独测）
├── configStore.ts    用户层配置读写 + 写入白名单/类型闸门
├── paths.ts          $DSH_HOME 与目录约定、首次初始化
├── schemaForm.ts     把 schema 序列化成设置面板的表单描述（含分组）
├── webBridge.ts      同源 HTTP 数据面（状态 / 配置 / 操作），回环 + JSON 约束
├── registry.ts       模型扫描：GGUF 分片归并、量化/参数量识别、mmproj 关联与选择
├── requestRewrite.ts 请求体改写：思考开关（chat_template_kwargs + 历史 think 剥离）
├── lifecycle.ts      状态机：单飞加载、空闲卸载、崩溃自愈、热改配置
├── proxy.ts          常驻入口：首请求触发加载、SSE 透传、状态端点、按开关改写请求体
├── llmBridge.ts      接入 dsh llm 缝（探测 + 降级）
├── tools.ts          local_model 工具（status / list / start / stop）
└── commands.ts       /local-model 命令（status / list / start / stop / reload / route）
client/src/          浏览器半侧
├── index.jsx         注册 settings.section 一级页面 + 词条
├── section.jsx       面板：状态、模型/视觉投影下拉（MTP 开启时置灰）、按 schema 渲染的分组表单
├── api.js            同源 fetch
└── styles.js         内联样式（不引 CSS modules，少一个加载失败面）
scripts/
├── verify-bundle.mjs 清单自检（bundle + client + profile 挂载状态）
├── verify-llama.mjs  参数验收（拿真 llama-server 跑一次参数解析）
├── build-client.mjs  esbuild 打包 + 套 lazy-CJS factory 外壳
├── client-check.mjs  假 loader 加载校验
├── load-check.mjs    类宿主环境加载验证
├── selftest.mjs      纯逻辑单元自检
├── e2e.mjs           真进程端到端
└── fetch-llama.mjs   下载 llama.cpp 运行时
```

## 10. 已知限制与版本适配

dsh 目前处于开发者预览期，接口仍在变动，因此**所有宿主集成点都做了显式降级，宁可少做也不报错**：

- 本插件 `inject` 为空：`llm` / `tools` / `commands` / `timer` 全部通过 `ctx.get()` 读取，
  缺失或接口对不上时只跳过对应增强，**模型加载与空闲卸载这条主线始终可用**。
- `llmBridge` 会依次探测 `registerProvider / upsertProvider / registerRoute / addRoute / setRoute`，
  全都不匹配时打印可直接粘贴的 `settings.yaml` 片段（第 5 节），而不是失败。
- `/local-model` 命令同时挂了 `execute` 和 `run` 两种入口名，以适配不同版本的 commands 服务。
- `src/commands.ts` 与 `/local-model status` 的输出格式可能随宿主调整而调整 —— 它们只是便利功能，
  真实状态以 `GET http://127.0.0.1:18080/local-model/status` 为准。
- `types/dsh-ambient.d.ts` 是**离线编译用**的环境声明（只覆盖本插件用到的接口）。
  在 dsh 仓库内开发时以主仓库的真实类型为准；若出现重复声明告警，把它从 `tsconfig.json`
  的 `include` 里去掉即可。
- 未做：多模型同时常驻（严格一次一个，符合"释放资源"的目标）、图像输入透传的端到端验证、
  Windows 上 llama-server 的优雅退出（llama.cpp 无状态可刷，直接结束进程树）。

### 浏览器半侧是复刻的构建，不是官方预设

dsh 官方明确说明产出 `dsh.client` bundle 的 `clientBundle` 预设**不在已发布的包里**，
仓库之外的插件必须自己复刻。本项目的复刻落在 `scripts/build-client.mjs`：esbuild 打成 CJS
（`react` / `react/jsx-runtime` 全部 external，由宿主提供），再手工套上
`window.__ModuleLoader__.load({ id, factory })` 外壳；形状是拿本机三个**已经在生效**的
`dsh.client` 包的产物逐字节对照出来的，并由 `npm run test:client` 用假 loader 真跑一遍守住。
升级 dsh 后如果设置页不出现，先跑这两个脚本，再检查 `dsh.client.inject` 里的客户端包名是否仍然存在。

面板的数据面是**自建的同源 HTTP 桥**而不是 dsh 的 settings 命名空间（原因见第 4 节），
因此设置写在插件自己的 `<DSH_HOME>/local-model/state/config.json` 里。这是刻意的取舍：
它不依赖宿主内部接口的版本，代价是这些设置不出现在 `settings.yaml` 中，也就不能跟着
dsh 的凭据/同步机制走。桥只服务回环来源 —— 通过局域网访问 dsh 时面板不可用。

界面文案目前是中文硬编码（只额外注册了中英两份分区标题词条）。

### 本包的 manifest 是按实机对照确认的

`dsh.bundle` 与 `dsh.client` 的形状不是照文档猜的，是拿本机几个**已经在生效**的第三方插件
逐个字段对出来的（`dshmarket`、`@linxin666/dsh-web-all`、`dsh-better-sidebar`）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"], "platform": "web" }
}
```

`engines.dsh` 是给市场/网站读的版本闸门（市场会把 `engines.dsh` 与 `@deepseek-ai/*` 的
peer 范围一起收进兼容性卡片）。写它有个坑：**不带预发布分支的范围会静默匹配不到 harness
的 `-rc.x` 构建** —— node-semver 只在范围里某个比较符与该版本的 `major.minor.patch`
元组完全一致、且自身带预发布标签时才放行预发布版本。所以这里用显式的 `||` 分支：

```json
"engines": { "dsh": "^0.1.0-rc.1 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.5-0" }
```

harness 出一个新的 minor 预发布（例如 `0.1.6-rc.1`）时需要补一个分支，这是这类声明
固有的维护成本。`peerDependencies` 同一处理：官方 `@deepseek-ai/*` 一律写进
`peerDependencies`（而不是 `dependencies`），并全部标 `optional`。原来写的 `"*"` 看着最宽，
实际受同一条 semver 规则影响**匹配不到任何 `-rc.x`**。

`cordis.patch.yml` 里的 loader entry id 带作者前缀（`dzqjoker-local-model`），不用裸的
`local-model`：cordis 拒绝加载含重复 entry id 的插件树，而插件市场一旦发现新装插件的 id
与已加载的相撞，会直接把该插件卸载（否则下次启动整个 profile 都起不来）。

`exports` 只声明了 `.` / `./client` / `./cordis.patch.yml` / `./package.json` 四个入口，
与上述包的风格保持一致。

`repository` 字段必须指回本仓库 —— 插件市场用它把 npm 包与列表条目关联起来。
本包不再有 `private` 字段：它是要被公开安装的插件。

## License

MIT
