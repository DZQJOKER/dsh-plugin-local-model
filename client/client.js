// 由 scripts/build-client.mjs 生成，请勿手改；改 client/src 后重新运行 npm run build:client。
window.__ModuleLoader__.load({
	id: "dsh-plugin-local-model",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		"use strict";
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name in all)
		    __defProp(target, name, { get: all[name], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
		
		// client/src/index.jsx
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = __toCommonJS(index_exports);
		
		// client/src/section.jsx
		var import_react2 = require("react");
		
		// client/src/api.js
		var BASE = "/api/local-model";
		async function request(path, init) {
		  const res = await fetch(BASE + path, init);
		  const text = await res.text();
		  let data = null;
		  try {
		    data = text ? JSON.parse(text) : null;
		  } catch {
		    data = null;
		  }
		  if (!res.ok || data && data.ok === false) {
		    const message = data && data.error || `Request failed (HTTP ${res.status})`;
		    throw new Error(message);
		  }
		  return data;
		}
		var JSON_POST = (body) => ({
		  method: "POST",
		  headers: { "content-type": "application/json" },
		  body: JSON.stringify(body ?? {})
		});
		var fetchState = () => request("/state");
		var saveConfig = (values, unset) => request("/config", JSON_POST({ values, unset }));
		var resetConfig = () => request("/reset", JSON_POST({}));
		var runAction = (action) => request("/action", JSON_POST({ action }));
		var savePreset = (name, values) => request("/presets/save", JSON_POST({ name, values }));
		var applyPreset = (id) => request("/presets/apply", JSON_POST({ id }));
		var overwritePreset = (id, values) => request("/presets/overwrite", JSON_POST({ id, values }));
		var renamePreset = (id, name) => request("/presets/rename", JSON_POST({ id, name }));
		var deletePreset = (id) => request("/presets/delete", JSON_POST({ id }));
		
		// client/src/presetSnapshot.js
		function fieldKindMap(groups) {
		  const map = {};
		  for (const group of groups ?? []) {
		    for (const field of group.fields ?? []) map[field.key] = field.kind;
		  }
		  return map;
		}
		function buildPresetSnapshot({ keys, kinds, draft, config }) {
		  const out = {};
		  for (const key of keys ?? []) {
		    const edited = Object.prototype.hasOwnProperty.call(draft ?? {}, key);
		    const value = edited ? draft[key] : config?.[key];
		    const blankNumber = kinds?.[key] === "number" && typeof value === "string" && value.trim() === "";
		    out[key] = blankNumber ? config?.[key] : value;
		  }
		  return out;
		}
		
		// client/src/presets.jsx
		var import_react = require("react");
		
		// client/src/styles.js
		var c = (name, fallback) => `var(${name}, ${fallback})`;
		var SURFACE = c("--dsw-alias-bg-layer-2", "#fff");
		var SURFACE_RAISED = c("--dsw-alias-bg-layer-1", "#fff");
		var LABEL = c("--dsw-alias-label-primary", "#0f1115");
		var LABEL_2 = c("--dsw-alias-label-secondary", "#61666b");
		var BORDER_1 = c("--dsw-alias-border-l1", "rgba(0,0,0,0.04)");
		var BORDER_2 = c("--dsw-alias-border-l2", "#0000001a");
		var BORDER_3 = c("--dsw-alias-border-l3", "#0000001f");
		var BORDER_4 = c("--dsw-alias-border-l4", "#00000029");
		var HOVER = c("--dsw-alias-interactive-bg-hover", "rgba(38,49,72,0.06)");
		var DANGER = c("--dsw-alias-state-error-primary", "#ec1313");
		var SUCCESS = c("--dsw-alias-state-success-primary", "#22c55e");
		var WARN = c("--dsw-alias-state-warn-primary", "#f59e0b");
		var S = {
		  /**
		   * 内容区**不写死最大宽度**。
		   *
		   * 宿主设置面板实测：`.panel` 宽 800px（`max-width: calc(100vw - 48px)`），左导航 188px，
		   * `.options` 左右各 24px 内边距 —— 真正能用的宽度只有 `800 − 188 − 48 = 564px`。
		   * 原先这里写 720（比可用宽度还宽 156px），于是每张卡片都横向溢出 24px、
		   * 字段行被压到换行（见 `field` 的注释）。
		   * 宽度交给面板自己决定，这里只保证不撑破它。
		   *
		   * `paddingBottom` 64 是为了让最后一个卡片滚到底时不被保存条压住 ——
		   * 保存条是 sticky 的、会一直在视口底部。
		   */
		  wrap: { padding: "4px 2px 64px", maxWidth: "100%", boxSizing: "border-box", minWidth: 0 },
		  h2: { fontSize: 15, fontWeight: 500, margin: "0 0 4px" },
		  lede: { fontSize: 12.5, opacity: 0.72, margin: "0 0 16px", lineHeight: 1.6 },
		  /**
		   * 普通卡片。
		   *
		   * ★ `background` 必须是**不透明**的：写 `transparent` 时，卡片内的说明文字会和
		   *   滚动过程中从下面经过的另一张卡片叠在一起（上一版的真实故障）。
		   */
		  card: {
		    border: `1px solid ${BORDER_1}`,
		    borderRadius: 12,
		    padding: "14px 16px",
		    marginBottom: 14,
		    background: SURFACE,
		    boxSizing: "border-box",
		    minWidth: 0
		  },
		  /**
		   * 置顶卡：参数预设那一块。
		   *
		   * 用 sticky 把自己钉在滚动容器（宿主面板的 `.options`，`overflow-y:auto`）顶部。
		   * 有四个必须一起处理的细节，否则它会和面板本身「撞车」：
		   *
		   *   1. sticky 的包含块是 `.options` 的**内边距盒**，`top:0` 相对的是它 ——
		   *      而面板上圆角（border-radius: 32px）恰好压在这个位置。滚起来之后
		   *      卡片上边缘会被圆角切掉，所以这里留出 `paddingTop` 当缓冲。
		   *   2. `.options` 的 `padding: 0 24px 24px` 上边距是 0，那部分属于它自己的 padding、
		   *      不被 sticky 元素认领，卡片滚动时会被裁切。
		   *   3. 背景必须**不透明且与面板同色**（`--dsw-alias-bg-layer-2`）。写透明、
		   *      或写一个和面板不同的白，下层「运行状态」卡片就会透出来 —— 这就是本 bug。
		   *      横向用负 margin 把 `.options` 的 24px 内边距**盖满**，
		   *      否则卡片左右两侧各留 24px 缝，下面滚过去的内容会从缝里露出来。
		   *   4. `isolation: isolate` 新建层叠上下文，`zIndex` 只在本组件内比较，
		   *      不会再去和宿主面板的标题栏抢层级。
		   */
		  cardPinned: {
		    position: "sticky",
		    top: 0,
		    zIndex: 3,
		    marginTop: 0,
		    marginLeft: -24,
		    marginRight: -24,
		    paddingLeft: 24,
		    paddingRight: 24,
		    paddingTop: 14,
		    background: SURFACE,
		    isolation: "isolate",
		    /* 和面板同色，上边不需要描边；只在下方留一条分隔线表示「这是浮在上面的」。 */
		    borderWidth: "0 0 1px 0",
		    borderRadius: 0
		  },
		  chipRow: { display: "flex", flexWrap: "wrap", gap: 8, margin: "0 0 12px", minWidth: 0 },
		  chip: {
		    display: "inline-flex",
		    alignItems: "stretch",
		    borderRadius: 9,
		    border: `1px solid ${BORDER_4}`,
		    overflow: "hidden",
		    maxWidth: "100%"
		  },
		  /** 当前生效的那一个：加粗边框 + 主色描边，一眼看出「现在跑的是它」。 */
		  chipActive: {
		    borderColor: LABEL,
		    boxShadow: `inset 0 0 0 1px ${LABEL}`
		  },
		  chipLabel: {
		    display: "inline-flex",
		    alignItems: "center",
		    gap: 6,
		    fontSize: 12.5,
		    lineHeight: "26px",
		    padding: "0 10px",
		    border: "none",
		    background: "transparent",
		    color: "inherit",
		    cursor: "pointer",
		    /*
		     * 预设名是用户自己填的，可以很长（上限 40 字）。不设上限时单个 chip 会宽到
		     * 把「✎ / ×」两个按钮挤出卡片外，和相邻 chip 叠在一起。这里封顶并省略，
		     * 完整名字仍可从 title 提示里看到。
		     */
		    maxWidth: 240,
		    minWidth: 0,
		    overflow: "hidden",
		    textOverflow: "ellipsis",
		    whiteSpace: "nowrap"
		  },
		  chipMeta: { fontSize: 10.5, opacity: 0.6, flexShrink: 0 },
		  chipIcon: {
		    fontSize: 11.5,
		    lineHeight: "26px",
		    padding: "0 7px",
		    border: "none",
		    borderLeft: `1px solid ${BORDER_3}`,
		    background: "transparent",
		    color: "inherit",
		    opacity: 0.7,
		    cursor: "pointer",
		    flex: "0 0 auto"
		  },
		  presetRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 12, minWidth: 0 },
		  statusRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
		  badge: {
		    display: "inline-flex",
		    alignItems: "center",
		    gap: 6,
		    borderRadius: 999,
		    padding: "2px 10px",
		    fontSize: 12,
		    lineHeight: "18px",
		    border: "1px solid transparent"
		  },
		  dot: { width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto" },
		  metaGrid: {
		    display: "grid",
		    /*
		     * 下限必须是 0 而不是 220：`minmax(220px, 1fr)` 会让格子**拒绝压缩到 220px 以下**，
		     * 窄设置面板（可用宽度 < 220 + 18 时）整块网格横向溢出卡片，回环地址、模型路径
		     * 这些长串会和右侧内容叠在一起。用 `minmax(0, 220px)` 让格子可以被压窄，
		     * 长串靠 mono 的 break-all 折行。
		     */
		    gridTemplateColumns: "repeat(auto-fit, minmax(0, 220px))",
		    gap: "6px 18px",
		    marginTop: 12,
		    fontSize: 12,
		    minWidth: 0
		  },
		  metaLabel: { opacity: 0.62 },
		  mono: { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5, wordBreak: "break-all" },
		  actions: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 },
		  button: {
		    fontSize: 12.5,
		    lineHeight: "26px",
		    padding: "0 12px",
		    borderRadius: 8,
		    border: `1px solid ${BORDER_4}`,
		    background: "transparent",
		    color: LABEL,
		    cursor: "pointer"
		  },
		  buttonPrimary: {
		    fontSize: 12.5,
		    lineHeight: "26px",
		    padding: "0 14px",
		    borderRadius: 8,
		    border: "1px solid transparent",
		    background: c("--dsw-alias-button-primary-fill", "#0f1115"),
		    color: c("--dsw-alias-button-floating-fill", "#fff"),
		    cursor: "pointer"
		  },
		  buttonDisabled: { opacity: 0.5, cursor: "default" },
		  groupTitle: { fontSize: 13.5, fontWeight: 500, margin: "0 0 2px", display: "flex", alignItems: "center", gap: 8 },
		  groupHint: { fontSize: 12, opacity: 0.62, margin: "0 0 12px", lineHeight: 1.55 },
		  /**
		   * 一行设置项：`[标签] [控件] [默认]`，说明文字挂在第二、三列下面。
		   *
		   * ★ 三列一律用 `minmax(0, …)`，不能写 `minmax(140px, 190px) 1fr auto`：
		   *   grid 自动最小尺寸的默认值是 `auto`，即「不小于内容最小宽度」——
		   *   `1fr` 那一列于是**拒绝被压到输入框的 min-content 以下**。
		   *   改成 0 之后格子才能真正收缩（前提是控件本身也 `minWidth: 0`，见 input/select）。
		   *   这是「输入框与『默认』按钮叠在一起」的直接原因：可用宽度不足以容纳
		   *   `140(标签下限) + 12 + 输入框min-content + 12 + 44(按钮)` 时，grid 把第二列挤到
		   *   下一行，按钮回到右侧，两行内容在视觉上就压住了。
		   *   最小需求现在降到 `140 + 10 + 0 + 10 + 44 ≈ 204px`，任何常见分辨率都富余。
		   *
		   * ★ 标签列上限 168（原 190）是量出来的：最长的标签「GPU 层数（自定义时生效）」
		   *   不换行约 200px，会超过上限、把整行撑宽。配合下面的 `overflowWrap` 让它折行。
		   */
		  field: {
		    display: "grid",
		    gridTemplateColumns: "minmax(0, 168px) minmax(0, 1fr) auto",
		    gap: "6px 10px",
		    alignItems: "start",
		    padding: "7px 0",
		    borderTop: `1px solid ${BORDER_1}`,
		    minWidth: 0
		  },
		  /**
		   * 标签：与输入框**底对齐**（`flex-end`）。
		   * 用 center 时，多行标签会让按钮跟着它一起被撑高、和输入框错位 ——
		   * 看起来就是「按钮和输入框没对齐／叠在一起」。
		   */
		  label: {
		    fontSize: 12.5,
		    paddingTop: 5,
		    display: "flex",
		    alignItems: "flex-end",
		    gap: 6,
		    flexWrap: "wrap",
		    minWidth: 0,
		    overflowWrap: "anywhere",
		    lineHeight: 1.4
		  },
		  /** 说明横跨控件与按钮两列；同样要能压缩，否则长参数说明会把卡片顶宽。 */
		  desc: { fontSize: 11.5, opacity: 0.62, lineHeight: 1.5, marginTop: 4, gridColumn: "2 / 4", minWidth: 0, overflowWrap: "anywhere" },
		  /**
		   * 输入框 / 下拉框。
		   *
		   * ★ `background` 用 `--dsw-alias-bg-layer-1`（浅色主题 `#fff`）而不是透明：
		   *   宿主变量缺失时旧写法落到 `transparent`，输入框在卡片上就是「看不见底」的一块，
		   *   用户会以为渲染坏了。这里给真实底色 + fallback `#fff` 兜住。
		   */
		  input: {
		    minWidth: 0,
		    fontSize: 12.5,
		    lineHeight: "24px",
		    padding: "1px 8px",
		    width: "100%",
		    boxSizing: "border-box",
		    borderRadius: 7,
		    border: `1px solid ${BORDER_4}`,
		    background: SURFACE_RAISED,
		    color: "inherit"
		  },
		  textarea: {
		    fontSize: 12,
		    padding: "5px 8px",
		    width: "100%",
		    minWidth: 0,
		    boxSizing: "border-box",
		    borderRadius: 7,
		    minHeight: 48,
		    resize: "vertical",
		    fontFamily: "var(--font-mono, ui-monospace, monospace)",
		    border: `1px solid ${BORDER_4}`,
		    background: SURFACE_RAISED,
		    color: "inherit"
		  },
		  checkboxRow: { display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" },
		  overridden: {
		    fontSize: 10.5,
		    opacity: 0.75,
		    border: `1px solid ${BORDER_3}`,
		    borderRadius: 999,
		    padding: "0 6px",
		    lineHeight: "16px"
		  },
		  select: {
		    fontSize: 12.5,
		    lineHeight: "26px",
		    padding: "1px 8px",
		    width: "100%",
		    minWidth: 0,
		    boxSizing: "border-box",
		    borderRadius: 7,
		    border: `1px solid ${BORDER_4}`,
		    background: SURFACE_RAISED,
		    color: "inherit"
		  },
		  modelMeta: { fontSize: 11.5, opacity: 0.65, marginTop: 6, lineHeight: 1.5 },
		  /**
		   * 底部保存条（保存 / 放弃修改 / 恢复默认）。
		   *
		   * ★ 横向负 margin + 同额 padding：`.options` 左右各有 24px 内边距，
		   *   sticky 元素默认只覆盖**内容区**宽度，两侧那 24px 缝里滚过去的内容会直接露出来
		   *   （旧版 `padding: '10px 0'` 时更明显，连上下都有 10px 缝）。
		   *   用 `marginLeft/Right: -24` + `paddingLeft/Right: 24` 把缝盖满。
		   * ★ 背景必须不透明：写 `transparent` 时下方「当前模型」输入框会透过按钮显示出来。
		   */
		  footer: {
		    display: "flex",
		    alignItems: "center",
		    gap: 10,
		    flexWrap: "wrap",
		    position: "sticky",
		    bottom: 0,
		    zIndex: 3,
		    marginLeft: -24,
		    marginRight: -24,
		    paddingLeft: 24,
		    paddingRight: 24,
		    paddingTop: 10,
		    paddingBottom: 10,
		    background: SURFACE,
		    isolation: "isolate",
		    borderTop: `1px solid ${BORDER_1}`
		  },
		  dirty: { fontSize: 12, opacity: 0.75 },
		  banner: { fontSize: 12, lineHeight: 1.55, borderRadius: 8, padding: "8px 10px", marginBottom: 12 },
		  error: { border: `1px solid ${DANGER}`, color: DANGER, background: `color-mix(in srgb, ${DANGER} 8%, transparent)` },
		  notice: { border: `1px solid ${SUCCESS}`, color: SUCCESS, background: `color-mix(in srgb, ${SUCCESS} 8%, transparent)` },
		  /** 警告（橙）：与状态徽章里的 starting/stopping 同色，表示「能跑但要注意」。 */
		  warn: { border: `1px solid ${WARN}`, color: c("--dsw-alias-state-warn-label", "#9a6209"), background: `color-mix(in srgb, ${WARN} 8%, transparent)` },
		  hint: { border: `1px solid ${BORDER_2}`, opacity: 0.85 },
		  // ── 「本次启动参数」面板（设置页最顶部）────────────────────────────────────
		  /**
		   * 代码块**横竖都可滚**，不换行。
		   *
		   * `whiteSpace: 'pre'` + `overflowX: 'auto'` 是刻意的：命令行的每一项都要能一眼看出
		   * 「哪一项配哪个值」，一旦自动换行，`--kvmem-budget` 和它的数字就会被拆到两行上去。
		   * `maxHeight` 则保证几十项参数也不会把下面的设置项挤出视口。
		   */
		  codeBlock: {
		    fontFamily: "var(--font-mono, ui-monospace, monospace)",
		    fontSize: 11,
		    lineHeight: 1.7,
		    margin: 0,
		    padding: "10px 12px",
		    borderRadius: 8,
		    border: `1px solid ${BORDER_2}`,
		    background: SURFACE_RAISED,
		    color: LABEL,
		    overflow: "auto",
		    maxHeight: 280,
		    whiteSpace: "pre",
		    minWidth: 0
		  },
		  /** 参数摘要：两列网格，窄屏也压得住（列宽 `minmax(0, 1fr)`，裸 `1fr` 会拒绝压缩）。 */
		  factGrid: {
		    display: "grid",
		    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		    gap: "10px 16px",
		    margin: "12px 0 0",
		    minWidth: 0
		  },
		  factCell: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
		  factLabel: { fontSize: 11, opacity: 0.6, minWidth: 0 },
		  factValue: {
		    fontFamily: "var(--font-mono, ui-monospace, monospace)",
		    fontSize: 11.5,
		    wordBreak: "break-all",
		    minWidth: 0
		  },
		  factNote: { fontSize: 10.5, opacity: 0.55, lineHeight: 1.45 },
		  /** 面板顶部的小标题（「本次启动参数」「参数摘要」这种）。 */
		  subTitle: { fontSize: 12.5, fontWeight: 500, margin: "0 0 8px" },
		  /** 面板右上角的工具行（复制按钮 + 时间）。 */
		  panelHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10, minWidth: 0 },
		  panelHeadSpacer: { flex: "1 1 auto", minWidth: 0 }
		};
		var pair = (fg) => ({
		  fg,
		  bg: `color-mix(in srgb, ${fg} 12%, transparent)`,
		  border: `color-mix(in srgb, ${fg} 35%, transparent)`
		});
		var STATE_COLORS = {
		  ready: pair(c("--dsw-alias-state-success-primary", "#22c55e")),
		  starting: pair(c("--dsw-alias-state-warn-primary", "#f59e0b")),
		  stopping: pair(c("--dsw-alias-state-warn-primary", "#f59e0b")),
		  failed: pair(c("--dsw-alias-state-error-primary", "#ec1313")),
		  idle: pair(c("--dsw-alias-label-secondary", "#61666b")),
		  disabled: pair(c("--dsw-alias-label-secondary", "#61666b"))
		};
		
		// client/src/presets.jsx
		var import_jsx_runtime = require("react/jsx-runtime");
		function PresetBar({ presets, dirtyCount, invalid, busy, busyAny, snapshot, resetDraft, act }) {
		  const [name, setName] = (0, import_react.useState)("");
		  const [lastId, setLastId] = (0, import_react.useState)(null);
		  const items = presets?.items ?? [];
		  const excludedCount = (presets?.excluded ?? []).length;
		  const activeId = presets?.activeId ?? null;
		  const lastPreset = items.find((item) => item.id === lastId) ?? null;
		  const label = name.trim();
		  const canSave = !busyAny && label.length > 0 && invalid.length === 0;
		  const doSave = () => {
		    if (!canSave) return;
		    void act(
		      "preset:save",
		      async () => {
		        const next = await savePreset(label, snapshot());
		        setName("");
		        setLastId(null);
		        return next;
		      },
		      `Preset "${label}" saved`
		    );
		  };
		  const doApply = (preset) => {
		    if (busyAny) return;
		    if (dirtyCount > 0 && !window.confirm(`Applying the preset discards your current ${dirtyCount} unsaved change${dirtyCount === 1 ? "" : "s"}. Continue?`)) return;
		    void act(
		      "preset:apply",
		      async () => {
		        const next = await applyPreset(preset.id);
		        resetDraft();
		        setLastId(preset.id);
		        return next;
		      },
		      `Preset "${preset.name}" applied`
		    );
		  };
		  const doOverwrite = (preset) => {
		    if (busyAny) return;
		    void act(
		      "preset:overwrite",
		      () => overwritePreset(preset.id, snapshot()),
		      `Preset "${preset.name}" updated with the current parameters`
		    );
		  };
		  const doRename = (preset) => {
		    if (busyAny) return;
		    const input = window.prompt("Preset name", preset.name);
		    if (input === null) return;
		    const next = input.trim();
		    if (next === "" || next === preset.name) return;
		    void act("preset:rename", () => renamePreset(preset.id, next), `Preset renamed to "${next}"`);
		  };
		  const doRemove = (preset) => {
		    if (busyAny) return;
		    const ok = window.confirm(`Delete preset "${preset.name}"?
		
		Only this parameter set is removed; the currently active settings are not affected.`);
		    if (!ok) return;
		    void act(
		      "preset:delete",
		      async () => {
		        const next = await deletePreset(preset.id);
		        if (lastId === preset.id) setLastId(null);
		        return next;
		      },
		      `Preset "${preset.name}" deleted`
		    );
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...S.card, ...S.cardPinned }, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: S.groupTitle, children: "Parameter presets" }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: S.groupHint, children: [
		      "Save the current full set of loading and inference parameters as a named preset and switch with one click \u2014 clicking a preset name applies it (the model is reloaded with the new parameters). Machine-specific settings such as ports, paths, and keys (",
		      excludedCount,
		      " in total) are not part of presets and stay unchanged when switching."
		    ] }),
		    presets?.warning ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...S.banner, ...S.warn, marginBottom: 10 }, children: presets.warning }) : null,
		    items.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: S.modelMeta, children: 'No presets yet. Once you have tuned the parameters to your liking, enter a name below and click "Save as preset"; you can switch back with one click anytime.' }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: S.chipRow, children: items.map((preset) => {
		      const isActive = preset.id === activeId;
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { ...S.chip, ...isActive ? S.chipActive : {} }, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		          "button",
		          {
		            type: "button",
		            style: { ...S.chipLabel, ...busyAny ? S.buttonDisabled : {} },
		            disabled: busyAny,
		            title: `Apply "${preset.name}": ${preset.fieldCount} parameters in total` + (preset.changed > 0 ? `, ${preset.changed} differ from current` : " (identical to current)"),
		            onClick: () => doApply(preset),
		            children: [
		              preset.name,
		              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.chipMeta, children: preset.changed > 0 ? `${preset.changed} differ` : "active" })
		            ]
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: S.chipIcon, disabled: busyAny, title: "Rename", onClick: () => doRename(preset), children: "\u270E" }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: S.chipIcon, disabled: busyAny, title: "Delete this preset", onClick: () => doRemove(preset), children: "\xD7" })
		      ] }, preset.id);
		    }) }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.presetRow, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "input",
		        {
		          type: "text",
		          style: { ...S.input, width: "auto", flex: "1 1 220px" },
		          placeholder: "Preset name, e.g.: vision / long context / low VRAM",
		          value: name,
		          maxLength: 40,
		          onChange: (e) => setName(e.target.value),
		          onKeyDown: (e) => {
		            if (e.key === "Enter") doSave();
		          }
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "button",
		        {
		          type: "button",
		          style: { ...S.buttonPrimary, ...canSave ? {} : S.buttonDisabled },
		          disabled: !canSave,
		          onClick: doSave,
		          children: busy === "preset:save" ? "Saving\u2026" : "Save as preset"
		        }
		      ),
		      lastPreset ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
		        "button",
		        {
		          type: "button",
		          style: { ...S.button, ...busyAny ? S.buttonDisabled : {} },
		          disabled: busyAny,
		          title: "Write the current on-screen parameters back to this preset (name unchanged)",
		          onClick: () => doOverwrite(lastPreset),
		          children: [
		            'Update "',
		            lastPreset.name,
		            '" with current parameters'
		          ]
		        }
		      ) : null
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.modelMeta, children: [
		      "What is saved is the current on-screen parameter set",
		      dirtyCount > 0 ? ` (including ${dirtyCount} unsaved change${dirtyCount === 1 ? "" : "s"}, stored in the preset as well)` : " (identical to the saved settings)",
		      '; empty number fields are treated as "not set" and never written as 0.'
		    ] }),
		    presets?.file ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.modelMeta, children: [
		      "Preset file: ",
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.mono, children: presets.file })
		    ] }) : null,
		    invalid.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...S.banner, ...S.error, marginTop: 10, marginBottom: 0 }, children: [
		      "Some fields have an invalid format (",
		      invalid.join(", "),
		      "); fix them before saving the preset."
		    ] }) : null
		  ] });
		}
		
		// client/src/section.jsx
		var import_jsx_runtime2 = require("react/jsx-runtime");
		var POLL_MS = 4e3;
		function LocalModelSection() {
		  const [state, setState] = (0, import_react2.useState)(null);
		  const [draft, setDraft] = (0, import_react2.useState)({});
		  const [unset, setUnset] = (0, import_react2.useState)([]);
		  const [invalid, setInvalid] = (0, import_react2.useState)([]);
		  const [busy, setBusy] = (0, import_react2.useState)("");
		  const [error, setError] = (0, import_react2.useState)(null);
		  const [notice, setNotice] = (0, import_react2.useState)(null);
		  const mounted = (0, import_react2.useRef)(true);
		  const load = (0, import_react2.useCallback)(async (options = {}) => {
		    try {
		      const next = await fetchState();
		      if (!mounted.current) return;
		      setState(next);
		      if (options.clearDraft) {
		        setDraft({});
		        setUnset([]);
		        setInvalid([]);
		      }
		      if (options.silent !== true) setError(null);
		    } catch (err) {
		      if (mounted.current) setError(err.message);
		    }
		  }, []);
		  (0, import_react2.useEffect)(() => {
		    mounted.current = true;
		    void load({ clearDraft: true });
		    return () => {
		      mounted.current = false;
		    };
		  }, [load]);
		  const runtimeState = state?.runtime?.state;
		  (0, import_react2.useEffect)(() => {
		    if (runtimeState !== "starting" && runtimeState !== "stopping") return void 0;
		    const timer = setInterval(() => void load({ silent: true }), POLL_MS);
		    return () => clearInterval(timer);
		  }, [runtimeState, load]);
		  const config = state?.config ?? {};
		  const overridden = (0, import_react2.useMemo)(() => new Set(state?.overridden ?? []), [state]);
		  const dirtyCount = Object.keys(draft).length + unset.length;
		  const valueOf = (key) => Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : config[key];
		  const setValue = (field, raw) => {
		    let value = raw;
		    if (field.kind === "text") {
		      try {
		        value = raw.trim() === "" ? {} : JSON.parse(raw);
		        setInvalid((list) => list.filter((k) => k !== field.key));
		      } catch {
		        value = raw;
		        setInvalid((list) => list.includes(field.key) ? list : [...list, field.key]);
		      }
		    }
		    setDraft((d) => ({ ...d, [field.key]: value }));
		    setUnset((u) => u.filter((k) => k !== field.key));
		  };
		  const revertField = (field) => {
		    setDraft((d) => {
		      const next = { ...d };
		      delete next[field.key];
		      return next;
		    });
		    setUnset((u) => u.includes(field.key) ? u : [...u, field.key]);
		    setInvalid((list) => list.filter((k) => k !== field.key));
		  };
		  const discard = () => {
		    resetDraft();
		    setError(null);
		    setNotice(null);
		  };
		  const resetDraft = () => {
		    setDraft({});
		    setUnset([]);
		    setInvalid([]);
		  };
		  const fieldKinds = (0, import_react2.useMemo)(() => fieldKindMap(state?.form?.groups ?? []), [state]);
		  const presetSnapshot = () => buildPresetSnapshot({
		    keys: state?.presets?.keys ?? [],
		    kinds: fieldKinds,
		    draft,
		    config
		  });
		  const act = async (name, fn, successMessage) => {
		    setBusy(name);
		    setError(null);
		    setNotice(null);
		    try {
		      const result = await fn();
		      if (!mounted.current) return;
		      setState(result);
		      if (successMessage) setNotice(successMessage);
		    } catch (err) {
		      if (mounted.current) setError(err.message);
		    } finally {
		      if (mounted.current) setBusy("");
		    }
		  };
		  const save = () => {
		    if (invalid.length > 0) {
		      setError(`Some fields have an invalid format, please fix them first: ${invalid.join(", ")}`);
		      return;
		    }
		    void act(
		      "save",
		      async () => {
		        const next = await saveConfig(draft, unset);
		        setDraft({});
		        setUnset([]);
		        setNotice("Settings saved; the model was unloaded with the new parameters and will be reloaded automatically on the next conversation");
		        return next;
		      },
		      null
		    );
		  };
		  if (!state) {
		    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.wrap, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { style: S.h2, children: "Local model" }),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: S.lede, children: error ? "Unable to connect to the local model plugin." : "Loading settings\u2026" }),
		      error ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.banner, ...S.error }, children: error }) : null
		    ] });
		  }
		  const colors = STATE_COLORS[runtimeState] ?? STATE_COLORS.idle;
		  const isReady = runtimeState === "ready";
		  const busyAny = busy !== "";
		  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.wrap, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { style: S.h2, children: "Local model" }),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { style: S.lede, children: [
		      "Runs models with the local llama.cpp: once you pick a model, the first conversation loads it automatically, and after ",
		      config.idleUnloadMinutes ?? 5,
		      " ",
		      "minutes without interaction it is unloaded automatically to free VRAM."
		    ] }),
		    error ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.banner, ...S.error }, children: error }) : null,
		    notice ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.banner, ...S.notice }, children: notice }) : null,
		    runtimeState === "disabled" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.banner, ...S.hint }, children: "The master switch is off: no port is listened on and no process is started." }) : null,
		    state.runtime.visionDisabledByMtp ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.banner, ...S.warn }, children: state.runtime.visionDisabledByMtp }) : null,
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(LaunchPanel, { launch: state.runtime.launch, loadedAt: state.runtime.loadedAt }),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		      PresetBar,
		      {
		        presets: state.presets,
		        dirtyCount,
		        invalid,
		        busy,
		        busyAny,
		        snapshot: presetSnapshot,
		        resetDraft,
		        act
		      }
		    ),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.card, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: S.statusRow, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { ...S.badge, color: colors.fg, background: colors.bg, borderColor: colors.border }, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...S.dot, background: colors.fg } }),
		        state.runtime.stateLabel
		      ] }) }),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.metaGrid, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Current model: " }),
		          state.runtime.model ? `${state.runtime.model.displayName}${state.runtime.model.quant ? ` [${state.runtime.model.quant}]` : ""}` : "Not selected"
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Process: " }),
		          state.runtime.pid ? `pid ${state.runtime.pid}` : "Not running"
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Endpoint: " }),
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.mono, children: state.runtime.endpoint })
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Total models: " }),
		          state.runtime.modelsFound
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Reasoning effort: " }),
		          Array.isArray(state.runtime.reasoningEfforts) && state.runtime.reasoningEfforts.length > 0 ? (
		            /* 模型模板支持哪几档，决定对话框里选的档位最后会变成什么 —— 一眼可见最省事。 */
		            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: S.mono, children: [
		              state.runtime.reasoningEfforts.join(" / "),
		              " (remapped by template)"
		            ] })
		          ) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "#9a6209" }, children: "Not resolved; no effort is sent this run (thinking is controlled by the switch only)" })
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Multi-token prediction: " }),
		          state.runtime.mtp ? "Enabled (--spec-type draft-mtp)" : "Disabled"
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Vision projector: " }),
		          state.runtime.visionProjector ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.mono, children: state.runtime.visionProjector }) : state.runtime.visionDisabledByMtp ? (
		            /* 开着 MTP 时这里恒为空，别让它显示成「纯文本」—— 那是另一回事。 */
		            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "#9a6209" }, children: "Configured, but overridden by MTP this run" })
		          ) : "Not enabled (text only)"
		        ] }),
		        isReady && state.runtime.unloadAt ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Auto-unload: " }),
		          new Date(state.runtime.unloadAt).toLocaleTimeString()
		        ] }) : null
		      ] }),
		      state.runtime.lastError ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.banner, ...S.error, marginTop: 12, marginBottom: 0 }, children: state.runtime.lastError }) : null,
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.actions, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		          "button",
		          {
		            type: "button",
		            style: { ...S.button, ...busyAny ? S.buttonDisabled : {} },
		            disabled: busyAny,
		            onClick: () => void act("scan", () => runAction("scan"), "Model directory rescanned"),
		            children: busy === "scan" ? "Scanning\u2026" : "Rescan"
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		          "button",
		          {
		            type: "button",
		            style: { ...S.button, ...busyAny || isReady ? S.buttonDisabled : {} },
		            disabled: busyAny || isReady,
		            onClick: () => void act("start", () => runAction("start"), "Model loaded"),
		            children: busy === "start" ? "Loading\u2026" : "Load now"
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		          "button",
		          {
		            type: "button",
		            style: { ...S.button, ...busyAny || !isReady ? S.buttonDisabled : {} },
		            disabled: busyAny || !isReady,
		            onClick: () => void act("stop", () => runAction("stop"), "Unloaded, VRAM freed"),
		            children: busy === "stop" ? "Unloading\u2026" : "Unload"
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", style: S.button, disabled: busyAny, onClick: () => void load({ silent: true }), children: "Refresh status" })
		      ] })
		    ] }),
		    state.form.groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.card, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { style: S.groupTitle, children: group.title }),
		      group.hint ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: S.groupHint, children: group.hint }) : null,
		      group.fields.map((field) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		        Field,
		        {
		          field,
		          value: valueOf(field.key),
		          models: state.models,
		          visionFiles: state.visionFiles ?? [],
		          mtp: valueOf("mtp") === true,
		          overridden: overridden.has(field.key) && !unset.includes(field.key) && !(field.key in draft),
		          invalid: invalid.includes(field.key),
		          onChange: (raw) => setValue(field, raw),
		          onRevert: () => revertField(field)
		        },
		        field.key
		      ))
		    ] }, group.id)),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.card, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { style: S.groupTitle, children: "Directories" }),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: S.groupHint, children: 'Download llama-server from the llama.cpp releases page and put GGUF models into the model directory. Once done, come back here and click "Rescan".' }),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...S.metaGrid, marginTop: 0 }, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Model directory: " }),
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.mono, children: state.form.paths.modelsDir })
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "Runtime directory: " }),
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.mono, children: state.form.paths.runtimeDir })
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.metaLabel, children: "User config: " }),
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.mono, children: state.form.paths.configFile })
		        ] })
		      ] })
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.footer, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		        "button",
		        {
		          type: "button",
		          style: { ...S.buttonPrimary, ...busyAny || dirtyCount === 0 || invalid.length > 0 ? S.buttonDisabled : {} },
		          disabled: busyAny || dirtyCount === 0 || invalid.length > 0,
		          onClick: save,
		          children: busy === "save" ? "Saving\u2026" : "Save"
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		        "button",
		        {
		          type: "button",
		          style: { ...S.button, ...dirtyCount === 0 ? S.buttonDisabled : {} },
		          disabled: dirtyCount === 0,
		          onClick: discard,
		          children: "Discard changes"
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		        "button",
		        {
		          type: "button",
		          style: { ...S.button, ...busyAny ? S.buttonDisabled : {} },
		          disabled: busyAny,
		          onClick: () => {
		            if (window.confirm("Restore the deployment defaults? This clears all changes you made on this page.")) {
		              void act("reset", () => resetConfig(), "Defaults restored");
		            }
		          },
		          children: busy === "reset" ? "Restoring\u2026" : "Restore defaults"
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.dirty, children: dirtyCount > 0 ? `${dirtyCount} unsaved change${dirtyCount === 1 ? "" : "s"}` : "No unsaved changes" })
		    ] })
		  ] });
		}
		function LaunchPanel({ launch, loadedAt }) {
		  const [copied, setCopied] = (0, import_react2.useState)("");
		  const lines = Array.isArray(launch?.lines) ? launch.lines : [];
		  const facts = Array.isArray(launch?.facts) ? launch.facts : [];
		  const notices = Array.isArray(launch?.notices) ? launch.notices : [];
		  const unrecognized = Array.isArray(launch?.unrecognized) ? launch.unrecognized : [];
		  if (lines.length === 0) {
		    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.card, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: S.subTitle, children: "Launch parameters" }),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: S.groupHint, children: "The model is not loaded yet. Once loading finishes, this lists **all parameters actually sent to llama-server** for this run." })
		    ] });
		  }
		  const groups = [];
		  for (const fact of facts) {
		    let group = groups.find((item) => item.name === fact.group);
		    if (!group) {
		      group = { name: fact.group, items: [] };
		      groups.push(group);
		    }
		    group.items.push(fact);
		  }
		  const when = loadedAt ? new Date(loadedAt).toLocaleTimeString() : "";
		  const copy = () => {
		    const text = launch.commandLine ?? lines.join("\n");
		    const done = (ok) => {
		      setCopied(ok ? "Copied" : "Copy failed");
		      setTimeout(() => setCopied(""), 1500);
		    };
		    try {
		      const pending = navigator.clipboard?.writeText(text);
		      if (pending && typeof pending.then === "function") pending.then(() => done(true), () => done(false));
		      else done(false);
		    } catch {
		      done(false);
		    }
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.card, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.panelHead, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { style: { ...S.subTitle, margin: 0 }, children: [
		        "Launch parameters",
		        when ? ` \xB7 ${when}` : "",
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...S.factNote, marginLeft: 8 }, children: "(all parameters the server actually received)" })
		      ] }),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.panelHeadSpacer }),
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { style: S.button, onClick: copy, children: copied || "Copy command line" })
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { style: S.codeBlock, children: lines.join("\n") }),
		    groups.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: S.factGrid, children: groups.flatMap((group) => [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		        "div",
		        {
		          style: { ...S.factLabel, gridColumn: "1 / -1", marginTop: 4, fontWeight: 500 },
		          children: group.name
		        },
		        `group-${group.name}`
		      ),
		      ...group.items.map((fact, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.factCell, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.factLabel, children: fact.label }),
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.factValue, children: fact.value }),
		        fact.note ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.factNote, children: fact.note }) : null
		      ] }, `${group.name}-${index}`))
		    ]) }) : null,
		    notices.map((text, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.banner, ...S.hint, marginTop: 12, marginBottom: 0 }, children: text }, `notice-${index}`)),
		    unrecognized.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...S.banner, ...S.warn, marginTop: 12, marginBottom: 0 }, children: [
		      'These options are not recognized (they may come from "Extra arguments"): ',
		      unrecognized.join(", ")
		    ] }) : null
		  ] });
		}
		function Field({ field, value, models, visionFiles, overridden, invalid, mtp, onChange, onRevert }) {
		  const isModelPicker = field.key === "selectedModel";
		  const isVisionPicker = field.key === "mmprojFile";
		  const visionLockedByMtp = isVisionPicker && mtp === true;
		  const control = () => {
		    if (isModelPicker) {
		      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("select", { style: S.select, value: value ?? "", onChange: (e) => onChange(e.target.value), children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "", children: "(Not selected)" }),
		          models.map((m) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("option", { value: m.id, disabled: !m.complete, children: [
		            m.displayName,
		            m.quant ? ` \xB7 ${m.quant}` : "",
		            m.params ? ` \xB7 ${m.params}` : "",
		            " \xB7 ",
		            m.sizeText,
		            m.complete ? "" : "(incomplete shards)",
		            m.hasVisionProjector ? " \xB7 with vision projector" : ""
		          ] }, m.id))
		        ] }),
		        models.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: S.modelMeta, children: 'No .gguf files in the model directory yet. Add models and click "Rescan" above.' }) : null
		      ] });
		    }
		    if (isVisionPicker) {
		      const selected = typeof value === "string" ? value.trim() : "";
		      const missing = selected !== "" && !visionFiles.some((f) => f.id === selected);
		      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
		        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
		          "select",
		          {
		            style: visionLockedByMtp ? { ...S.select, ...S.buttonDisabled } : S.select,
		            disabled: visionLockedByMtp,
		            value: selected,
		            onChange: (e) => onChange(e.target.value),
		            children: [
		              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "", children: "(Auto: links automatically when a file in the same directory can be uniquely matched)" }),
		              visionFiles.map((f) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("option", { value: f.id, children: [
		                f.id,
		                " \xB7 ",
		                f.sizeText
		              ] }, f.id)),
		              missing ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("option", { value: selected, children: [
		                selected,
		                " (not in scan results)"
		              ] }) : null
		            ]
		          }
		        ),
		        visionLockedByMtp ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.modelMeta, color: "#9a6209", opacity: 1 }, children: '\u26A0 "Multi-token prediction (MTP)" is enabled: MTP and image input cannot coexist, so --mmproj is not sent for this load. The file selected here is not cleared; it takes effect again once MTP is turned off. To use images, turn MTP off first.' }) : null,
		        !visionLockedByMtp && visionFiles.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: S.modelMeta, children: 'No mmproj-*.gguf files in the model directory yet. If you need image input, put the vision projector file into the model directory and click "Rescan" above; text-only models can stay on "Auto".' }) : null,
		        !visionLockedByMtp && missing ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...S.modelMeta, color: "#b02525", opacity: 1 }, children: "\u26A0 The selected file is no longer in the model directory (or cannot be read). It will be ignored on load or cause a --mmproj error; please select again." }) : null,
		        !visionLockedByMtp && !missing && selected === "" && visionFiles.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: S.modelMeta, children: 'Currently "Auto": only an mmproj in the same directory as the model, with unambiguous ownership, is loaded together with the model.' }) : null
		      ] });
		    }
		    switch (field.kind) {
		      case "boolean":
		        return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.checkboxRow, children: [
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { type: "checkbox", checked: value === true, onChange: (e) => onChange(e.target.checked) }),
		          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 12, opacity: 0.7 }, children: value === true ? "On" : "Off" })
		        ] });
		      case "number":
		        return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		          "input",
		          {
		            type: "number",
		            style: S.input,
		            value: value === void 0 || value === null ? "" : String(value),
		            min: field.min,
		            max: field.max,
		            onChange: (e) => onChange(e.target.value)
		          }
		        );
		      case "select":
		        return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("select", { style: S.select, value: value ?? "", onChange: (e) => onChange(e.target.value), children: (field.options ?? []).map((option) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: option, children: option }, option)) });
		      case "text":
		        return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		          "textarea",
		          {
		            style: { ...S.textarea, ...invalid ? { borderColor: "rgba(176,37,37,0.6)" } : {} },
		            value: typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2),
		            onChange: (e) => onChange(e.target.value)
		          }
		        );
		      default:
		        return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("input", { type: "text", style: S.input, value: value ?? "", onChange: (e) => onChange(e.target.value) });
		    }
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.field, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: S.label, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: field.label }),
		      overridden ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: S.overridden, children: "Overridden" }) : null
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { children: control() }),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
		      "button",
		      {
		        type: "button",
		        title: "Restore to default",
		        style: { ...S.button, fontSize: 11, lineHeight: "22px", padding: "0 8px" },
		        onClick: onRevert,
		        children: "Default"
		      }
		    ),
		    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...S.desc, ...invalid ? { color: "#b02525", opacity: 1 } : {} }, children: [
		      invalid ? "Invalid JSON format, saving is blocked: " : "",
		      field.description
		    ] })
		  ] });
		}
		
		// client/src/index.jsx
		var NS = "local-model";
		var zh = {
		  title: "Local model"
		};
		var en = {
		  title: "Local model"
		};
		var inject = ["slots", "locale"];
		function apply(ctx) {
		  ctx.effect(() => {
		    try {
		      return ctx.locale.register(NS, { zh, en });
		    } catch {
		      return () => {
		      };
		    }
		  }, "local-model: dictionaries");
		  ctx.slots.inject("settings.section", () => {
		    try {
		      return ctx.slots.register(
		        {
		          name: "settings.section",
		          id: NS,
		          // 排在通用设置/模型之后、插件与市场之前。
		          order: 25,
		          label: () => {
		            try {
		              return ctx.locale.bind(NS)("title");
		            } catch {
		              return "Local model";
		            }
		          },
		          locale: NS
		        },
		        LocalModelSection
		      );
		    } catch (error) {
		      console.warn("[local-model] Failed to register settings section:", error && error.message ? error.message : error);
		      return () => {
		      };
		    }
		  });
		}
		
		return module.exports;
	}
});
