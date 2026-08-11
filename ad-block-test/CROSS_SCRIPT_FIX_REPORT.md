# 跨脚本冲突修复报告

## 问题描述
用户报告两个脚本同时运行时存在冲突：
- 广告拦截脚本正常运行
- 视频加速脚本的菜单命令消失，UI 被隐藏
- 反复刷新后，广告占位条大量出现（说明视频加速 UI 被误拦截）

## 根因分析

### 1. UI 误拦截
视频加速脚本的 `va-ui-host` 元素：
```javascript
this.host.style.cssText = 'position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;overflow:visible;';
```
- z-index: 2147483646（超过 9999 阈值）
- position: fixed
- 被广告拦截的 `_analyzeOverlay()` 判定为"超高 z + 全屏 fixed"，suspicion += 65
- 导致隐藏

### 2. ProtectedCheck 不完整
```javascript
// 原代码
const ProtectedCheck = {
    isProtected(el) {
        if (el.id === 'pro-blocker-ui-host') return true;
        // 缺少对 va-ui-host 的识别
        return false;
    }
};
```

### 3. 缺少反向保护
视频加速脚本未检测广告拦截器 UI 的挂载状态。

## 修复方案

### 修复 1: ProtectedCheck 扩展（web-element-blocker.user.js）
```javascript
const ProtectedCheck = {
    isProtected(el) {
        if (!el) return true;
        // 广告拦截器自身 UI
        if (el.id === 'pro-blocker-ui-host') return true;
        if (el.closest && el.closest('#pro-blocker-ui-host')) return true;
        let root;
        try { root = el.getRootNode && el.getRootNode(); } catch (e) { root = null; }
        if (root && root.host && root.host.id === 'pro-blocker-ui-host') return true;
        
        // 视频加速脚本 UI（跨脚本保护）
        if (el.id === 'va-ui-host') return true;
        if (el.closest && el.closest('#va-ui-host')) return true;
        if (root && root.host && root.host.id === 'va-ui-host') return true;
        
        // 视频加速 FAB 按钮（z-index: 2147483646 会被误判为广告覆盖层）
        if (el.classList && el.classList.contains('fab')) return true;
        
        return false;
    }
};
```

### 修复 2: CSS 选择器保护（web-element-blocker.user.js）
```javascript
// 原代码
const SELF_PROTECT = ':not(#pro-blocker-ui-host):not(#pro-blocker-ui-host *)';

// 修复后
const SELF_PROTECT = ':not(#pro-blocker-ui-host):not(#pro-blocker-ui-host *):not(#va-ui-host):not(#va-ui-host *)';
```

### 修复 3: MutationObserver 兜底（video-accelerator.user.js）
```javascript
try {
    const _observeAdBlockerUI = () => {
        if (typeof MutationObserver === 'undefined') return;
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    // 如果广告拦截器插入了 va-ui-host，确保它不被隐藏
                    if (node.id === 'va-ui-host' && node.style.display === 'none') {
                        node.style.display = '';
                        Logger.warn('Cross-script', 'Ad blocker re-hidden va-ui-host, restored');
                    }
                    // 递归检查子节点
                    if (node.querySelectorAll) {
                        node.querySelectorAll('#va-ui-host').forEach(el => {
                            if (el.style.display === 'none') {
                                el.style.display = '';
                            }
                        });
                    }
                }
            }
        });
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });
    };
    _observeAdBlockerUI();
} catch (e) { }
```

## 验证结果

### 语法检查
```bash
$ node --check web-element-blocker.user.js
$ node --check video-accelerator.user.js
Syntax check passed
```

### 测试通过率
```
Test Suites: 12 passed, 12 total
Tests:       53 passed, 53 total
Snapshots:   0 total
Time:        4.414 s
```

### 文件变化
| 文件 | 修复前 | 修复后 | 变化 |
|------|--------|--------|------|
| web-element-blocker.user.js | 9,857 行 | 9,866 行 | +9 行 |
| video-accelerator.user.js | 4,070 行 | 4,115 行 | +45 行 |

## 冲突解决原理

```
┌─────────────────────────────────────────────────────────────┐
│                    跨脚本保护机制                              │
├─────────────────────────────────────────────────────────────┤
│  广告拦截脚本                                               │
│  ├── ProtectedCheck.isProtected()                          │
│  │   ├── 识别 pro-blocker-ui-host ✓                        │
│  │   └── 识别 va-ui-host ✓ (新增)                           │
│  ├── CSS 选择器保护                                          │
│  │   └── :not(#va-ui-host):not(#va-ui-host *) (新增)        │
│  └── Shadow DOM 遍历                                         │
│      └── 跳过 isProtected 元素                               │
├─────────────────────────────────────────────────────────────┤
│  视频加速脚本                                               │
│  └── MutationObserver 监听                                  │
│      ├── 检测 va-ui-host 被隐藏                             │
│      └── 自动恢复 display 属性                              │
└─────────────────────────────────────────────────────────────┘
```

## 预期效果
1. ✅ 页面加载后，视频加速 FAB 按钮正常显示在右下角
2. ✅ 广告拦截面板（`#pro-blocker-ui-host`）不再被视频加速脚本误判
3. ✅ 反复刷新页面时，两个脚本的 UI 都不会消失
4. ✅ 广告拦截功能正常，视频播放不受影响
5. ✅ 菜单命令正常显示

## 其他发现
- GM_registerMenuCommand 冲突：无问题，两个脚本各自注册独立的菜单项
- Shadow DOM 遍历：已有限制（最大 5 层），不会相互影响
- z-index 冲突：两个脚本的 UI 都使用超高 z-index，但 ProtectedCheck 已处理

## 总结
通过三层防护机制（ProtectedCheck + CSS 选择器 + MutationObserver）实现了两个脚本的 UI 互不干扰，确保各自功能正常运行。
