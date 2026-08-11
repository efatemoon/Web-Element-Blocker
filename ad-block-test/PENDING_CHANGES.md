# 修复方案待确认

## 需要用户确认的改动方案

### 方案 1: 拆分 OverlayAdScanner (Critical)
**问题**: 4,766 行上帝模块，违反单一职责原则
**建议方案**:
```
OverlayAdScanner (4766行) → 拆分为 4 个模块:
  1. OverlayDetector (元素检测核心逻辑) ~500行
  2. UrlDecoder (URL 解码功能) ~300行  
  3. NavInterceptor (导航拦截) ~200行
  4. PanelRenderer (UI 面板生成) ~300行
```
**影响范围**: 仅修改 web-element-blocker.user.js 内部结构
**预计时间**: 2-3 天
**风险**: 中 (需确保接口兼容)
**是否执行**: 请确认

---

### 方案 2: 解决循环依赖 (Critical)
**问题**: OverlayAdScanner ↔ IframeGuard 循环依赖
**建议方案**:
```javascript
// 提取公共接口到独立模块
// 1. 创建 OverlayResult 接口模块
// 2. OverlayAdScanner 只依赖接口，不直接引用 IframeGuard
// 3. IframeGuard 通过 EventBus 接收结果
```
**影响范围**: 2 个模块 + 1 个新模块
**预计时间**: 1-2 天
**风险**: 低
**是否执行**: 请确认

---

### 方案 3: 修复分层违规 (Critical)
**问题**: IframeGuard → UIManager 直接调用
**建议方案**:
```javascript
// 修改前:
IframeGuard.showPanel = function() {
    UIManager.showIframePanel(...);
};

// 修改后:
IframeGuard.emit('iframe:panel:show', data);
// UIManager 监听事件显示面板
```
**影响范围**: IframeGuard + UIManager
**预计时间**: 2-4 小时
**风险**: 低
**是否执行**: 请确认

---

### 方案 4: 补充核心模块测试 (Critical)
**问题**: ContentClassifier, FrameDetector, IframeGuard 未测试
**建议方案**:
```
新增测试文件:
  - content-classifier.test.js
  - frame-detector.test.js  
  - iframe-guard.test.js
  - dom-scanner.test.js
  - overlay-detector.test.js
```
**影响范围**: ad-block-test/ 目录
**预计时间**: 3-5 天
**风险**: 无
**是否执行**: 请确认

---

### 方案 5: 提取重复 UI 代码 (Scheduled)
**问题**: 9 处重复的面板初始化代码
**建议方案**:
```javascript
// 提取工厂函数
function createPanel(id, title, buttons, contentFn) {
    const panel = document.createElement('div');
    panel.id = id;
    panel.className = 'panel';
    // ... 通用初始化逻辑
    return panel;
}
```
**影响范围**: UIManager 内部
**预计时间**: 2-4 小时
**风险**: 低
**是否执行**: 请确认

---

### 方案 6: 减少全局对象污染 (Scheduled)
**问题**: 11 处 window/document 属性赋值
**建议方案**:
```javascript
// 使用命名空间隔离
const ProBlocker = {
    fetch: window.fetch,
    WebSocket: window.WebSocket,
    open: window.open
};

// 使用 Proxy 包装
const windowProxy = new Proxy(window, {
    set(target, prop, value) {
        if (prop.startsWith('__proBlocker_')) {
            target[prop] = value;
        }
        return true;
    }
});
```
**影响范围**: NetworkEngine, UIManager
**预计时间**: 1 天
**风险**: 中 (需测试兼容性)
**是否执行**: 请确认
