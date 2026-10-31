/**
 * 船端 SoC（MCU）温度的分级与展示。
 *
 * 阈值取自船端内核 DTS 的 thermal trip point，而不是随意拍脑袋：
 * 实机（Orange Pi Zero2W / H618）`/sys/class/thermal/thermal_zone0/trip_point_*_temp`
 * 给出 70000 = passive 开始降频、90000 = 二次降频、115000 = critical 关机。
 * 固件自身的设计目标是 SoC ≤ 62 °C（见 docs/firmware-spec.md §1），
 * 所以 70 °C 才标黄已经是最宽松的取法——到这一步 50Hz 控制节拍随时可能失守。
 */

/** ≥ 此温度开始降频（黄） */
export const MCU_TEMP_WARN_C = 70;
/** ≥ 此温度二次降频（红），再往上 115 °C 触发保护关机 */
export const MCU_TEMP_CRIT_C = 90;

export type TempLevel = 'ok' | 'warn' | 'crit';

export function tempLevel(c: number): TempLevel {
  if (c >= MCU_TEMP_CRIT_C) return 'crit';
  if (c >= MCU_TEMP_WARN_C) return 'warn';
  return 'ok';
}

/** 状态栏文案 + CSS 类：正常 `48.5 °C`，偏高/过热时追加说明 */
export function formatMcuTemp(c: number | null): { text: string; cls: string } {
  if (c == null) return { text: '—', cls: '' };
  const level = tempLevel(c);
  return {
    text: `${c.toFixed(1)} °C${level === 'crit' ? ' · 过热' : level === 'warn' ? ' · 偏高' : ''}`,
    cls: level === 'crit' ? 't-bad' : level === 'warn' ? 't-warn' : '',
  };
}
