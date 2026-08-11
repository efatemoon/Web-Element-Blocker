/**
 * 服务层端口契约测试（DIP 接缝）
 *
 * OverlayService / StorageService 是 UI 层依赖的端口，UI 不再直连引擎/存储具体实现。
 * 验证端口表面契约：方法存在性 + 集中缓存失效路径可安全调用。
 *
 * 说明（javascript-testing-patterns · Test Double）：当前端口为「门面式」接缝，
 * 协作者（OverlayDetector/BlockEngine/storage）在产物内闭包绑定；node 环境下
 * storage 为 null，故泛型读取转发目标为空对象、返回 undefined。若需完全可替换的
 * Test Double，可后续将端口改为工厂注入（Phase F）。本测试覆盖端口契约与核心失效路径。
 * 参考：Martin《整洁架构》Ch.5 DIP；Feathers《Working Effectively with Legacy Code》§3 接缝。
 */
const { OverlayService, StorageService } = require('../web-element-blocker.user.js');

describe('服务层端口（DIP 接缝）', () => {
    test('OverlayService 暴露 4 个覆盖层用例端口方法（消除 UIManager→OverlayScanEngine 跨层直调）', () => {
        ['scan', 'deepScan', 'enableNavigationInterceptor', 'scanInvisibleOverlays'].forEach(m => {
            expect(typeof OverlayService[m]).toBe('function');
        });
    });

    test('StorageService.invalidateIframeRules 是集中缓存失效端口且可安全调用', () => {
        expect(typeof StorageService.invalidateIframeRules).toBe('function');
        // 该端口将 iframe 规则缓存失效内聚到 IframeGuard.invalidateBlockRules，
        // 消除散落直写（TD-01/R3 残留）
        expect(() => StorageService.invalidateIframeRules()).not.toThrow();
    });

    test('StorageService 泛型读取转发到底层 storage（node 下 storage 为 null → undefined）', () => {
        // 端口在 node 环境不持有真实 storage，转发目标为空对象，故未定义方法返回 undefined；
        // 浏览器中 storage 已实例化，同类访问返回 bind(storage) 后的函数（行为等价）。
        expect(StorageService.getDomainBlocks).toBeUndefined();
    });
});
