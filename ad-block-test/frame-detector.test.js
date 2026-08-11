/**
 * FrameDetector 模块测试
 */

describe('FrameDetector', () => {
    let frameDetector;

    beforeEach(() => {
        jest.clearAllMocks();
        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const match = content.match(/const FrameDetector = \{[\s\S]*?\n    \};/);
        if (match) {
            const extract = new Function(match[0] + '; return FrameDetector;');
            frameDetector = extract();
        }
    });

    describe('init', () => {
        it('should set up observer', () => {
            frameDetector.init();
            expect(frameDetector._observer).toBeDefined();
        });
    });

    describe('isSameOrigin', () => {
        it('should return true for same origin URLs', () => {
            const result = frameDetector.isSameOrigin('https://example.com', 'https://example.com/path');
            expect(result).toBe(true);
        });

        it('should return false for different origin URLs', () => {
            const result = frameDetector.isSameOrigin('https://example.com', 'https://other.com');
            expect(result).toBe(false);
        });
    });
});
