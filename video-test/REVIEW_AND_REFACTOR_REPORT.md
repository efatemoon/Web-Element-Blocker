# review-and-refactor 审查与重构报告

> 对象：`video-accelerator.user.js`(v19.0.4) + `web-element-blocker.user.js`(未提交改动)
> 时间：2026-08-11 13:41 (GMT+8)
> 方法：项目无 `.github/instructions/*.md` / `copilot-instructions.md`，编码规范由既有代码约定（readme 中文注释、常量集中 `VA_TUNING`/`VA_BUFFER`、注释驱动说明）推导。
> 原则：**不拆分文件**（保持 Tampermonkey 单文件可发布）；改动外科式、无对外接口变更；每项改动后跑通全套测试。

---

## ✅ 一、Critical 修复（web-element-blocker，未提交改动中发现）

### F-1：`WeakMap.forEach` → `WeakSet.forEach` 的"修复"本身仍会崩溃（已引入的回归）

**位置**：`web-element-blocker.user.js` 3 处（~6775 面板渲染、`rescanAll` ~9382、`forceRescan` ~9399）
**问题**：
原代码 `IframeGuard._frameRecords.forEach(...)` 因 `WeakMap` 无 `forEach` 抛 `TypeError`（真实 bug）。
但本会话的未提交改动把它"修复"成 `this._frameRecordKeys.forEach(...)` —— 而 `WeakSet` **同样没有** `forEach`（运行时实测 `typeof ws.forEach === 'undefined'`，调用即 `TypeError`）。

```
> new WeakSet().forEach(() => {})   // 实测
TypeError: ws.forEach is not a function
```

后果：
- 面板渲染路径（Site 1）**直接抛错** → iframe 面板整体渲染失败；
- `rescanAll`/`forceRescan`（Site 2/3）虽在 `try/catch` 内被吞，但 **粘性记录迁移全部失效** → 手动拦截 / 已封杀帧在重扫后复活。

**根因**：`WeakMap` 与 `WeakSet` **按设计不可枚举**（无 `forEach`、无迭代器），任何"建一个 key 集合来遍历"的思路都走到同一条死路。

**修复（单一数据源 + 以 DOM 为真实来源）**：
```js
// IframeGuard 新增
_liveFrames(root = document, depth = 0, out = []) {
    if (depth > this._maxDepth) return out;
    try {
        root.querySelectorAll('iframe').forEach(f => {
            out.push(f);
            try { const d = f.contentDocument; if (d) this._liveFrames(d, depth + 1, out); }
            catch (e) { /* 跨域帧 contentDocument 不可访问，属预期情况 */ }
        });
    } catch (e) { Log.warn(e.message || e); }
    return out;
}
_keepStickyRecords() {
    const keep = new WeakMap();
    this._liveFrames().forEach(iframe => {
        const rec = this._frameRecords.get(iframe);
        if (rec && (rec.blocked || rec.manual)) keep.set(iframe, rec);
    });
    return keep;
}
```
- 删除无效的 `_frameRecordKeys: new WeakSet()` 及其在 `_ensureRecord` 的写入；
- 三处遍历调用统一改为 `IframeGuard._liveFrames()`；
- `rescanAll`/`forceRescan` 合并为 `rescanAll` + `forceRescan(){ this.rescanAll(); }`，消除逐字节重复（`rescanAll` 与 `forceRescan` 此前函数体完全相同）。

**验证**（jsdom 实测，非仅阅读）：8/8 通过，含——嵌套同源帧枚举、粘性保留/非粘性丢弃、脱离 DOM 帧自动跳过（无泄漏/无复活）、旧代码 `WeakSet.forEach` 确实抛 `TypeError`。

---

## ✅ 二、重构（video-accelerator，采纳前次审查建议）

| ID | 位置 | 改动 | 理由 |
|----|------|------|------|
| R-1 | `_observeAdBlockerUI` | 拆分观察器：结构观察仍挂在 `DOC.documentElement`（`childList+subtree`，**不开 attributes`**）；属性观察单独钉在 `this.host`（`attributes`, `['style','class']`） | 原写法对**整棵 documentElement** 开 `attributes:true+subtree:true`，SPA/广告密集页每次 style/class 突变都排队回调（[前次审查 Optional·性能]）。现属性监听代价与页面规模无关，且改用 `DOC`（即 `this.host` 所属文档），修正了原 `document` 与 `DOC` 可能指向不同文档的隐患 |
| R-2 | `_normalize` / 默认配置 | `8000`/`100000000` 字面量 → `VA_TUNING.MIN_VIDEO_AREA_DEFAULT` / `MIN_VIDEO_AREA_MAX`（新增常量），默认配置 `minVideoArea: 8000` 同步引用同一常量 | 消除魔法数字，单一数据源（[前次审查 Nit]） |
| R-3 | `_observeAdBlockerUI` catch | `catch (e) {}` 空 catch → `Logger.warn('Cross-script', ...)` | 空 catch 吞错，与项目"错误捕获须记录"约定不符；且能暴露观察器安装失败 |

---

## 🔍 三、审查中识别但**拒绝**的建议（含理由）

**拒绝：前次审查 Optional — `_bufferCheck` 第二分支改用 `BUFFER_LEVEL_RECOVER(8)`**
- 现状：`else if (ahead < BUFFER_LEVEL_WARNING(5))`，三级水位 `<1` 紧急 / `<5` 轻推 / `>8` 恢复。
- 若改为 `<RECOVER(8)`：会把 **5~8s 这段刻意保留的迟滞带**并入"轻推"分支。表面看覆盖了 0–8s，但代价是**销毁了状态退出的迟滞保护**——缓冲在 6s 左右时本应"舒适、不动作、也不急着退出 DEGRADED"，改后会持续触发 `_boostLoad` 且更接近阈值抖动。
- 结论：这是**设计纬**，不是 bug。改为显式注释说明三级水位 + 迟滞带的意图（已落注释），**行为不改**。

---

## ✅ 四、基础设施修复

### F-2：`package.json` 的 `test` 脚本是 npm init 占位符
- 原：`"test": "echo \"Error: no test specified\" && exit 1"` —— 尽管仓库有 `jest.config.js` + 12 个测试套件，`npm test` 仍**永远失败**。
- 改：补充 `test`/`test:watch`/`test:coverage`/`test:video`/`test:all`/`lint:syntax`，`npm test` 现直接跑 jest。

---

## 📊 五、验证结果

| 入口 | 结果 |
|------|------|
| `node --check web-element-blocker.user.js` | ✅ OK |
| `node --check video-accelerator.user.js` | ✅ OK |
| `jest`（12 suites） | ✅ 57/57 通过 |
| `video-test/unit-tests.js` | ✅ 150/150 |
| `video-test/core-module-tests.js` | ✅ 50/50 + 补充 5 |
| `_liveFrames` jsdom 实测 | ✅ 8/8 |
| **合计** | **全部通过，无回归** |

> 诚实声明：`web-element-blocker` 与 `video-accelerator` 的既有测试套件**不加载生产代码**（逻辑内联重实现），故 F-1 的正确性**不依赖** jest 绿灯，而是靠上面的 jsdom 实测闭环验证。

---

## 📈 六、残余问题（按严重度）

1. 🟠 **测试不加载生产代码（覆盖率幻觉，既有架构债）**：200+ 断言全过 ≠ 真实覆盖，回归保护为 0。建议 [MANUAL]，将测试改为 `import` 编译产物。
2. 🟠 **`web-element-blocker.user.js` 9887 行上帝模块**：拆分类/文件需 ESM 构建管线。
3. 🟢 **104 处空 catch**（`web-element-blocker`）：其余防御性空 catch 可加 `// intentionally empty` 或 `Logger`。
4. 🟢 **未提交改动范围**：本次仅含 `web-element-blocker.user.js` 的 F-1 修复与 `package.json`。`video-accelerator` 的 R-1~R-3 已直接改入文件；`BROOKS_LINT_REPORT_v7.0.md` 为既存未跟踪文件，未动。

---

## 结论：Approve（可合并）

本次改动是明确的净健康度提升：修复了一个**真实会崩溃/复活拦截**的 Critical 回归（F-1），并通过实测闭环证伪其正确性；视频脚本在保留设计意图的前提下消除了魔法数字、收窄了性能隐患、补齐了错误日志；`npm test` 从"永远失败"变为可运行。所有入口测试全绿。
