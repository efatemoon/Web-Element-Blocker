/**
 * SelectorBuilder 模块测试
 */

describe('SelectorBuilder', () => {
    let selectorBuilder;

    beforeEach(() => {
        jest.clearAllMocks();
        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const match = content.match(/const SelectorBuilder = \{[\s\S]*?\n    \};/);
        if (match) {
            const extract = new Function(match[0] + '; return SelectorBuilder;');
            selectorBuilder = extract();
        }
    });

    describe('generateOptimalSelector', () => {
        it('should generate selector for element with id', () => {
            const el = { id: 'test-id', className: '', tagName: 'DIV' };
            const selector = selectorBuilder.generateOptimalSelector(el);
            expect(selector).toContain('#test-id');
        });

        it('should generate selector for element with class', () => {
            const el = { id: '', className: 'test-class', tagName: 'DIV' };
            const selector = selectorBuilder.generateOptimalSelector(el);
            expect(selector).toContain('.test-class');
        });
    });
});
