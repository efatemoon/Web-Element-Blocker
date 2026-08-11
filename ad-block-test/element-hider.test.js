/**
 * ElementHider 模块测试
 */

describe('ElementHider', () => {
    let elementHider;

    beforeEach(() => {
        jest.clearAllMocks();
        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const match = content.match(/const ElementHider = \{[\s\S]*?\n    \};/);
        if (match) {
            const extract = new Function(match[0] + '; return ElementHider;');
            elementHider = extract();
        }
    });

    describe('hideElement', () => {
        it('should set display none on element', () => {
            const el = { style: {}, classList: { add: jest.fn() } };
            elementHider.hideElement(el);
            expect(el.style.display).toBe('none');
        });
    });

    describe('showElement', () => {
        it('should clear display style', () => {
            const el = { style: { display: 'none' } };
            elementHider.showElement(el);
            expect(el.style.display).toBe('');
        });
    });
});
