import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatMcuTemp,
  MCU_TEMP_CRIT_C,
  MCU_TEMP_WARN_C,
  tempLevel,
} from '../src/shared/temperature.js';

test('温度分级对齐船端 trip point：70 °C 黄、90 °C 红', () => {
  assert.equal(tempLevel(48.4), 'ok');
  assert.equal(tempLevel(MCU_TEMP_WARN_C - 0.1), 'ok');
  assert.equal(tempLevel(MCU_TEMP_WARN_C), 'warn');
  assert.equal(tempLevel(MCU_TEMP_CRIT_C - 0.1), 'warn');
  assert.equal(tempLevel(MCU_TEMP_CRIT_C), 'crit');
});

test('温度文案与配色类', () => {
  assert.deepEqual(formatMcuTemp(null), { text: '—', cls: '' });
  assert.deepEqual(formatMcuTemp(48.44), { text: '48.4 °C', cls: '' });
  assert.deepEqual(formatMcuTemp(75.2), { text: '75.2 °C · 偏高', cls: 't-warn' });
  assert.deepEqual(formatMcuTemp(93), { text: '93.0 °C · 过热', cls: 't-bad' });
});
