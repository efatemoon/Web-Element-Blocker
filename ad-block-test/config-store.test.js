/**
 * ConfigStore 模块测试
 */

describe('ConfigStore', () => {
    let configStore;

    beforeEach(() => {
        jest.clearAllMocks();
        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const match = content.match(/const ConfigStore = \{[\s\S]*?\n    \};/);
        if (match) {
            const extract = new Function(match[0] + '; return ConfigStore;');
            configStore = extract();
        }
    });

    describe('get', () => {
        it('should return undefined for unknown key', () => {
            const result = configStore.get('unknownKey');
            expect(result).toBeUndefined();
        });
    });

    describe('set', () => {
        it('should store and retrieve values', () => {
            configStore.set('testKey', 'testValue');
            expect(configStore.get('testKey')).toBe('testValue');
        });
    });

    describe('has', () => {
        it('should return true for existing key', () => {
            configStore.set('existingKey', 'value');
            expect(configStore.has('existingKey')).toBe(true);
        });

        it('should return false for non-existing key', () => {
            expect(configStore.has('nonExistingKey')).toBe(false);
        });
    });
});
