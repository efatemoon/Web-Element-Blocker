/**
 * ProtectedCheck 模块测试
 */

describe('ProtectedCheck', () => {
    let protectedCheck;

    beforeEach(() => {
        jest.clearAllMocks();
        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const match = content.match(/const ProtectedCheck = \{[\s\S]*?\n    \};/);
        if (match) {
            const extract = new Function(match[0] + '; return ProtectedCheck;');
            protectedCheck = extract();
        }
    });

    describe('isProtected', () => {
        it('should return true for null/undefined', () => {
            expect(protectedCheck.isProtected(null)).toBe(true);
            expect(protectedCheck.isProtected(undefined)).toBe(true);
        });

        it('should return true for protected element by id', () => {
            const el = { id: 'pro-blocker-ui-host' };
            expect(protectedCheck.isProtected(el)).toBe(true);
        });

        it('should return true for element inside protected host', () => {
            const host = { id: 'pro-blocker-ui-host' };
            const child = {
                closest: jest.fn().mockReturnValue(host)
            };
            expect(protectedCheck.isProtected(child)).toBe(true);
        });

        it('should return false for non-protected element', () => {
            const el = { id: 'regular-element' };
            expect(protectedCheck.isProtected(el)).toBe(false);
        });

        it('should handle getRootNode errors gracefully', () => {
            const el = {
                getRootNode: jest.fn().mockImplementation(() => { throw new Error('cross-origin'); }),
                id: 'regular'
            };
            expect(() => protectedCheck.isProtected(el)).not.toThrow();
        });
    });
});
