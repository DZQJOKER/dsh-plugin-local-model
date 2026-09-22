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
      setError(`有字段格式不对，请先修正：${invalid.join('、')}`)
      return
    }
    void act(
      'save',
      async () => {
        const next = await saveConfig(draft, unset)
        setDraft({})
        setUnset([])
        setNotice('设置已保存；模型已按新参数卸载，下次对话会自动重新加载')
        return next
      },
      null,
    )
  }

  if (!state) {
    return (
      <div style={S.wrap}>
        <h2 style={S.h2}>本地模型</h2>
        <p style={S.lede}>{error ? '无法连接到本地模型插件。' : '正在读取配置…'}</p>
        {error ? <div style={{ ...S.banner, ...S.error }}>{error}</div> : null}
      </div>
    )
  }

  const colors = STATE_COLORS[runtimeState] ?? STATE_COLORS.idle
  const isReady = runtimeState === 'ready'
  const busyAny = busy !== ''

  return (
    <div style={S.wrap}>
      <h2 style={S.h2}>本地模型</h2>
      <p style={S.lede}>
        用本机的 llama.cpp 跑模型：选定模型后，第一条对话会自动加载，连续 {config.idleUnloadMinutes ?? 5}{' '}
        分钟无交互会自动卸载并释放显存。
      </p>

      {error ? <div style={{ ...S.banner, ...S.error }}>{error}</div> : null}
      {notice ? <div style={{ ...S.banner, ...S.notice }}>{notice}</div> : null}
      {runtimeState === 'disabled' ? (
        <div style={{ ...S.banner, ...S.hint }}>总开关已关闭：不会监听端口，也不会拉起任何进程。</div>
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
            <span style={S.metaLabel}>当前模型：</span>
            {state.runtime.model ? `${state.runtime.model.displayName}${state.runtime.model.quant ? ` [${state.runtime.model.quant}]` : ''}` : '未选择'}
          </div>
          <div>
            <span style={S.metaLabel}>进程：</span>
            {state.runtime.pid ? `pid ${state.runtime.pid}` : '未运行'}
          </div>
          <div>
            <span style={S.metaLabel}>入口：</span>
            <span style={S.mono}>{state.runtime.endpoint}</span>
          </div>
          <div>
            <span style={S.metaLabel}>模型总数：</span>
            {state.runtime.modelsFound}
          </div>
          <div>
            <span style={S.metaLabel}>推理档位：</span>
            {Array.isArray(state.runtime.reasoningEfforts) && state.runtime.reasoningEfforts.length > 0 ? (
              /* 模型模板支持哪几档，决定对话框里选的档位最后会变成什么 —— 一眼可见最省事。 */
              <span style={S.mono}>{state.runtime.reasoningEfforts.join(' / ')}（按模板重映射）</span>
            ) : (
              <span style={{ color: '#9a6209' }}>未解析出，本次不下发档位（只按开关控制思考与否）</span>
            )}
          </div>
          <div>
            <span style={S.metaLabel}>多 Token 预测：</span>
            {state.runtime.mtp ? '已开启（--spec-type draft-mtp）' : '已关闭'}
          </div>
          <div>
            <span style={S.metaLabel}>视觉投影：</span>
            {state.runtime.visionProjector ? (
              <span style={S.mono}>{state.runtime.visionProjector}</span>
            ) : state.runtime.visionDisabledByMtp ? (
              /* 开着 MTP 时这里恒为空，别让它显示成「纯文本」—— 那是另一回事。 */
              <span style={{ color: '#9a6209' }}>已配置，但本次被 MTP 顶掉</span>
            ) : (
              '未启用（纯文本）'
            )}
          </div>
          {isReady && state.runtime.unloadAt ? (
            <div>
              <span style={S.metaLabel}>自动卸载：</span>
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
            onClick={() => void act('scan', () => runAction('scan'), '已重新扫描模型目录')}
          >
            {busy === 'scan' ? '扫描中…' : '重新扫描'}
          </button>
          <button
            type="button"
            style={{ ...S.button, ...(busyAny || isReady ? S.buttonDisabled : {}) }}
            disabled={busyAny || isReady}
            onClick={() => void act('start', () => runAction('start'), '模型已加载')}
          >
            {busy === 'start' ? '加载中…' : '立即加载'}
          </button>
          <button
            type="button"
            style={{ ...S.button, ...(busyAny || !isReady ? S.buttonDisabled : {}) }}
            disabled={busyAny || !isReady}
            onClick={() => void act('stop', () => runAction('stop'), '已卸载，显存已释放')}
          >
            {busy === 'stop' ? '卸载中…' : '卸载'}
          </button>
          <button type="button" style={S.button} disabled={busyAny} onClick={() => void load({ silent: true })}>
            刷新状态
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
        <h3 style={S.groupTitle}>目录约定</h3>
        <p style={S.groupHint}>
          自己去 llama.cpp 的 release 页面下载 llama-server，把 GGUF 模型放进模型目录。放好后回到这里点「重新扫描」。
        </p>
        <div style={{ ...S.metaGrid, marginTop: 0 }}>
          <div>
            <span style={S.metaLabel}>模型目录：</span>
            <span style={S.mono}>{state.form.paths.modelsDir}</span>
          </div>
          <div>
            <span style={S.metaLabel}>运行时目录：</span>
            <span style={S.mono}>{state.form.paths.runtimeDir}</span>
          </div>
          <div>
            <span style={S.metaLabel}>用户配置：</span>
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
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          style={{ ...S.button, ...(dirtyCount === 0 ? S.buttonDisabled : {}) }}
          disabled={dirtyCount === 0}
          onClick={discard}
        >
          放弃修改
        </button>
        <button
          type="button"
          style={{ ...S.button, ...(busyAny ? S.buttonDisabled : {}) }}
          disabled={busyAny}
          onClick={() => {
            if (window.confirm('恢复为部署默认值？这会清空你在这个页面上做过的所有修改。')) {
              void act('reset', () => resetConfig(), '已恢复默认值')
            }
          }}
        >
          {busy === 'reset' ? '恢复中…' : '恢复默认'}
        </button>
        <span style={S.dirty}>{dirtyCount > 0 ? `有 ${dirtyCount} 项未保存` : '没有未保存的修改'}</span>
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
        <p style={S.subTitle}>本次启动参数</p>
        <p style={S.groupHint}>
          模型尚未加载。加载完成后，这里会列出本次**真正下发给 llama-server** 的全部参数。
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
      setCopied(ok ? '已复制' : '复制失败')
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
          本次启动参数{when ? ` · ${when}` : ''}
          <span style={{ ...S.factNote, marginLeft: 8 }}>（服务器实际收到的全部参数）</span>
        </p>
        <span style={S.panelHeadSpacer} />
        <button style={S.button} onClick={copy}>
          {copied || '复制命令行'}
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
          这几个选项不在识别表里（可能来自「附加参数」）：{unrecognized.join('、')}
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
            <option value="">（未选择）</option>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.complete}>
                {m.displayName}
                {m.quant ? ` · ${m.quant}` : ''}
                {m.params ? ` · ${m.params}` : ''} · {m.sizeText}
                {m.complete ? '' : '（分片不完整）'}
                {m.hasVisionProjector ? ' · 含视觉投影' : ''}
              </option>
            ))}
          </select>
          {models.length === 0 ? (
            <div style={S.modelMeta}>
              模型目录里还没有 .gguf 文件。把模型放进去后点上面的「重新扫描」。
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
            <option value="">（自动：同目录能唯一确定归属时自动关联）</option>
            {visionFiles.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} · {f.sizeText}
              </option>
            ))}
            {/* 手改配置写了个绝对路径、或文件已被移走时，也要把当前值显示出来，别让下拉框看起来「没选」。 */}
            {missing ? <option value={selected}>{selected}（不在扫描结果里）</option> : null}
          </select>
          {/* 被 MTP 顶掉时，下面那些「自动 / 文件不存在」的提示全是噪音，一概不显示。 */}
          {visionLockedByMtp ? (
            <div style={{ ...S.modelMeta, color: '#9a6209', opacity: 1 }}>
              ⚠ 已开启「多 Token 预测（MTP）」：MTP 与图像输入不能共存，本次加载不会下发 --mmproj。
              这里选的文件不会被清空，关掉 MTP 即恢复生效；需要看图请先关掉 MTP。
            </div>
          ) : null}
          {!visionLockedByMtp && visionFiles.length === 0 ? (
            <div style={S.modelMeta}>
              模型目录里还没有 mmproj-*.gguf。需要图像输入时把视觉投影文件放进模型目录，再点上面的「重新扫描」；
              纯文本模型保持「自动」即可。
            </div>
          ) : null}
          {!visionLockedByMtp && missing ? (
            <div style={{ ...S.modelMeta, color: '#b02525', opacity: 1 }}>
              ⚠ 选中的文件已不在模型目录里（或无权限读取）。加载时会被忽略或导致 --mmproj 报错，请重新选择。
            </div>
          ) : null}
          {!visionLockedByMtp && !missing && selected === '' && visionFiles.length > 0 ? (
            <div style={S.modelMeta}>
              当前是「自动」：只有与模型同目录、且能唯一确定归属的 mmproj 才会随模型一起加载。
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
            <span style={{ fontSize: 12, opacity: 0.7 }}>{value === true ? '开启' : '关闭'}</span>
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
        {overridden ? <span style={S.overridden}>已覆盖</span> : null}
      </div>
      <div>{control()}</div>
      <button
        type="button"
        title="恢复为默认值"
        style={{ ...S.button, fontSize: 11, lineHeight: '22px', padding: '0 8px' }}
        onClick={onRevert}
      >
        默认
      </button>
      <div style={{ ...S.desc, ...(invalid ? { color: '#b02525', opacity: 1 } : {}) }}>
        {invalid ? 'JSON 格式不对，保存会被阻止：' : ''}
        {field.description}
      </div>
    </div>
  )
}
