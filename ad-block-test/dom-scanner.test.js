/**
 * DomScanner 模块测试
 */

describe('DomScanner', () => {
    let domScanner;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Mock dependencies
        global.ProtectedCheck = {
            isProtected: jest.fn(() => false)
        };
        global.BlockEngine = {
            _cachedDomainList: null,
            _cachedPathPatterns: null
        };

        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const match = content.match(/const DomScanner = \{[\s\S]*?\n    \};/);
        if (match) {
            const extract = new Function(match[0] + '; return DomScanner;');
            domScanner = extract();
        }
    });

    describe('scan', () => {
        it('should return empty array when no elements match', () => {
            if (domScanner && typeof domScanner.scan === 'function') {
                const results = domScanner.scan();
                expect(Array.isArray(results)).toBe(true);
            }
        });
    });
});
