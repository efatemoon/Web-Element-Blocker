# video-accelerator.user.js — 审查 + 重构执行报告

日期：2026-08-11
文件：video-accelerator.user.js（4141 行）
模式：review-and-refactor（先审后改，改动保持测试全绿）

## 审查结论（前置）
独立五轴审查整体健康度 **85/100（B+）**，结论 **Approve**。
完整审查见 `video-accelerator_REVIEW_2026-08-11.md`。
本文件记录本轮实际落地的两处安全/正确性重构。

## 重构 1：配置合并原型污染（纵深防御）

**位置**：`ConfigManager` 的 `importJSON` / `applyRemote` / 构造器合并路径
**问题**：原 `Object.assign({}, this.defaults, obj)` 在 `obj` 含 `__proto__` 键时，
`Object.assign` 会写入目标对象的原型链（原型污染）。极端情况下可影响后续
`this._cache.xxx` 的读取语义。实际风险有限（输入仅来自用户粘贴或同源帧），
但属纵深防御应修项。

**改动**：新增 `_mergeConfig(base, override)` 私有方法，仅遍历 `Object.keys(override)`
（自有可枚举键，天然不含 `__proto__`），并显式跳过 `__proto__` / `constructor` / `prototype`，
覆盖三处合并调用（构造器 405、importJSON 497、applyRemote 516）。

**Before**
```js
this._cache = Object.assign({}, this.defaults, obj || {});
```
**After**
```js
this._cache = this._mergeConfig(this.defaults, obj);

_mergeConfig(base, override) {
    const out = Object.assign({}, base);
    if (override && typeof override === 'object' && !Array.isArray(override)) {
        for (const k of Object.keys(override)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            out[k] = override[k];
        }
    }
    return out;
}
```

> 注：`reset()` 内剩余 `Object.assign({}, this.defaults)`（约 508 行）仅合并
> 可信默认值、无外部输入，保持不动。

## 重构 2：`parseInt` 吞掉合法 0（正确性）

**位置**：`_syncSettings` / `_flushSettings` 的数字类型读取分支（3712、3738 行）
**问题**：原 `value = parseInt(el.value, 10) || cfg.def` 中，`0` 是 falsy，
会把合法的 `minVideoArea=0`（"忽略面积阈值"语义）错误吞掉、回退成默认值。

**改动**：改用 `isNaN` 判断，仅当解析失败（NaN）才回退默认。
```js
if (cfg.type === 'num') { const n = parseInt(el.value, 10); value = isNaN(n) ? cfg.def : n; }
```
两处完全一致，已一并修正。

## 验证
| 项 | 结果 |
|----|------|
| `node --check` 语法 | ✅ 通过 |
| 单元测试 `unit-tests.js` | ✅ 150/150 |
| 核心模块 `core-module-tests.js` | ✅ 50/50 |
| 补充测试（_patrol DOC 空值 + error bubbling） | ✅ 3/3 |
| tryPlay 修复测试 | ✅ 2/2 |
| **合计** | **205/205 全绿，无回归** |

## 未改动项（已知非阻塞，留待后续）
- 既有 `video-accelerator_REVIEW_2026-08-11.md` 中其余 Nit / Consider 项未在本轮处理
  （如需可继续）：例如 `this._cache` 同步守卫细节、`score()` 权重边界等。
- 文件体量（4141 行）维持，未做拆分（属更大重构，需单独评估）。

---

## 重构 3（第二轮，14:33）：UIManager 内联 CSS 外提为模块级常量

**位置**：`UIManager._build()` 中原 `style.textContent = \`<style>…</style>\``（原 3172–3354，约 183 行）
**问题**：约 183 行静态 CSS 模板字面量内联在类构造逻辑中，与行为逻辑混杂，可读性差、
      审查成本高（审查报告中标记为 Optional）。CSS 为纯静态（无 `${}` 插值）。
**改动**：将整段 CSS 提升为模块级常量 `VA_UI_CSS`（3139 行，位于 `class UIManager` 之前，
      与类同级作用域），原处改为 `style.textContent = VA_UI_CSS;`（3357 行）。
      **零行为变化**——仅字符串位置移动，CSS 内容与注入方式完全不变。
**方式**：用确定性脚本按内容标记定位抽取（不依赖硬编码行号），抽取后 `node --check` + 全套测试验证。
**收益**：`UIManager` 类体可读性显著提升，CSS 与逻辑分离，后续改样式不影响逻辑 diff。

## 重构 4（第二轮，14:33）：`minVideoArea` clamp 一致性

**位置**：`ConfigManager._normalize()` 426 行
**问题**：同文件已有 `clamp(n, lo, hi)` 辅助函数（65 行，全局用 9 次），但此处仍内联
      `Math.min(VA_TUNING.MIN_VIDEO_AREA_MAX, Math.max(0, mva))`，与既有约定不一致。
**改动**：改为 `clamp(mva, 0, VA_TUNING.MIN_VIDEO_AREA_MAX)`，外层 `isNaN(mva) ? DEFAULT : …`
      保留（`clamp` 对 NaN 返回 `lo=0`，但本处需回退 DEFAULT，故保留 isNaN 分支）。
      行为完全等价，仅统一风格。

## 第二轮验证
| 项 | 结果 |
|----|------|
| `node --check` 语法 | ✅ 通过 |
| 单元测试 `unit-tests.js` | ✅ 150/150 |
| 核心模块 `core-module-tests.js` | ✅ 50/50 |
| 补充测试 | ✅ 3/3 |
| tryPlay 修复测试 | ✅ 2/2 |
| **合计** | **205/205 全绿，无回归** |
| 临时脚本 `_hoist_css.js` | ✅ 已清理 |

## 累计重构清单（截至 2026-08-11）
1. `_mergeConfig` 原型污染纵深防御（覆盖 importJSON/applyRemote/构造器）
2. `parseInt` 合法 `0` 被吞修复（设置层 3712/3738）
3. UIManager 内联 CSS 外提 `VA_UI_CSS`（纯可读性，零行为变化）
4. `minVideoArea` clamp 风格统一（纯一致性，零行为变化）
