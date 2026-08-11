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

        // Mock ProtectedCheck before extracting ElementHider
        global.ProtectedCheck = {
            isProtected: jest.fn(() => false)
        };

        const match = content.match(/const ElementHider = \{[\s\S]*?\n    \};/);
        if (match) {
            const extract = new Function(match[0] + '; return ElementHider;');
            elementHider = extract();
        }
    });

    describe('hideElement', () => {
        it('should set display none on element', () => {
            const el = { 
                style: { 
                    setProperty: jest.fn(),
                    removeProperty: jest.fn()
                }, 
                classList: { add: jest.fn() } 
            };
            elementHider.hideElement(el);
            expect(el.style.setProperty).toHaveBeenCalledWith('display', 'none', 'important');
        });

        it('should not hide protected elements', () => {
            global.ProtectedCheck.isProtected.mockReturnValue(true);
            const el = { style: { setProperty: jest.fn() } };
            elementHider.hideElement(el);
            expect(el.style.setProperty).not.toHaveBeenCalled();
        });
    });

    describe('showElement', () => {
        it('should clear display style', () => {
            const el = { 
                style: { 
                    removeProperty: jest.fn(),
                    display: 'none'
                } 
            };
            elementHider.showElement(el);
            expect(el.style.removeProperty).toHaveBeenCalledWith('display');
        });

        it('should handle null element', () => {
            elementHider.showElement(null);
            // Should not throw
        });
    });
});
