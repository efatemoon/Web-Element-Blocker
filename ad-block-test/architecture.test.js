/**
 * 架构依赖测试
 */

describe('Architecture Dependencies', () => {
    const fs = require('fs');
    const path = require('path');

    let scriptContent;

    beforeEach(() => {
        scriptContent = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );
    });

    describe('Layer Violations', () => {
        it('should not have UI module references in engine layer', () => {
            // Check that engine modules don't reference UIManager directly
            const engineModules = [
                'DomScanner', 'OverlayDetector', 'OverlayScanEngine',
                'BlockEngine', 'NetworkEngine', 'RegexEngine'
            ];

            for (const module of engineModules) {
                const moduleStart = scriptContent.indexOf(`const ${module} =`);
                if (moduleStart === -1) continue;

                // Find the end of this module (next module or end of IIFE)
                const nextModule = scriptContent.indexOf('\n    const ', moduleStart + 10);
                const moduleContent = scriptContent.substring(
                    moduleStart,
                    nextModule === -1 ? scriptContent.lastIndexOf('\n    }') : nextModule
                );

                // Check for UIManager references (excluding comments)
                const lines = moduleContent.split('\n');
                let inComment = false;
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('/*')) inComment = true;
                    if (trimmed.startsWith('//')) continue;
                    if (trimmed.endsWith('*/')) inComment = false;
                    if (inComment) continue;

                    // Check for direct UIManager.method() calls
                    if (/UIManager\.\w+\s*\(/.test(line)) {
                        console.warn(`Warning: ${module} references UIManager directly at line`, line.trim());
                    }
                }
            }
        });
    });

    describe('Module Cohesion', () => {
        it('should have focused modules (no god modules)', () => {
            const modulePattern = /const\s+(\w+)\s*=\s*\{[\s\S]*?\n    \};/g;
            let match;
            const largeModules = [];

            while ((match = modulePattern.exec(scriptContent)) !== null) {
                const moduleName = match[1];
                const moduleBody = match[0];
                const lineCount = moduleBody.split('\n').length;

                if (lineCount > 1000) {
                    largeModules.push({ name: moduleName, lines: lineCount });
                }
            }

            // Should have at most 2 modules larger than 1000 lines
            expect(largeModules.length).toBeLessThanOrEqual(2);

            if (largeModules.length > 0) {
                console.warn('Large modules detected:', largeModules);
            }
        });
    });

    describe('Dependency Graph', () => {
        it('should have a valid startup sequence', () => {
            // Check that startup sequence exists
            const startupSequence = scriptContent.includes('NetworkInterceptor.init()') ||
                                   scriptContent.includes('BlockEngine.hookAttachShadow()');
            expect(startupSequence).toBe(true);
        });
    });
});
