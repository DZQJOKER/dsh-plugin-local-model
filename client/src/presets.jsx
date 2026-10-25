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
      `Preset "${label}" saved`,
    )
  }

  const doApply = (preset) => {
    if (busyAny) return
    if (dirtyCount > 0 && !window.confirm(`Applying the preset discards your current ${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}. Continue?`)) return
    void act(
      'preset:apply',
      async () => {
        const next = await applyPreset(preset.id)
        // 预设已经落盘，界面上的草稿就没意义了；留着只会显示「还有 N 项未保存」。
        resetDraft()
        setLastId(preset.id)
        return next
      },
      `Preset "${preset.name}" applied`,
    )
  }

  const doOverwrite = (preset) => {
    if (busyAny) return
    void act(
      'preset:overwrite',
      () => overwritePreset(preset.id, snapshot()),
      `Preset "${preset.name}" updated with the current parameters`,
    )
  }

  const doRename = (preset) => {
    if (busyAny) return
    const input = window.prompt('Preset name', preset.name)
    if (input === null) return
    const next = input.trim()
    if (next === '' || next === preset.name) return
    void act('preset:rename', () => renamePreset(preset.id, next), `Preset renamed to "${next}"`)
  }

  const doRemove = (preset) => {
    if (busyAny) return
    const ok = window.confirm(`Delete preset "${preset.name}"?\n\nOnly this parameter set is removed; the currently active settings are not affected.`)
    if (!ok) return
    void act(
      'preset:delete',
      async () => {
        const next = await deletePreset(preset.id)
        if (lastId === preset.id) setLastId(null)
        return next
      },
      `Preset "${preset.name}" deleted`,
    )
  }

  return (
    <div style={{ ...S.card, ...S.cardPinned }}>
      <h3 style={S.groupTitle}>Parameter presets</h3>
      <p style={S.groupHint}>
        Save the current full set of loading and inference parameters as a named preset and switch with one click — clicking a preset name applies it (the model is reloaded with the new parameters).
        Machine-specific settings such as ports, paths, and keys ({excludedCount} in total) are not part of presets and stay unchanged when switching.
      </p>

      {presets?.warning ? <div style={{ ...S.banner, ...S.warn, marginBottom: 10 }}>{presets.warning}</div> : null}

      {items.length === 0 ? (
        <p style={S.modelMeta}>
          No presets yet. Once you have tuned the parameters to your liking, enter a name below and click "Save as preset"; you can switch back with one click anytime.
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
                    `Apply "${preset.name}": ${preset.fieldCount} parameters in total` +
                    (preset.changed > 0 ? `, ${preset.changed} differ from current` : ' (identical to current)')
                  }
                  onClick={() => doApply(preset)}
                >
                  {preset.name}
                  <span style={S.chipMeta}>{preset.changed > 0 ? `${preset.changed} differ` : 'active'}</span>
                </button>
                <button type="button" style={S.chipIcon} disabled={busyAny} title="Rename" onClick={() => doRename(preset)}>
                  ✎
                </button>
                <button type="button" style={S.chipIcon} disabled={busyAny} title="Delete this preset" onClick={() => doRemove(preset)}>
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
          placeholder="Preset name, e.g.: vision / long context / low VRAM"
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
          {busy === 'preset:save' ? 'Saving…' : 'Save as preset'}
        </button>
        {lastPreset ? (
          <button
            type="button"
            style={{ ...S.button, ...(busyAny ? S.buttonDisabled : {}) }}
            disabled={busyAny}
            title="Write the current on-screen parameters back to this preset (name unchanged)"
            onClick={() => doOverwrite(lastPreset)}
          >
            Update "{lastPreset.name}" with current parameters
          </button>
        ) : null}
      </div>

      <div style={S.modelMeta}>
        What is saved is the current on-screen parameter set
        {dirtyCount > 0 ? ` (including ${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}, stored in the preset as well)` : ' (identical to the saved settings)'};
        empty number fields are treated as "not set" and never written as 0.
      </div>
      {presets?.file ? (
        <div style={S.modelMeta}>
          Preset file: <span style={S.mono}>{presets.file}</span>
        </div>
      ) : null}
      {invalid.length > 0 ? (
        <div style={{ ...S.banner, ...S.error, marginTop: 10, marginBottom: 0 }}>
          Some fields have an invalid format ({invalid.join(', ')}); fix them before saving the preset.
        </div>
      ) : null}
    </div>
  )
}
