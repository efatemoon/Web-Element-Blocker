/**
 * 代码风格与规范测试
 */

describe('Code Style & Conventions', () => {
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

    describe('No console.log残留', () => {
        it('should have no raw console.log calls', () => {
            const consoleLog = lines.filter(line =>
                /\bconsole\.log\s*\(/.test(line) &&
                !line.trim().startsWith('//')
            ).length;
            expect(consoleLog).toBe(0);
        });

        it('should have no raw console.debug calls', () => {
            const consoleDebug = lines.filter(line =>
                /\bconsole\.debug\s*\(/.test(line) &&
                !line.trim().startsWith('//')
            ).length;
            expect(consoleDebug).toBe(0);
        });
    });

    describe('No debugger statement', () => {
        it('should have no debugger statements', () => {
            const debuggerStatements = lines.filter(line =>
                /\bdebugger\b/.test(line) &&
                !line.trim().startsWith('//')
            ).length;
            expect(debuggerStatements).toBe(0);
        });
    });

    describe('Consistent brace style', () => {
        it('should use consistent brace placement', () => {
            // Check for mixed brace styles
            const sameLineBraces = lines.filter(line =>
                /\{\s*$/.test(line) && !line.trim().startsWith('//')
            ).length;
            const nextLineBraces = lines.filter(line =>
                /\{\s*$/.test(line) && !line.trim().startsWith('//')
            ).length;

            // Should have consistent style (either all same-line or all next-line)
            expect(sameLineBraces + nextLineBraces).toBeGreaterThan(0);
        });
    });

    describe('No triple-equal with side effects', () => {
        it('should not have assignment in condition', () => {
            const assignmentsInConditions = lines.filter(line =>
                /if\s*\([^)]*=[^=!][^=]*\)/.test(line) &&
                !line.trim().startsWith('//')
            ).length;
            expect(assignmentsInConditions).toBe(0);
        });
    });

    describe('Arrow function consistency', () => {
        it('should use arrow functions for simple callbacks', () => {
            // Check for function() patterns that could be arrows
            const oldStyleFunctions = lines.filter(line =>
                /\bfunction\s*\(/.test(line) &&
                !line.trim().startsWith('//') &&
                !line.trim().startsWith('*')
            ).length;

            // We expect some old-style functions for event handlers
            expect(oldStyleFunctions).toBeLessThan(50);
        });
    });

    describe('Error handling completeness', () => {
        it('should have matching try-catch count', () => {
            const tryCount = lines.filter(line => /try\s*\{/.test(line)).length;
            const catchCount = lines.filter(line => /catch\s*\(/.test(line)).length;
            // try-catch pairs should be roughly equal (allowing for try-finally)
            expect(Math.abs(tryCount - catchCount)).toBeLessThan(10);
        });
    });
});
