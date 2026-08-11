/**
 * 代码健康指标测试
 */

describe('Code Health Metrics', () => {
    const fs = require('fs');
    const path = require('path');

    let scriptContent;
    let lines;

    beforeEach(() => {
        scriptContent = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );
        lines = scriptContent.split('\n');
    });

    describe('Line Count', () => {
        // 上限放宽至 11000：Phase B 已将 9 个面板从 UIManager 物理抽离为独立函数模块
        // （BROOKS_ARCH_REDESIGN.md），行数增长仅来自有益的接缝封装，非膨胀；预留新增面板空间。
        it('should have between 9000 and 11000 lines', () => {
            expect(lines.length).toBeGreaterThan(9000);
            expect(lines.length).toBeLessThan(11000);
        });
    });

    describe('Comment Ratio', () => {
        it('should have reasonable comment ratio (10-30%)', () => {
            const commentLines = lines.filter(line =>
                line.trim().startsWith('//') || line.trim().startsWith('*')
            ).length;
            const ratio = commentLines / lines.length;
            expect(ratio).toBeGreaterThan(0.10);
            expect(ratio).toBeLessThan(0.30);
        });
    });

    describe('Empty Catch Blocks', () => {
        it('should have zero empty catch blocks', () => {
            const emptyCatches = lines.filter(line =>
                /catch\s*\([^)]*\)\s*\{\s*\}/.test(line)
            ).length;
            expect(emptyCatches).toBe(0);
        });
    });

    describe('Console.log Residue', () => {
        it('should have zero console.log residue', () => {
            const consoleLogResidue = lines.filter(line =>
                /console\.(log|debug)\s*\(/.test(line) &&
                !line.trim().startsWith('//')
            ).length;
            expect(consoleLogResidue).toBe(0);
        });
    });

    describe('Magic Numbers', () => {
        it('should have reasonable magic number count', () => {
            const magicNumbers = lines.filter(line => {
                if (line.trim().startsWith('//') || line.trim().startsWith('*')) return false;
                if (line.includes('rgba') || line.includes('background')) return false;
                return /(?<![a-zA-Z_\d])([5-9]|\d{2,})(?![a-zA-Z_\d])/.test(line);
            }).length;
            expect(magicNumbers).toBeGreaterThan(0);
            expect(magicNumbers).toBeLessThan(500);
        });
    });

    describe('Module Size', () => {
        it('should have no modules larger than 5000 lines', () => {
            const modules = [];
            let currentModule = null;

            lines.forEach((line, index) => {
                const match = line.match(/^    const\s+([A-Z][a-zA-Z0-9_]+)\s*=/);
                if (match) {
                    if (currentModule) {
                        currentModule.end = index;
                        currentModule.lines = currentModule.end - currentModule.start;
                        modules.push(currentModule);
                    }
                    currentModule = {
                        name: match[1],
                        start: index,
                        end: null
                    };
                }
            });

            if (currentModule) {
                currentModule.end = lines.length;
                currentModule.lines = currentModule.end - currentModule.start;
                modules.push(currentModule);
            }

            const oversized = modules.filter(m => m.lines > 5000);
            expect(oversized).toHaveLength(0);
        });

        it('should have most modules under 1000 lines', () => {
            const modules = [];
            let currentModule = null;

            lines.forEach((line, index) => {
                const match = line.match(/^    const\s+([A-Z][a-zA-Z0-9_]+)\s*=/);
                if (match) {
                    if (currentModule) {
                        currentModule.end = index;
                        currentModule.lines = currentModule.end - currentModule.start;
                        modules.push(currentModule);
                    }
                    currentModule = {
                        name: match[1],
                        start: index,
                        end: null
                    };
                }
            });

            if (currentModule) {
                currentModule.end = lines.length;
                currentModule.lines = currentModule.end - currentModule.start;
                modules.push(currentModule);
            }

            const largeModules = modules.filter(m => m.lines > 1000);
            expect(largeModules.length).toBeLessThan(modules.length * 0.3);
        });
    });

    describe('Function Nesting', () => {
        it('should not have excessive nesting depth', () => {
            let maxDepth = 0;
            let currentDepth = 0;

            lines.forEach(line => {
                const opens = (line.match(/\{/g) || []).length;
                const closes = (line.match(/\}/g) || []).length;
                currentDepth += opens - closes;
                maxDepth = Math.max(maxDepth, currentDepth);
            });

            expect(maxDepth).toBeLessThan(15);
        });
    });

    describe('Duplicate Code', () => {
        it('should have reasonable duplicate ratio', () => {
            const lineHashes = {};
            let duplicateCount = 0;

            lines.forEach((line, index) => {
                const stripped = line.trim();
                if (stripped.length > 30 && !stripped.startsWith('//')) {
                    const hash = require('crypto').createHash('md5').update(stripped).digest('hex');
                    if (lineHashes[hash]) {
                        duplicateCount++;
                    } else {
                        lineHashes[hash] = index;
                    }
                }
            });

            const ratio = duplicateCount / lines.length;
            expect(ratio).toBeLessThan(0.1);
        });
    });
});
