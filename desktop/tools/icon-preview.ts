/**
 * 图标预览页（仅开发用，不打包进应用）。
 *   npm run icons   →  dist-test/icons/preview.html
 */
import {
  XBOX_ICON_CSS,
  XBOX_ICON_NAMES,
  xboxIcon,
  type XboxIconName,
} from '../src/renderer/icons/xbox.js';

const LABELS: Array<{ group: string; items: Array<[XboxIconName, string]> }> = [
  {
    group: '面板按键（Xbox 官方字形）',
    items: [
      ['a', 'A'],
      ['b', 'B'],
      ['x', 'X'],
      ['y', 'Y'],
      ['view', 'View'],
      ['menu', 'Menu'],
      ['guide', 'Xbox 徽标'],
    ],
  },
  {
    group: '摇杆与方向键',
    items: [
      ['dpad', '十字键'],
      ['dpadUp', '十字键 上'],
      ['dpadDown', '十字键 下'],
      ['stickL', '左摇杆'],
      ['stickR', '右摇杆'],
      ['stickPress', '摇杆按下'],
    ],
  },
  {
    group: '肩键与扳机',
    items: [
      ['lb', 'LB'],
      ['rb', 'RB'],
      ['lt', 'LT'],
      ['rt', 'RT'],
    ],
  },
  {
    group: '手柄',
    items: [['controller', '手柄轮廓']],
  },
];

const SIZES = [40, 32, 24, 16];

const style = document.createElement('style');
style.textContent = `
:root {
  --bg: #0b1016;
  --panel: #121a24;
  --line: #22303f;
  --text: #dbe6f2;
  --muted: #7f90a5;
  --accent: #4cc2ff;
  --ok: #2ecc71;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 28px;
  background: var(--bg); color: var(--text);
  font: 14px/1.5 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
}
h1 { font-size: 16px; letter-spacing: .04em; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 12px; margin: 0 0 22px; }
h2 { font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
     color: var(--muted); margin: 22px 0 10px; font-weight: 600; }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 14px 10px 8px; min-width: 94px;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.card .name { font: 11px/1 Consolas, monospace; color: var(--muted); }
.sizes { display: flex; align-items: flex-end; gap: 8px; }
.sizes > * { display: block; }
.tint { color: var(--accent); }
.ok { color: var(--ok); }
.xbx { display: block; }
${XBOX_ICON_CSS}
`;
document.head.appendChild(style);

const root = document.createElement('div');
document.body.appendChild(root);

root.insertAdjacentHTML(
  'beforeend',
  `<h1>Xbox 手柄图标 · 简约线条</h1>
   <p class="sub">${XBOX_ICON_NAMES.length} 个图标 · viewBox 24×24 · 按键=微软官方字形 · 摇杆=自绘线条</p>`,
);

for (const { group, items } of LABELS) {
  const cards = items
    .map(([name, label]) => {
      const variants = SIZES.map((s) => xboxIcon(name, { size: s })).join('');
      return `<div class="card">
        <div class="sizes">${variants}</div>
        <div class="name">${label}</div>
        <div class="name" style="opacity:.5">${name}</div>
      </div>`;
    })
    .join('');
  root.insertAdjacentHTML(
    'beforeend',
    `<h2>${group}</h2><div class="row">${cards}</div>`,
  );
}

// 换色验证：currentColor 是否真的跟随外层颜色
const tinted = (['a', 'stickL', 'lt', 'controller'] as XboxIconName[])
  .map(
    (n) =>
      `<div class="card"><div class="tint">${xboxIcon(n, { size: 36 })}</div>` +
      `<div class="ok">${xboxIcon(n, { size: 24 })}</div>` +
      `<div class="name">${n}</div></div>`,
  )
  .join('');

root.insertAdjacentHTML(
  'beforeend',
  `<h2>换色验证（蓝=color:accent，绿=color:ok）</h2><div class="row">${tinted}</div>`,
);

// 尺寸一览：确认 16px 下仍然可辨
const strip = (XBOX_ICON_NAMES as XboxIconName[])
  .map(
    (n) => `<div class="card" style="min-width:70px">
      <div style="display:flex;gap:6px;align-items:center">
        ${xboxIcon(n, { size: 16 })}${xboxIcon(n, { size: 20 })}
      </div>
      <div class="name">${n}</div></div>`,
  )
  .join('');
root.insertAdjacentHTML(
  'beforeend',
  `<h2>全部图标 · 16 / 20 px</h2><div class="row">${strip}</div>`,
);

// 映射说明示例：以后控件图例大概长这样
root.insertAdjacentHTML(
  'beforeend',
  `<h2>实际用法示例</h2>
   <div class="card" style="align-items:stretch;min-width:0;width:100%;gap:6px;padding:14px">
     <div style="display:flex;align-items:center;gap:8px;font-size:13px">
       ${xboxIcon('stickL', { size: 18 })}<span>左摇杆</span>
       <span style="color:var(--muted)">前后 = 油门 · 左右 = 舵角</span>
     </div>
     <div style="display:flex;align-items:center;gap:8px;font-size:13px">
       ${xboxIcon('a', { size: 18 })}<span>A</span>
       <span style="color:var(--muted)">解锁 / 撤防</span>
     </div>
     <div style="display:flex;align-items:center;gap:8px;font-size:13px">
       ${xboxIcon('b', { size: 18 })}<span>B</span>
       <span style="color:var(--muted)">急停</span>
     </div>
   </div>`,
);
