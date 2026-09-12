给 **DeepSeek Harness（dsh）** 用的本地模型插件：在设置里管理本地 GGUF 模型，
**第一条对话自动拉起 llama.cpp 载入模型，连续 5 分钟无交互自动卸载并释放显存**。

模型和 llama 工具由用户自己下载，放进插件规定的目录即可 —— 插件不联网拉模型、不碰工作区文件、
除本机回环地址外不监听任何端口。

## 更新日志

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
llama-server 仅在首次请求到达时才会被启动。这一点有端到端测试作为保障（详见第9节）。

---

## 2. 安装

```bash
# 1) 装进 profile —— 这一步同时写入依赖 + 把它登记进 dsh.profile.bundles
dsh plugin --profile desktop add D:/note/dsh-plugin-local-model
#    或：dsh plugin --profile desktop add github:<you>/dsh-plugin-local-model

# 2) 重启 dsh —— bundle 组合在启动时固定，装/卸插件都必须重启（刷浏览器不生效）
```

装完打开 **设置 → 本地模型**，就能看到独立的配置组。

### 装完先自查一次

```bash
npm run verify
```

它会检查两件事：本包是不是一个**合法的 dsh bundle**，以及它在哪些 profile 里**装了却没生效**。
后者正是插件管理页显示「已安装，未生效」的成因，输出长这样：

```
A. bundle 清单
  ✓ dsh.bundle.patch = ./cordis.patch.yml
✓ 补丁的名称即为包名：dsh-plugin-local-model
B. 配置文件挂载状态
✗ 桌面 → 已安装为依赖，但不在 dsh.profile.bundles 里（这就是「已安装，未生效」）
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
- 视觉：同目录放 `mmproj-*.gguf` —— 只在能确定归属时自动关联（宁可漏配，不可错配）

放好后回 **设置 → 本地模型** 点「重新扫描」，在下拉框里选模型。

## 4. 设置页与设置项

### 面板在哪

重启 dsh 后，打开 **设置**，侧栏会出现一级条目 **「本地模型」**（排在「通用设置 / 模型」之后）。
面板里依次是：

- **运行状态**：状态徽标（待机 / 加载中 / 已就绪 / 已卸载 / 失败）、当前模型、进程 pid、入口地址、
  预计自动卸载时间、最近一次错误；配「重新扫描 / 立即加载 / 卸载 / 刷新状态」按钮。
- **模型下拉框**：列出模型目录里扫到的全部 GGUF，带量化、参数量、体积、是否分片完整、是否含视觉投影。
  分片不完整的会置灰并在文案里说明。
- **六个参数分组**：模型与目录 / 服务与端口 / 推理参数 / 加载与卸载 / 接入 dsh / 诊断与高级。
  每个字段都带中文说明，**文案与默认值直接来自 `src/config.ts` 的 schema**，字段被改过的会标「已覆盖」，
  旁边有「默认」按钮可单独恢复。
- **目录约定**：模型目录、运行时目录、用户配置文件三个绝对路径，照着放文件即可。
- **底部**：保存 / 放弃修改 / 恢复默认；未保存项数会实时标出。

面板是**数据驱动**的：字段列表、类型、默认值、说明全部由宿主把 schema 序列化后送过来
（`Config.toJSON()` → `src/schemaForm.ts`），因此往 `config.ts` 加一个字段，界面上会自动出现，
客户端一行都不用改。

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
| 模型与目录 | `enabled`、`selectedModel`、`modelsDir`、`runtimeDir`、`llamaServerPath`、`preload` |
| 服务与端口 | `host`（默认只听回环）、`port`（默认 18080）、`llamaPort`（默认 0 = 每次自动挑空闲端口） |
| 推理参数 | `ctxSize`、`gpuLayers`、`threads`、`batchSize`/`ubatchSize`、`flashAttention`、`jinja`、`chatTemplate`、`mmap`、`mlock` |
| 加载与卸载 | **`idleUnloadMinutes`（默认 5）**、`startupTimeoutMs`、`shutdownGraceMs`、`autoRestart`、`maxRestarts` |
| 接入 dsh | `routeName`、`modelAlias`（固定 `local`）、`routeModelId`、`contextWindow`、`maxTokens`、`registerRoute`、`exposeTool`、`allowModelControl` |
| 诊断与高级 | `apiKey`、`extraArgs`、`envOverrides`、`logLevel`（排查加载问题设 `debug`） |

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
          contextWindow: 32768
          maxTokens: 8192
```

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
npm test            # 下面五套全跑（共 86 项：单测 39 + e2e 10 + 加载 17 + 客户端 8 + 清单 12）
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
├── config.ts         设置项的唯一真源（schemastery schema，37 个字段）
├── configResolve.ts  配置解析：路径占位符、区间收敛（无宿主依赖，可单独测）
├── configStore.ts    用户层配置读写 + 写入白名单/类型闸门
├── paths.ts          $DSH_HOME 与目录约定、首次初始化
├── schemaForm.ts     把 schema 序列化成设置面板的表单描述（含分组）
├── webBridge.ts      同源 HTTP 数据面（状态 / 配置 / 操作），回环 + JSON 约束
├── registry.ts       模型扫描：GGUF 分片归并、量化/参数量识别、mmproj 关联
├── lifecycle.ts      状态机：单飞加载、空闲卸载、崩溃自愈、热改配置
├── proxy.ts          常驻入口：首请求触发加载、SSE 透传、状态端点
├── llmBridge.ts      接入 dsh llm 缝（探测 + 降级）
├── tools.ts          local_model 工具（status / list / start / stop）
└── commands.ts       /local-model 命令（status / list / start / stop / reload / route）
client/src/          浏览器半侧
├── index.jsx         注册 settings.section 一级页面 + 词条
├── section.jsx       面板：状态、模型下拉、按 schema 渲染的分组表单
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

`engines.dsh` 是可选的版本闸门 —— 这里刻意不写，避免版本区间写错反而把插件挡在门外。
`exports` 只声明了 `.` / `./client` / `./cordis.patch.yml` / `./package.json` 四个入口，
与上述包的风格保持一致。

`private: true` 是防止误发布，不影响 `dsh plugin add`（它走 pnpm 的 link / git 协议）。
要发布到 npm 时删掉这一行即可。

## License

MIT
