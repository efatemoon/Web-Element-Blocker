# 代码健康指标测试套件

## 运行方式

```bash
# 安装依赖
npm install --save-dev jest jest-environment-jsdom

# 运行所有测试
npm test

# 运行特定测试
npm test -- --testPathPattern=log.test.js

# 查看覆盖率
npm test -- --coverage
```

## 测试文件说明

| 文件 | 测试内容 | 用例数 |
|------|----------|--------|
| `setup.js` | Jest 环境配置，mock GM API | - |
| `log.test.js` | Log 工具模块 | 6 |
| `protected-check.test.js` | 元素保护检测 | 5 |
| `storage-manager.test.js` | 存储管理器 | 3 |
| `config-store.test.js` | 配置存储 | 3 |
| `element-hider.test.js` | 元素隐藏器 | 2 |
| `selector-builder.test.js` | 选择器生成器 | 2 |
| `event-bus.test.js` | 事件总线 | 3 |
| `frame-detector.test.js` | 帧检测器 | 3 |
| `dom-scanner.test.js` | DOM 扫描器 | 1 |
| `health-assessment.test.js` | 代码健康指标 | 7 |
| `code-style.test.js` | 代码风格规范 | 6 |
| `architecture.test.js` | 架构依赖检测 | 3 |

**总计**: 44 个测试用例

## 健康指标阈值

| 指标 | 优秀 | 良好 | 警告 | 危险 |
|------|------|------|------|------|
| 模块大小 | <500 行 | 500-1000 行 | 1000-2000 行 | >2000 行 |
| 函数长度 | <50 行 | 50-100 行 | 100-200 行 | >200 行 |
| 注释率 | 20-30% | 15-20% | 10-15% | <10% |
| 重复代码率 | <5% | 5-10% | 10-15% | >15% |
| 嵌套深度 | <6 | 6-8 | 8-10 | >10 |
| 魔法数字 | <10 | 10-30 | 30-50 | >50 |
