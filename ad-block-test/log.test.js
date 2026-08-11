/**
 * Log 工具模块测试
 */

describe('Log Utility', () => {
    let logModule;

    beforeEach(() => {
        // Re-mock console to track calls
        jest.clearAllMocks();
        // Load the Log module from the script
        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        // Extract and evaluate Log module
        const logMatch = content.match(/const Log = \{[\s\S]*?\n    \};/);
        if (logMatch) {
            // Use new Function to avoid strict mode const hoisting issue
            const extractLog = new Function(logMatch[0] + '; return Log;');
            logModule = extractLog();
        }
    });

    describe('Log.warn', () => {
        it('should call console.warn with tag prefix', () => {
            logModule.warn('test message');
            expect(console.warn).toHaveBeenCalled();
            expect(console.warn.mock.calls[0][0]).toContain('[Pro Blocker]');
        });

        it('should not call console.warn when disabled', () => {
            logModule._enabled = false;
            logModule.warn('test message');
            expect(console.warn).not.toHaveBeenCalled();
        });
    });

    describe('Log.error', () => {
        it('should call console.error with tag prefix', () => {
            logModule.error('error message');
            expect(console.error).toHaveBeenCalled();
            expect(console.error.mock.calls[0][0]).toContain('[Pro Blocker]');
        });
    });

    describe('Log.wrap', () => {
        it('should wrap function and catch errors', () => {
            const mockFn = jest.fn(() => { throw new Error('test error'); });
            const wrapped = logModule.wrap(mockFn, 'testFn');
            const result = wrapped();
            expect(result).toBeNull();
            expect(console.error).toHaveBeenCalled();
        });

        it('should return function result on success', () => {
            const mockFn = jest.fn(() => 'success');
            const wrapped = logModule.wrap(mockFn, 'testFn');
            const result = wrapped();
            expect(result).toBe('success');
        });
    });

    describe('Log.safe', () => {
        it('should return null on error', () => {
            const result = logModule.safe(() => { throw new Error('fail'); }, 'testOp');
            expect(result).toBeNull();
        });

        it('should return result on success', () => {
            const result = logModule.safe(() => 42, 'testOp');
            expect(result).toBe(42);
        });
    });
});
