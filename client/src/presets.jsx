import { useState } from 'react'

import { applyPreset, deletePreset, overwritePreset, renamePreset, savePreset } from './api.js'
import { S } from './styles.js'

/**
 * 「参数预设」条 —— 设置在设置页最上面，是这一页唯一常驻的操作区。
 *
 * 定位：把一整套加载/推理参数（含选中的模型与视觉投影）存成一个带名字的条目，
 * 之后一键切换。数据全部来自宿主 `/state` 的 `presets` 字段，这里只做渲染与提交。
 *
 * 三个刻意的取舍：
 *   1. **应用预设会丢弃未保存的草稿** —— 这是真实的破坏性操作，所以先弹一次确认，
 *      再在成功之后清空草稿；否则界面上会留着一堆「未保存」的假象。
 *   2. **保存的是界面上当前这套参数**（含未保存的修改），而不是磁盘上那一份 ——
 *      用户的意思就是「我调好的这套」。空着的数字项按「未填」处理，回落到已保存的值。
 *   3. 重命名/删除沿用项目既有的 `window.prompt` / `window.confirm` 风格，不引入弹窗组件。
 */
export function PresetBar({ presets, dirtyCount, invalid, busy, busyAny, snapshot, resetDraft, act }) {
  const [name, setName] = useState('')
  /** 本次会话里最后一次应用的预设：用它决定「用当前参数更新」指向谁。 */
  const [lastId, setLastId] = useState(null)

  const items = presets?.items ?? []
  const excludedCount = (presets?.excluded ?? []).length
  const activeId = presets?.activeId ?? null
  const lastPreset = items.find((item) => item.id === lastId) ?? null

  const label = name.trim()
  const canSave = !busyAny && label.length > 0 && invalid.length === 0

  const doSave = () => {
    if (!canSave) return
    void act(
      'preset:save',
      async () => {
        const next = await savePreset(label, snapshot())
        setName('')
        setLastId(null)
        return next
      },
      `已保存预设「${label}」`,
    )
  }

  const doApply = (preset) => {
    if (busyAny) return
    if (dirtyCount > 0 && !window.confirm(`应用预设会丢弃当前未保存的 ${dirtyCount} 项修改，继续？`)) return
    void act(
      'preset:apply',
      async () => {
        const next = await applyPreset(preset.id)
        // 预设已经落盘，界面上的草稿就没意义了；留着只会显示「还有 N 项未保存」。
        resetDraft()
        setLastId(preset.id)
        return next
      },
      `已应用预设「${preset.name}」`,
    )
  }

  const doOverwrite = (preset) => {
    if (busyAny) return
    void act(
      'preset:overwrite',
      () => overwritePreset(preset.id, snapshot()),
      `已用当前参数更新预设「${preset.name}」`,
    )
  }

  const doRename = (preset) => {
    if (busyAny) return
    const input = window.prompt('预设名称', preset.name)
    if (input === null) return
    const next = input.trim()
    if (next === '' || next === preset.name) return
    void act('preset:rename', () => renamePreset(preset.id, next), `预设已重命名为「${next}」`)
  }

  const doRemove = (preset) => {
    if (busyAny) return
    const ok = window.confirm(`删除预设「${preset.name}」？\n\n只删掉这组参数，当前生效的设置不受影响。`)
    if (!ok) return
    void act(
      'preset:delete',
      async () => {
        const next = await deletePreset(preset.id)
        if (lastId === preset.id) setLastId(null)
        return next
      },
      `已删除预设「${preset.name}」`,
    )
  }

  return (
    <div style={{ ...S.card, ...S.cardPinned }}>
      <h3 style={S.groupTitle}>参数预设</h3>
      <p style={S.groupHint}>
        把当前这一整套加载与推理参数存成带名字的预设，之后一键切换 —— 点预设名即应用（模型会按新参数重新加载）。
        端口、路径、密钥等 {excludedCount} 项「属于这台机器」的设置不进预设，切换时保持原样。
      </p>

      {presets?.warning ? <div style={{ ...S.banner, ...S.warn, marginBottom: 10 }}>{presets.warning}</div> : null}

      {items.length === 0 ? (
        <p style={S.modelMeta}>
          还没有预设。把参数调到满意之后，在下面输入一个名字点「保存为预设」；以后随时能一键切回来。
        </p>
      ) : (
        <div style={S.chipRow}>
          {items.map((preset) => {
            const isActive = preset.id === activeId
            return (
              <span key={preset.id} style={{ ...S.chip, ...(isActive ? S.chipActive : {}) }}>
                <button
                  type="button"
                  style={{ ...S.chipLabel, ...(busyAny ? S.buttonDisabled : {}) }}
                  disabled={busyAny}
                  title={
                    `应用「${preset.name}」：共 ${preset.fieldCount} 项参数` +
                    (preset.changed > 0 ? `，与当前有 ${preset.changed} 项不同` : '（与当前完全一致）')
                  }
                  onClick={() => doApply(preset)}
                >
                  {preset.name}
                  <span style={S.chipMeta}>{preset.changed > 0 ? `${preset.changed} 项不同` : '当前生效'}</span>
                </button>
                <button type="button" style={S.chipIcon} disabled={busyAny} title="重命名" onClick={() => doRename(preset)}>
                  ✎
                </button>
                <button type="button" style={S.chipIcon} disabled={busyAny} title="删除这个预设" onClick={() => doRemove(preset)}>
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}

      <div style={S.presetRow}>
        <input
          type="text"
          style={{ ...S.input, width: 'auto', flex: '1 1 220px' }}
          placeholder="预设名称，例如：看图 / 长文本 / 省显存"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doSave()
          }}
        />
        <button
          type="button"
          style={{ ...S.buttonPrimary, ...(canSave ? {} : S.buttonDisabled) }}
          disabled={!canSave}
          onClick={doSave}
        >
          {busy === 'preset:save' ? '保存中…' : '保存为预设'}
        </button>
        {lastPreset ? (
          <button
            type="button"
            style={{ ...S.button, ...(busyAny ? S.buttonDisabled : {}) }}
            disabled={busyAny}
            title="把界面上当前这套参数写回这个预设（名称不变）"
            onClick={() => doOverwrite(lastPreset)}
          >
            用当前参数更新「{lastPreset.name}」
          </button>
        ) : null}
      </div>

      <div style={S.modelMeta}>
        保存的是界面上当前这套参数
        {dirtyCount > 0 ? `（含 ${dirtyCount} 项还没保存的修改，一并存进预设）` : '（与已保存的设置一致）'}；
        没填的数字项按「不设置」处理，不会写成 0。
      </div>
      {presets?.file ? (
        <div style={S.modelMeta}>
          预设文件：<span style={S.mono}>{presets.file}</span>
        </div>
      ) : null}
      {invalid.length > 0 ? (
        <div style={{ ...S.banner, ...S.error, marginTop: 10, marginBottom: 0 }}>
          有字段格式不对（{invalid.join('、')}），先修正再保存预设。
        </div>
      ) : null}
    </div>
  )
}
