import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fetchState, resetConfig, runAction, saveConfig } from './api.js'
import { buildPresetSnapshot, fieldKindMap } from './presetSnapshot.js'
import { PresetBar } from './presets.jsx'
import { S, STATE_COLORS } from './styles.js'

/** 轮询间隔：只在「加载中 / 卸载中」这两种有过程感的状态下开启。 */
const POLL_MS = 4000

/**
 * 「本地模型」设置页。
 *
 * 这个组件刻意做得很薄：字段列表、类型、默认值、说明文案全部由宿主通过
 * schema.toJSON() 序列化后送过来，这里只负责通用渲染与提交。
 * 因此 config.ts 里加一个字段，界面自动出现，不需要动客户端。
 */
export function LocalModelSection() {
  const [state, setState] = useState(null)
  const [draft, setDraft] = useState({})
  const [unset, setUnset] = useState([])
  const [invalid, setInvalid] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const mounted = useRef(true)

  const load = useCallback(async (options = {}) => {
    try {
      const next = await fetchState()
      if (!mounted.current) return
      setState(next)
      if (options.clearDraft) {
        setDraft({})
        setUnset([])
        setInvalid([])
      }
      if (options.silent !== true) setError(null)
    } catch (err) {
      if (mounted.current) setError(err.message)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load({ clearDraft: true })
    return () => {
      mounted.current = false
    }
  }, [load])

  const runtimeState = state?.runtime?.state
  useEffect(() => {
    if (runtimeState !== 'starting' && runtimeState !== 'stopping') return undefined
    const timer = setInterval(() => void load({ silent: true }), POLL_MS)
    return () => clearInterval(timer)
  }, [runtimeState, load])

  const config = state?.config ?? {}
  const overridden = useMemo(() => new Set(state?.overridden ?? []), [state])
  const dirtyCount = Object.keys(draft).length + unset.length

  const valueOf = (key) => (Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : config[key])

  const setValue = (field, raw) => {
    let value = raw
    if (field.kind === 'text') {
      // 字典字段：能解析就存对象，解析不了就把原文挂起来并阻止保存，
      // 否则会被宿主的写入闸门静默丢掉，用户看到的是「改了但不生效」。
      try {
        value = raw.trim() === '' ? {} : JSON.parse(raw)
        setInvalid((list) => list.filter((k) => k !== field.key))
      } catch {
        value = raw
        setInvalid((list) => (list.includes(field.key) ? list : [...list, field.key]))
      }
    }
    setDraft((d) => ({ ...d, [field.key]: value }))
    setUnset((u) => u.filter((k) => k !== field.key))
  }

  const revertField = (field) => {
    setDraft((d) => {
      const next = { ...d }
      delete next[field.key]
      return next
    })
    setUnset((u) => (u.includes(field.key) ? u : [...u, field.key]))
    setInvalid((list) => list.filter((k) => k !== field.key))
  }

  const discard = () => {
    resetDraft()
    setError(null)
    setNotice(null)
  }

  /** 只清草稿，不动提示 —— 「应用预设」之后要用它把未保存修改丢掉。 */
  const resetDraft = () => {
    setDraft({})
    setUnset([])
    setInvalid([])
  }

  /** 字段 key → 控件类型。预设快照要按类型决定怎么处理空值。 */
  const fieldKinds = useMemo(() => fieldKindMap(state?.form?.groups ?? []), [state])

  /**
   * 参数预设的快照：**界面上当前这套参数**（草稿优先），只取宿主认定的预设字段。
   * 空数字按「未设置」回落、字符串空值保持原样 —— 规则与理由见 presetSnapshot.js。
   */
  const presetSnapshot = () =>
    buildPresetSnapshot({
      keys: state?.presets?.keys ?? [],
      kinds: fieldKinds,
      draft,
      config,
    })

  const act = async (name, fn, successMessage) => {
    setBusy(name)
    setError(null)
    setNotice(null)
    try {
      const result = await fn()
      if (!mounted.current) return
      setState(result)
      if (successMessage) setNotice(successMessage)
    } catch (err) {
      if (mounted.current) setError(err.message)
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  const save = () => {
    if (invalid.length > 0) {
      setError(`Some fields have an invalid format, please fix them first: ${invalid.join(', ')}`)
      return
    }
    void act(
      'save',
      async () => {
        const next = await saveConfig(draft, unset)
        setDraft({})
        setUnset([])
        setNotice('Settings saved; the model was unloaded with the new parameters and will be reloaded automatically on the next conversation')
        return next
      },
      null,
    )
  }

  if (!state) {
    return (
      <div style={S.wrap}>
        <h2 style={S.h2}>Local model</h2>
        <p style={S.lede}>{error ? 'Unable to connect to the local model plugin.' : 'Loading settings…'}</p>
        {error ? <div style={{ ...S.banner, ...S.error }}>{error}</div> : null}
      </div>
    )
  }

  const colors = STATE_COLORS[runtimeState] ?? STATE_COLORS.idle
  const isReady = runtimeState === 'ready'
  const busyAny = busy !== ''

  return (
    <div style={S.wrap}>
      <h2 style={S.h2}>Local model</h2>
      <p style={S.lede}>
        Runs models with the local llama.cpp: once you pick a model, the first conversation loads it automatically, and after {config.idleUnloadMinutes ?? 5}{' '}
        minutes without interaction it is unloaded automatically to free VRAM.
      </p>

      {error ? <div style={{ ...S.banner, ...S.error }}>{error}</div> : null}
      {notice ? <div style={{ ...S.banner, ...S.notice }}>{notice}</div> : null}
      {runtimeState === 'disabled' ? (
        <div style={{ ...S.banner, ...S.hint }}>The master switch is off: no port is listened on and no process is started.</div>
      ) : null}
      {/*
        视觉投影被 MTP 顶掉时说清楚原因。用户是「本来开了视觉投影、又开了 MTP」才走到这里，
        界面上视觉投影变空，不给理由就只会以为是插件坏了。
      */}
      {state.runtime.visionDisabledByMtp ? (
        <div style={{ ...S.banner, ...S.warn }}>{state.runtime.visionDisabledByMtp}</div>
      ) : null}

      {/*
        本次启动参数放在最顶部。
        它是这一页唯一能回答「现在到底跑在什么参数上」的地方，而换模型 / 调参数时最想看的
        就是它 —— 放在状态卡之后就意味着每次都要先滚过一张卡才看得到。
        数据来自宿主从**真实下发的 args** 解析出的报告，不是从配置读的。
      */}
      <LaunchPanel launch={state.runtime.launch} loadedAt={state.runtime.loadedAt} />

      {/*
        参数预设条固定在页面顶部（sticky）：它是这一页唯一「随时要用」的操作区 ——
        下面那几十项参数是用来调的，切换整套参数时不该还让用户滚回顶部去找按钮。
      */}
      <PresetBar
        presets={state.presets}
        dirtyCount={dirtyCount}
        invalid={invalid}
        busy={busy}
        busyAny={busyAny}
        snapshot={presetSnapshot}
        resetDraft={resetDraft}
        act={act}
      />

      <div style={S.card}>
        <div style={S.statusRow}>
          <span style={{ ...S.badge, color: colors.fg, background: colors.bg, borderColor: colors.border }}>
            <span style={{ ...S.dot, background: colors.fg }} />
            {state.runtime.stateLabel}
          </span>
          </div>
        <div style={S.metaGrid}>
          <div>
            <span style={S.metaLabel}>Current model: </span>
            {state.runtime.model ? `${state.runtime.model.displayName}${state.runtime.model.quant ? ` [${state.runtime.model.quant}]` : ''}` : 'Not selected'}
          </div>
          <div>
            <span style={S.metaLabel}>Process: </span>
            {state.runtime.pid ? `pid ${state.runtime.pid}` : 'Not running'}
          </div>
          <div>
            <span style={S.metaLabel}>Endpoint: </span>
            <span style={S.mono}>{state.runtime.endpoint}</span>
          </div>
          <div>
            <span style={S.metaLabel}>Total models: </span>
            {state.runtime.modelsFound}
          </div>
          <div>
            <span style={S.metaLabel}>Reasoning effort: </span>
            {Array.isArray(state.runtime.reasoningEfforts) && state.runtime.reasoningEfforts.length > 0 ? (
              /* 模型模板支持哪几档，决定对话框里选的档位最后会变成什么 —— 一眼可见最省事。 */
              <span style={S.mono}>{state.runtime.reasoningEfforts.join(' / ')} (remapped by template)</span>
            ) : (
              <span style={{ color: '#9a6209' }}>Not resolved; no effort is sent this run (thinking is controlled by the switch only)</span>
            )}
          </div>
          <div>
            <span style={S.metaLabel}>Multi-token prediction: </span>
            {state.runtime.mtp ? 'Enabled (--spec-type draft-mtp)' : 'Disabled'}
          </div>
          <div>
            <span style={S.metaLabel}>Vision projector: </span>
            {state.runtime.visionProjector ? (
              <span style={S.mono}>{state.runtime.visionProjector}</span>
            ) : state.runtime.visionDisabledByMtp ? (
              /* 开着 MTP 时这里恒为空，别让它显示成「纯文本」—— 那是另一回事。 */
              <span style={{ color: '#9a6209' }}>Configured, but overridden by MTP this run</span>
            ) : (
              'Not enabled (text only)'
            )}
          </div>
          {isReady && state.runtime.unloadAt ? (
            <div>
              <span style={S.metaLabel}>Auto-unload: </span>
              {new Date(state.runtime.unloadAt).toLocaleTimeString()}
            </div>
          ) : null}
        </div>
        {state.runtime.lastError ? (
          <div style={{ ...S.banner, ...S.error, marginTop: 12, marginBottom: 0 }}>{state.runtime.lastError}</div>
        ) : null}

        <div style={S.actions}>
          <button
            type="button"
            style={{ ...S.button, ...(busyAny ? S.buttonDisabled : {}) }}
            disabled={busyAny}
            onClick={() => void act('scan', () => runAction('scan'), 'Model directory rescanned')}
          >
            {busy === 'scan' ? 'Scanning…' : 'Rescan'}
          </button>
          <button
            type="button"
            style={{ ...S.button, ...(busyAny || isReady ? S.buttonDisabled : {}) }}
            disabled={busyAny || isReady}
            onClick={() => void act('start', () => runAction('start'), 'Model loaded')}
          >
            {busy === 'start' ? 'Loading…' : 'Load now'}
          </button>
          <button
            type="button"
            style={{ ...S.button, ...(busyAny || !isReady ? S.buttonDisabled : {}) }}
            disabled={busyAny || !isReady}
            onClick={() => void act('stop', () => runAction('stop'), 'Unloaded, VRAM freed')}
          >
            {busy === 'stop' ? 'Unloading…' : 'Unload'}
          </button>
          <button type="button" style={S.button} disabled={busyAny} onClick={() => void load({ silent: true })}>
            Refresh status
          </button>
        </div>
      </div>

      {state.form.groups.map((group) => (
        <div key={group.id} style={S.card}>
          <h3 style={S.groupTitle}>{group.title}</h3>
          {group.hint ? <p style={S.groupHint}>{group.hint}</p> : null}
          {group.fields.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={valueOf(field.key)}
              models={state.models}
              visionFiles={state.visionFiles ?? []}
              /* 读 draft：勾上 MTP 的瞬间就把视觉投影锁住，不用等保存。 */
              mtp={valueOf('mtp') === true}
              overridden={overridden.has(field.key) && !unset.includes(field.key) && !(field.key in draft)}
              invalid={invalid.includes(field.key)}
              onChange={(raw) => setValue(field, raw)}
              onRevert={() => revertField(field)}
            />
          ))}
        </div>
      ))}

      <div style={S.card}>
        <h3 style={S.groupTitle}>Directories</h3>
        <p style={S.groupHint}>
          Download llama-server from the llama.cpp releases page and put GGUF models into the model directory. Once done, come back here and click "Rescan".
        </p>
        <div style={{ ...S.metaGrid, marginTop: 0 }}>
          <div>
            <span style={S.metaLabel}>Model directory: </span>
            <span style={S.mono}>{state.form.paths.modelsDir}</span>
          </div>
          <div>
            <span style={S.metaLabel}>Runtime directory: </span>
            <span style={S.mono}>{state.form.paths.runtimeDir}</span>
          </div>
          <div>
            <span style={S.metaLabel}>User config: </span>
            <span style={S.mono}>{state.form.paths.configFile}</span>
          </div>
        </div>
      </div>

      <div style={S.footer}>
        <button
          type="button"
          style={{ ...S.buttonPrimary, ...(busyAny || dirtyCount === 0 || invalid.length > 0 ? S.buttonDisabled : {}) }}
          disabled={busyAny || dirtyCount === 0 || invalid.length > 0}
          onClick={save}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          style={{ ...S.button, ...(dirtyCount === 0 ? S.buttonDisabled : {}) }}
          disabled={dirtyCount === 0}
          onClick={discard}
        >
          Discard changes
        </button>
        <button
          type="button"
          style={{ ...S.button, ...(busyAny ? S.buttonDisabled : {}) }}
          disabled={busyAny}
          onClick={() => {
            if (window.confirm('Restore the deployment defaults? This clears all changes you made on this page.')) {
              void act('reset', () => resetConfig(), 'Defaults restored')
            }
          }}
        >
          {busy === 'reset' ? 'Restoring…' : 'Restore defaults'}
        </button>
        <span style={S.dirty}>{dirtyCount > 0 ? `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` : 'No unsaved changes'}</span>
      </div>
    </div>
  )
}

/**
 * 「本次启动参数」面板（设置页最顶部）。
 *
 * 三块内容，各自解决一个具体问题：
 *   1. **逐项一行的代码块** —— 看清*实际下发*了什么。注意它是从宿主侧的真实 args 来的，
 *      不是从设置页的草稿来的：两者之间隔着门控跳过、构建默认值与自动收敛；
 *   2. **参数摘要** —— 把关键数字挑出来（含派生的「GPU KV 合计」），省得在几十项里找；
 *   3. **提示与未识别项** —— 「有哪几项被这个构建跳过了」过去只躺在日志里；
 *      而识别表没覆盖到的选项宁可列出来，也不要让任何一项隐形（看不见的参数最危险）。
 */
function LaunchPanel({ launch, loadedAt }) {
  const [copied, setCopied] = useState('')
  const lines = Array.isArray(launch?.lines) ? launch.lines : []
  const facts = Array.isArray(launch?.facts) ? launch.facts : []
  const notices = Array.isArray(launch?.notices) ? launch.notices : []
  const unrecognized = Array.isArray(launch?.unrecognized) ? launch.unrecognized : []

  if (lines.length === 0) {
    return (
      <div style={S.card}>
        <p style={S.subTitle}>Launch parameters</p>
        <p style={S.groupHint}>
          The model is not loaded yet. Once loading finishes, this lists **all parameters actually sent to llama-server** for this run.
        </p>
      </div>
    )
  }

  // 按 group 分组，但保持报告里的出现顺序 —— 报告的顺序就是命令行的顺序。
  const groups = []
  for (const fact of facts) {
    let group = groups.find((item) => item.name === fact.group)
    if (!group) {
      group = { name: fact.group, items: [] }
      groups.push(group)
    }
    group.items.push(fact)
  }

  const when = loadedAt ? new Date(loadedAt).toLocaleTimeString() : ''
  const copy = () => {
    const text = launch.commandLine ?? lines.join('\n')
    const done = (ok) => {
      setCopied(ok ? 'Copied' : 'Copy failed')
      setTimeout(() => setCopied(''), 1500)
    }
    try {
      const pending = navigator.clipboard?.writeText(text)
      if (pending && typeof pending.then === 'function') pending.then(() => done(true), () => done(false))
      else done(false)
    } catch {
      done(false)
    }
  }

  return (
    <div style={S.card}>
      <div style={S.panelHead}>
        <p style={{ ...S.subTitle, margin: 0 }}>
          Launch parameters{when ? ` · ${when}` : ''}
          <span style={{ ...S.factNote, marginLeft: 8 }}>(all parameters the server actually received)</span>
        </p>
        <span style={S.panelHeadSpacer} />
        <button style={S.button} onClick={copy}>
          {copied || 'Copy command line'}
        </button>
      </div>

      <pre style={S.codeBlock}>{lines.join('\n')}</pre>

      {groups.length > 0 ? (
        <div style={S.factGrid}>
          {groups.flatMap((group) => [
            <div
              key={`group-${group.name}`}
              style={{ ...S.factLabel, gridColumn: '1 / -1', marginTop: 4, fontWeight: 500 }}
            >
              {group.name}
            </div>,
            ...group.items.map((fact, index) => (
              <div key={`${group.name}-${index}`} style={S.factCell}>
                <span style={S.factLabel}>{fact.label}</span>
                <span style={S.factValue}>{fact.value}</span>
                {fact.note ? <span style={S.factNote}>{fact.note}</span> : null}
              </div>
            )),
          ])}
        </div>
      ) : null}

      {notices.map((text, index) => (
        <div key={`notice-${index}`} style={{ ...S.banner, ...S.hint, marginTop: 12, marginBottom: 0 }}>
          {text}
        </div>
      ))}

      {unrecognized.length > 0 ? (
        <div style={{ ...S.banner, ...S.warn, marginTop: 12, marginBottom: 0 }}>
          These options are not recognized (they may come from "Extra arguments"): {unrecognized.join(', ')}
        </div>
      ) : null}
    </div>
  )
}

function Field({ field, value, models, visionFiles, overridden, invalid, mtp, onChange, onRevert }) {
  const isModelPicker = field.key === 'selectedModel'
  const isVisionPicker = field.key === 'mmprojFile'
  /**
   * MTP 与视觉投影互斥：勾上 MTP 之后这里直接锁住，而不是等保存后才由后端顶掉。
   * 「界面允许选、实际不下发」是最坏的一种体验 —— 用户会以为配置坏了。
   */
  const visionLockedByMtp = isVisionPicker && mtp === true

  const control = () => {
    if (isModelPicker) {
      return (
        <>
          <select style={S.select} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">(Not selected)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.complete}>
                {m.displayName}
                {m.quant ? ` · ${m.quant}` : ''}
                {m.params ? ` · ${m.params}` : ''} · {m.sizeText}
                {m.complete ? '' : '(incomplete shards)'}
                {m.hasVisionProjector ? ' · with vision projector' : ''}
              </option>
            ))}
          </select>
          {models.length === 0 ? (
            <div style={S.modelMeta}>
              No .gguf files in the model directory yet. Add models and click "Rescan" above.
            </div>
          ) : null}
        </>
      )
    }

    if (isVisionPicker) {
      const selected = typeof value === 'string' ? value.trim() : ''
      const missing = selected !== '' && !visionFiles.some((f) => f.id === selected)
      return (
        <>
          <select
            style={visionLockedByMtp ? { ...S.select, ...S.buttonDisabled } : S.select}
            disabled={visionLockedByMtp}
            value={selected}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">(Auto: links automatically when a file in the same directory can be uniquely matched)</option>
            {visionFiles.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} · {f.sizeText}
              </option>
            ))}
            {/* 手改配置写了个绝对路径、或文件已被移走时，也要把当前值显示出来，别让下拉框看起来「没选」。 */}
            {missing ? <option value={selected}>{selected} (not in scan results)</option> : null}
          </select>
          {/* 被 MTP 顶掉时，下面那些「自动 / 文件不存在」的提示全是噪音，一概不显示。 */}
          {visionLockedByMtp ? (
            <div style={{ ...S.modelMeta, color: '#9a6209', opacity: 1 }}>
              ⚠ "Multi-token prediction (MTP)" is enabled: MTP and image input cannot coexist, so --mmproj is not sent for this load.
              The file selected here is not cleared; it takes effect again once MTP is turned off. To use images, turn MTP off first.
            </div>
          ) : null}
          {!visionLockedByMtp && visionFiles.length === 0 ? (
            <div style={S.modelMeta}>
              No mmproj-*.gguf files in the model directory yet. If you need image input, put the vision projector file into the model directory and click "Rescan" above;
              text-only models can stay on "Auto".
            </div>
          ) : null}
          {!visionLockedByMtp && missing ? (
            <div style={{ ...S.modelMeta, color: '#b02525', opacity: 1 }}>
              ⚠ The selected file is no longer in the model directory (or cannot be read). It will be ignored on load or cause a --mmproj error; please select again.
            </div>
          ) : null}
          {!visionLockedByMtp && !missing && selected === '' && visionFiles.length > 0 ? (
            <div style={S.modelMeta}>
              Currently "Auto": only an mmproj in the same directory as the model, with unambiguous ownership, is loaded together with the model.
            </div>
          ) : null}
        </>
      )
    }

    switch (field.kind) {
      case 'boolean':
        return (
          <div style={S.checkboxRow}>
            <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            <span style={{ fontSize: 12, opacity: 0.7 }}>{value === true ? 'On' : 'Off'}</span>
          </div>
        )
      case 'number':
        return (
          <input
            type="number"
            style={S.input}
            value={value === undefined || value === null ? '' : String(value)}
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      case 'select':
        return (
          <select style={S.select} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )
      case 'text':
        return (
          <textarea
            style={{ ...S.textarea, ...(invalid ? { borderColor: 'rgba(176,37,37,0.6)' } : {}) }}
            value={typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      default:
        return <input type="text" style={S.input} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    }
  }

  return (
    <div style={S.field}>
      <div style={S.label}>
        <span>{field.label}</span>
        {overridden ? <span style={S.overridden}>Overridden</span> : null}
      </div>
      <div>{control()}</div>
      <button
        type="button"
        title="Restore to default"
        style={{ ...S.button, fontSize: 11, lineHeight: '22px', padding: '0 8px' }}
        onClick={onRevert}
      >
        Default
      </button>
      <div style={{ ...S.desc, ...(invalid ? { color: '#b02525', opacity: 1 } : {}) }}>
        {invalid ? 'Invalid JSON format, saving is blocked: ' : ''}
        {field.description}
      </div>
    </div>
  )
}
