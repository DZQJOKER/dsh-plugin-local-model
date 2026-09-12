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
		var src_exports = {};
		__export(src_exports, {
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = __toCommonJS(src_exports);

		// client/src/section.jsx
		var import_react = require("react");

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
		    const message = data && data.error || `请求失败（HTTP ${res.status}）`;
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

		// client/src/styles.js
		var c = (name, fallback) => `var(${name}, ${fallback})`;
		var S = {
		  wrap: { padding: "4px 2px 32px", maxWidth: 720 },
		  h2: { fontSize: 15, fontWeight: 500, margin: "0 0 4px" },
		  lede: { fontSize: 12.5, opacity: 0.7, margin: "0 0 16px", lineHeight: 1.6 },
		  card: {
		    border: `1px solid ${c("--color-border-tertiary", "rgba(0,0,0,0.12)")}`,
		    borderRadius: 12,
		    padding: "14px 16px",
		    marginBottom: 14,
		    background: c("--color-background-primary", "transparent")
		  },
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
		    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
		    gap: "6px 18px",
		    marginTop: 12,
		    fontSize: 12
		  },
		  metaLabel: { opacity: 0.6 },
		  mono: { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5, wordBreak: "break-all" },
		  actions: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 },
		  button: {
		    fontSize: 12.5,
		    lineHeight: "26px",
		    padding: "0 12px",
		    borderRadius: 8,
		    border: `1px solid ${c("--color-border-secondary", "rgba(0,0,0,0.22)")}`,
		    background: "transparent",
		    color: "inherit",
		    cursor: "pointer"
		  },
		  buttonPrimary: {
		    fontSize: 12.5,
		    lineHeight: "26px",
		    padding: "0 14px",
		    borderRadius: 8,
		    border: "1px solid transparent",
		    background: c("--color-text-primary", "#111"),
		    color: c("--color-background-primary", "#fff"),
		    cursor: "pointer"
		  },
		  buttonDisabled: { opacity: 0.5, cursor: "default" },
		  groupTitle: { fontSize: 13.5, fontWeight: 500, margin: "0 0 2px", display: "flex", alignItems: "center", gap: 8 },
		  groupHint: { fontSize: 12, opacity: 0.62, margin: "0 0 12px", lineHeight: 1.55 },
		  field: {
		    display: "grid",
		    gridTemplateColumns: "minmax(140px, 190px) 1fr auto",
		    gap: "6px 12px",
		    alignItems: "start",
		    padding: "7px 0",
		    borderTop: `1px solid ${c("--color-border-tertiary", "rgba(0,0,0,0.08)")}`
		  },
		  label: { fontSize: 12.5, paddingTop: 5, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
		  desc: { fontSize: 11.5, opacity: 0.6, lineHeight: 1.5, marginTop: 4, gridColumn: "2 / 4" },
		  input: {
		    fontSize: 12.5,
		    lineHeight: "24px",
		    padding: "1px 8px",
		    width: "100%",
		    boxSizing: "border-box",
		    borderRadius: 7,
		    border: `1px solid ${c("--color-border-secondary", "rgba(0,0,0,0.22)")}`,
		    background: c("--color-background-secondary", "transparent"),
		    color: "inherit"
		  },
		  textarea: {
		    fontSize: 12,
		    padding: "5px 8px",
		    width: "100%",
		    boxSizing: "border-box",
		    borderRadius: 7,
		    minHeight: 48,
		    resize: "vertical",
		    fontFamily: "var(--font-mono, ui-monospace, monospace)",
		    border: `1px solid ${c("--color-border-secondary", "rgba(0,0,0,0.22)")}`,
		    background: c("--color-background-secondary", "transparent"),
		    color: "inherit"
		  },
		  checkboxRow: { display: "flex", alignItems: "center", gap: 8 },
		  overridden: {
		    fontSize: 10.5,
		    opacity: 0.75,
		    border: `1px solid ${c("--color-border-tertiary", "rgba(0,0,0,0.15)")}`,
		    borderRadius: 999,
		    padding: "0 6px",
		    lineHeight: "16px"
		  },
		  select: {
		    fontSize: 12.5,
		    lineHeight: "26px",
		    padding: "1px 8px",
		    width: "100%",
		    boxSizing: "border-box",
		    borderRadius: 7,
		    border: `1px solid ${c("--color-border-secondary", "rgba(0,0,0,0.22)")}`,
		    background: c("--color-background-secondary", "transparent"),
		    color: "inherit"
		  },
		  modelMeta: { fontSize: 11.5, opacity: 0.65, marginTop: 6, lineHeight: 1.5 },
		  footer: {
		    display: "flex",
		    alignItems: "center",
		    gap: 10,
		    flexWrap: "wrap",
		    position: "sticky",
		    bottom: 0,
		    padding: "10px 0",
		    background: c("--color-background-primary", "transparent")
		  },
		  dirty: { fontSize: 12, opacity: 0.75 },
		  banner: { fontSize: 12, lineHeight: 1.55, borderRadius: 8, padding: "8px 10px", marginBottom: 12 },
		  error: { border: `1px solid ${c("--color-border-danger", "rgba(200,40,40,0.45)")}`, color: c("--color-text-danger", "#b02525") },
		  notice: { border: `1px solid ${c("--color-border-success", "rgba(30,140,80,0.45)")}`, color: c("--color-text-success", "#1c7a48") },
		  hint: { border: `1px solid ${c("--color-border-tertiary", "rgba(0,0,0,0.12)")}`, opacity: 0.85 }
		};
		var STATE_COLORS = {
		  ready: { fg: "#1c7a48", bg: "rgba(28,122,72,0.12)", border: "rgba(28,122,72,0.35)" },
		  starting: { fg: "#9a6209", bg: "rgba(154,98,9,0.12)", border: "rgba(154,98,9,0.35)" },
		  stopping: { fg: "#9a6209", bg: "rgba(154,98,9,0.12)", border: "rgba(154,98,9,0.35)" },
		  failed: { fg: "#b02525", bg: "rgba(176,37,37,0.12)", border: "rgba(176,37,37,0.35)" },
		  idle: { fg: "#5a5a56", bg: "rgba(120,120,116,0.12)", border: "rgba(120,120,116,0.35)" },
		  disabled: { fg: "#5a5a56", bg: "rgba(120,120,116,0.12)", border: "rgba(120,120,116,0.35)" }
		};

		// client/src/section.jsx
		var import_jsx_runtime = require("react/jsx-runtime");
		var POLL_MS = 4e3;
		function LocalModelSection() {
		  const [state, setState] = (0, import_react.useState)(null);
		  const [draft, setDraft] = (0, import_react.useState)({});
		  const [unset, setUnset] = (0, import_react.useState)([]);
		  const [invalid, setInvalid] = (0, import_react.useState)([]);
		  const [busy, setBusy] = (0, import_react.useState)("");
		  const [error, setError] = (0, import_react.useState)(null);
		  const [notice, setNotice] = (0, import_react.useState)(null);
		  const mounted = (0, import_react.useRef)(true);
		  const load = (0, import_react.useCallback)(async (options = {}) => {
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
		  (0, import_react.useEffect)(() => {
		    mounted.current = true;
		    void load({ clearDraft: true });
		    return () => {
		      mounted.current = false;
		    };
		  }, [load]);
		  const runtimeState = state?.runtime?.state;
		  (0, import_react.useEffect)(() => {
		    if (runtimeState !== "starting" && runtimeState !== "stopping") return void 0;
		    const timer = setInterval(() => void load({ silent: true }), POLL_MS);
		    return () => clearInterval(timer);
		  }, [runtimeState, load]);
		  const config = state?.config ?? {};
		  const overridden = (0, import_react.useMemo)(() => new Set(state?.overridden ?? []), [state]);
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
		    setDraft({});
		    setUnset([]);
		    setInvalid([]);
		    setError(null);
		    setNotice(null);
		  };
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
		      setError(`有字段格式不对，请先修正：${invalid.join("、")}`);
		      return;
		    }
		    void act(
		      "save",
		      async () => {
		        const next = await saveConfig(draft, unset);
		        setDraft({});
		        setUnset([]);
		        setNotice("设置已保存；模型已按新参数卸载，下次对话会自动重新加载");
		        return next;
		      },
		      null
		    );
		  };
		  if (!state) {
		    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.wrap, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: S.h2, children: "本地模型" }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: S.lede, children: error ? "无法连接到本地模型插件。" : "正在读取配置…" }),
		      error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...S.banner, ...S.error }, children: error }) : null
		    ] });
		  }
		  const colors = STATE_COLORS[runtimeState] ?? STATE_COLORS.idle;
		  const isReady = runtimeState === "ready";
		  const busyAny = busy !== "";
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.wrap, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: S.h2, children: "本地模型" }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: S.lede, children: [
		      "用本机的 llama.cpp 跑模型：选定模型后，第一条对话会自动加载，连续 ",
		      config.idleUnloadMinutes ?? 5,
		      " ",
		      "分钟无交互会自动卸载并释放显存。"
		    ] }),
		    error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...S.banner, ...S.error }, children: error }) : null,
		    notice ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...S.banner, ...S.notice }, children: notice }) : null,
		    runtimeState === "disabled" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...S.banner, ...S.hint }, children: "总开关已关闭：不会监听端口，也不会拉起任何进程。" }) : null,
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.card, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: S.statusRow, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { ...S.badge, color: colors.fg, background: colors.bg, borderColor: colors.border }, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...S.dot, background: colors.fg } }),
		        state.runtime.stateLabel
		      ] }) }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.metaGrid, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.metaLabel, children: "当前模型：" }),
		          state.runtime.model ? `${state.runtime.model.displayName}${state.runtime.model.quant ? ` [${state.runtime.model.quant}]` : ""}` : "未选择"
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.metaLabel, children: "进程：" }),
		          state.runtime.pid ? `pid ${state.runtime.pid}` : "未运行"
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.metaLabel, children: "入口：" }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.mono, children: state.runtime.endpoint })
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.metaLabel, children: "模型总数：" }),
		          state.runtime.modelsFound
		        ] }),
		        isReady && state.runtime.unloadAt ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.metaLabel, children: "自动卸载：" }),
		          new Date(state.runtime.unloadAt).toLocaleTimeString()
		        ] }) : null
		      ] }),
		      state.runtime.lastError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...S.banner, ...S.error, marginTop: 12, marginBottom: 0 }, children: state.runtime.lastError }) : null,
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.actions, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          "button",
		          {
		            type: "button",
		            style: { ...S.button, ...busyAny ? S.buttonDisabled : {} },
		            disabled: busyAny,
		            onClick: () => void act("scan", () => runAction("scan"), "已重新扫描模型目录"),
		            children: busy === "scan" ? "扫描中…" : "重新扫描"
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          "button",
		          {
		            type: "button",
		            style: { ...S.button, ...busyAny || isReady ? S.buttonDisabled : {} },
		            disabled: busyAny || isReady,
		            onClick: () => void act("start", () => runAction("start"), "模型已加载"),
		            children: busy === "start" ? "加载中…" : "立即加载"
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          "button",
		          {
		            type: "button",
		            style: { ...S.button, ...busyAny || !isReady ? S.buttonDisabled : {} },
		            disabled: busyAny || !isReady,
		            onClick: () => void act("stop", () => runAction("stop"), "已卸载，显存已释放"),
		            children: busy === "stop" ? "卸载中…" : "卸载"
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: S.button, disabled: busyAny, onClick: () => void load({ silent: true }), children: "刷新状态" })
		      ] })
		    ] }),
		    state.form.groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.card, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: S.groupTitle, children: group.title }),
		      group.hint ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: S.groupHint, children: group.hint }) : null,
		      group.fields.map((field) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        Field,
		        {
		          field,
		          value: valueOf(field.key),
		          models: state.models,
		          overridden: overridden.has(field.key) && !unset.includes(field.key) && !(field.key in draft),
		          invalid: invalid.includes(field.key),
		          onChange: (raw) => setValue(field, raw),
		          onRevert: () => revertField(field)
		        },
		        field.key
		      ))
		    ] }, group.id)),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.card, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: S.groupTitle, children: "目录约定" }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: S.groupHint, children: "自己去 llama.cpp 的 release 页面下载 llama-server，把 GGUF 模型放进模型目录。放好后回到这里点「重新扫描」。" }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...S.metaGrid, marginTop: 0 }, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.metaLabel, children: "模型目录：" }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.mono, children: state.form.paths.modelsDir })
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.metaLabel, children: "运行时目录：" }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.mono, children: state.form.paths.runtimeDir })
		        ] }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.metaLabel, children: "用户配置：" }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.mono, children: state.form.paths.configFile })
		        ] })
		      ] })
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.footer, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "button",
		        {
		          type: "button",
		          style: { ...S.buttonPrimary, ...busyAny || dirtyCount === 0 || invalid.length > 0 ? S.buttonDisabled : {} },
		          disabled: busyAny || dirtyCount === 0 || invalid.length > 0,
		          onClick: save,
		          children: busy === "save" ? "保存中…" : "保存"
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "button",
		        {
		          type: "button",
		          style: { ...S.button, ...dirtyCount === 0 ? S.buttonDisabled : {} },
		          disabled: dirtyCount === 0,
		          onClick: discard,
		          children: "放弃修改"
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		        "button",
		        {
		          type: "button",
		          style: { ...S.button, ...busyAny ? S.buttonDisabled : {} },
		          disabled: busyAny,
		          onClick: () => {
		            if (window.confirm("恢复为部署默认值？这会清空你在这个页面上做过的所有修改。")) {
		              void act("reset", () => resetConfig(), "已恢复默认值");
		            }
		          },
		          children: busy === "reset" ? "恢复中…" : "恢复默认"
		        }
		      ),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.dirty, children: dirtyCount > 0 ? `有 ${dirtyCount} 项未保存` : "没有未保存的修改" })
		    ] })
		  ] });
		}
		function Field({ field, value, models, overridden, invalid, onChange, onRevert }) {
		  const isModelPicker = field.key === "selectedModel";
		  const control = () => {
		    if (isModelPicker) {
		      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { style: S.select, value: value ?? "", onChange: (e) => onChange(e.target.value), children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "（未选择）" }),
		          models.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: m.id, disabled: !m.complete, children: [
		            m.displayName,
		            m.quant ? ` · ${m.quant}` : "",
		            m.params ? ` · ${m.params}` : "",
		            " · ",
		            m.sizeText,
		            m.complete ? "" : "（分片不完整）",
		            m.hasVisionProjector ? " · 含视觉投影" : ""
		          ] }, m.id))
		        ] }),
		        models.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: S.modelMeta, children: "模型目录里还没有 .gguf 文件。把模型放进去后点上面的「重新扫描」。" }) : null
		      ] });
		    }
		    switch (field.kind) {
		      case "boolean":
		        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.checkboxRow, children: [
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: value === true, onChange: (e) => onChange(e.target.checked) }),
		          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, opacity: 0.7 }, children: value === true ? "开启" : "关闭" })
		        ] });
		      case "number":
		        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
		        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", { style: S.select, value: value ?? "", onChange: (e) => onChange(e.target.value), children: (field.options ?? []).map((option) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: option, children: option }, option)) });
		      case "text":
		        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          "textarea",
		          {
		            style: { ...S.textarea, ...invalid ? { borderColor: "rgba(176,37,37,0.6)" } : {} },
		            value: typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2),
		            onChange: (e) => onChange(e.target.value)
		          }
		        );
		      default:
		        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "text", style: S.input, value: value ?? "", onChange: (e) => onChange(e.target.value) });
		    }
		  };
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.field, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.label, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: field.label }),
		      overridden ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.overridden, children: "已覆盖" }) : null
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: control() }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      "button",
		      {
		        type: "button",
		        title: "恢复为默认值",
		        style: { ...S.button, fontSize: 11, lineHeight: "22px", padding: "0 8px" },
		        onClick: onRevert,
		        children: "默认"
		      }
		    ),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...S.desc, ...invalid ? { color: "#b02525", opacity: 1 } : {} }, children: [
		      invalid ? "JSON 格式不对，保存会被阻止：" : "",
		      field.description
		    ] })
		  ] });
		}

		// client/src/index.jsx
		var NS = "local-model";
		var zh = {
		  title: "本地模型"
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
		              return "本地模型";
		            }
		          },
		          locale: NS
		        },
		        LocalModelSection
		      );
		    } catch (error) {
		      console.warn("[local-model] 注册设置分区失败：", error && error.message ? error.message : error);
		      return () => {
		      };
		    }
		  });
		}
		return module.exports;
	}
});
