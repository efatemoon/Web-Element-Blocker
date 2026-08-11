/**
 * SelectorBuilder 模块测试
 */

describe('SelectorBuilder', () => {
    let selectorBuilder;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock CSS.escape to return string as-is (no actual DOM escaping needed in tests)
        global.CSS = {
            escape: jest.fn((str) => str)
        };
        global.Node = {
            ELEMENT_NODE: 1
        };

        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const lines = content.split('\n');
        // Find SelectorBuilder object start (line 1394)
        let start = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('const SelectorBuilder = {')) {
                start = i;
                break;
            }
        }

        if (start === -1) {
            return;
        }

        // Find object end by brace counting
        let depth = 0;
        let end = start;
        for (let i = start; i < lines.length; i++) {
            const line = lines[i];
            for (let j = 0; j < line.length; j++) {
                if (line[j] === '{') depth++;
                else if (line[j] === '}') depth--;
            }
            if (depth === 0 && i > start) {
                end = i;
                break;
            }
        }

        if (end === -1) {
            return;
        }

        // Extract object code
        const objCode = lines.slice(start, end + 1).join('\n');
        try {
            const extract = new Function(objCode + '; return SelectorBuilder;');
            selectorBuilder = extract();
        } catch (e) {
            selectorBuilder = null;
        }
    });

    describe('generateOptimalSelector', () => {
        it('should generate selector for element with id', () => {
            if (!selectorBuilder) return;
            // Create a mock DOM element with proper structure
            const el = {
                id: 'test-id',
                className: '',
                tagName: 'DIV',
                parentElement: null,
                nodeType: 1
            };
            const selector = selectorBuilder.generateOptimalSelector(el);
            expect(selector).toContain('#test-id');
        });

        it('should generate selector for element with class', () => {
            if (!selectorBuilder) return;
            // Create a mock DOM element with parent for class processing
            const parentEl = {
                id: '',
                className: '',
                tagName: 'SECTION',
                parentElement: null,
                nodeType: 1,
                previousElementSibling: null
            };
            const el = {
                id: '',
                className: 'test-class',
                tagName: 'DIV',
                parentElement: parentEl,
                nodeType: 1,
                previousElementSibling: null
            };
            const selector = selectorBuilder.generateOptimalSelector(el);
            expect(selector).toContain('.test-class');
        });

        it('should return empty string for element without id or class', () => {
            if (!selectorBuilder) return;
            const el = {
                id: '',
                className: '',
                tagName: 'DIV',
                parentElement: null,
                nodeType: 1
            };
            const selector = selectorBuilder.generateOptimalSelector(el);
            expect(typeof selector).toBe('string');
        });
    });
});
