/**
 * 手柄菜单导航（Menu 键进入 / B 键退出）。
 *
 * 设计取向：
 *   - 用**空间邻近**而不是列表顺序找下一个焦点，摇杆往哪推就往哪走，符合直觉
 *   - 焦点环是独立 CSS 类，不依赖 :focus，避免和鼠标焦点打架
 *   - 进入菜单时**必须**把左摇杆从油门/舵角上摘下来（安全第一），
 *     由调用方在 `onModeChange` 里把控制量归零
 */

const FOCUSABLE =
  'button:not([disabled]), select, input, summary, [data-nav]';

/** 视线锥：垂直偏移超过这个比例就不再算「正前方」，避免跨栏乱跳 */
const CONE_SLOPE = 2.5;
const CONE_BASE_PX = 200;

interface Dir {
  x: number;
  y: number;
}

export interface NavOptions {
  /** 进入/退出菜单时回调；进入时应把油门舵角归零 */
  onModeChange?: (active: boolean) => void;
}

export class PadMenu {
  private active = false;
  private current: HTMLElement | null = null;
  private root: HTMLElement;
  /** 摇杆重复触发：先等这么久，再按间隔连发 */
  private repeatDelayMs = 320;
  private repeatEveryMs = 150;
  private heldDir: Dir = { x: 0, y: 0 };
  private holdSince = 0;
  private lastRepeat = 0;

  constructor(root: HTMLElement, private readonly opts: NavOptions = {}) {
    this.root = root;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Menu 键 / 菜单按钮：切换 */
  toggle(): void {
    this.setActive(!this.active);
  }

  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    this.heldDir = { x: 0, y: 0 };
    this.opts.onModeChange?.(on);
    if (on) {
      this.focusFirst();
    } else {
      this.clearFocus();
    }
  }

  /** B 键：退出并回到默认控制 */
  exit(): void {
    this.setActive(false);
  }

  /** A 键：点击当前焦点 */
  activate(): void {
    const el = this.current;
    if (!el) return;
    if (el instanceof HTMLSelectElement) {
      // <select> 无法用代码弹出原生下拉，交给方向键改值
      return;
    }
    el.click();
  }

  /** 左摇杆 / 十字键：按空间方向移动焦点 */
  move(x: number, y: number, nowMs: number): void {
    if (!this.active) return;
    const dir: Dir = { x: Math.sign(x), y: Math.sign(y) };
    if (dir.x === 0 && dir.y === 0) {
      this.heldDir = dir;
      return;
    }
    const same = dir.x === this.heldDir.x && dir.y === this.heldDir.y;
    if (!same) {
      this.heldDir = dir;
      this.holdSince = nowMs;
      this.lastRepeat = nowMs;
      this.step(dir);
      return;
    }
    // 保持同方向：等过初始延迟后按间隔连发
    if (nowMs - this.holdSince < this.repeatDelayMs) return;
    if (nowMs - this.lastRepeat < this.repeatEveryMs) return;
    this.lastRepeat = nowMs;
    this.step(dir);
  }

  /** <select> 用左右改变选项 */
  adjust(delta: number): void {
    const el = this.current;
    if (el instanceof HTMLSelectElement) {
      const next = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + delta));
      if (next !== el.selectedIndex) {
        el.selectedIndex = next;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    // 其它控件忽略
  }

  /* ---------------- 内部 ---------------- */

  private candidates(): HTMLElement[] {
    const all = Array.from(this.root.querySelectorAll<HTMLElement>(FOCUSABLE));
    return all.filter((el) => {
      if (el === this.current) return true;
      if (el.hasAttribute('disabled')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      // 被滚动容器裁掉的不算
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    });
  }

  private focusFirst(): void {
    const list = this.candidates();
    if (list.length === 0) {
      this.setFocus(null);
      return;
    }
    // 默认落在**最右一栏的顶端**：右栏是操作区（重连 / 固件 / 清空），
    // 左栏除了量程下拉基本都是只读显示，默认停在那儿只会让第一步还要先跨栏。
    let bestCol: Element | null = null;
    let bestRight = -Infinity;
    for (const el of list) {
      const col = columnOf(el);
      if (!col) continue;
      const right = col.getBoundingClientRect().right;
      if (right > bestRight) {
        bestRight = right;
        bestCol = col;
      }
    }
    const pool = bestCol ? list.filter((el) => columnOf(el) === bestCol) : list;
    pool.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    this.setFocus(pool[0] ?? list[0]);
  }

  private clearFocus(): void {
    this.current?.classList.remove('nav-focus');
    this.current = null;
  }

  private setFocus(el: HTMLElement | null): void {
    if (this.current === el) return;
    this.current?.classList.remove('nav-focus');
    this.current = el;
    if (el) {
      el.classList.add('nav-focus');
      // 让焦点进入可视区（右栏是滚动容器）
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  private step(dir: Dir): void {
    const cur = this.current;
    if (!cur) {
      this.focusFirst();
      return;
    }
    if (dir.x === 0) {
      this.stepVertical(cur, dir.y);
      return;
    }
    this.stepHorizontal(cur, dir);
  }

  /**
   * 纯上下：在同栏内按**纵向位置顺序**走一格。
   * 比空间打分更可预测 —— 用户按一下就往下一行，不会因为横向偏移而跳过某个控件。
   */
  private stepVertical(cur: HTMLElement, sign: number): void {
    const col = columnOf(cur);
    if (!col) return;
    const curTop = cur.getBoundingClientRect().top;
    const same: Array<{ el: HTMLElement; top: number }> = [];
    for (const el of this.candidates()) {
      if (el === cur) continue;
      if (columnOf(el) !== col) continue;
      same.push({ el, top: el.getBoundingClientRect().top });
    }
    same.sort((a, b) => a.top - b.top);

    if (sign > 0) {
      const next = same.find((c) => c.top > curTop + 4);
      if (next) this.setFocus(next.el);
    } else {
      let prev: HTMLElement | null = null;
      for (const c of same) if (c.top < curTop - 4) prev = c.el;
      if (prev) this.setFocus(prev);
    }
  }

  /** 左右（含斜向）：用视线锥做空间搜索，可以跨栏 */
  private stepHorizontal(cur: HTMLElement, dir: Dir): void {
    const from = centerOf(cur);
    const fromCol = columnOf(cur);
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    let bestSameCol: HTMLElement | null = null;
    let bestSameColScore = Infinity;

    for (const el of this.candidates()) {
      if (el === cur) continue;
      const to = centerOf(el);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      // 方向投影：必须落在推进方向上
      const along = dx * dir.x + dy * dir.y;
      if (along <= 4) continue;
      // 垂直偏移：越正对越优先
      const across = Math.abs(dx * dir.y - dy * dir.x);
      // 视线锥：偏得太远的不算「那个方向上的下一个」，否则会跨栏乱跳
      if (across > along * CONE_SLOPE + CONE_BASE_PX) continue;
      // 代价 = 垂直偏移为主 + 距离的轻微权重，避免斜向跳远
      const score = across * 2 + Math.hypot(dx, dy) * 0.25;

      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
      if (fromCol !== null && columnOf(el) === fromCol && score < bestSameColScore) {
        bestSameColScore = score;
        bestSameCol = el;
      }
    }
    const picked = bestSameCol ?? best;
    if (picked) this.setFocus(picked);
  }
}

/** 元素所在的栏：用最近的 main 直接子元素作为栏的标识 */
function columnOf(el: HTMLElement): Element | null {
  let node: HTMLElement | null = el;
  while (node && node.parentElement && node.parentElement.tagName !== 'MAIN') {
    node = node.parentElement;
  }
  return node?.parentElement?.tagName === 'MAIN' ? node : null;
}

function centerOf(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
