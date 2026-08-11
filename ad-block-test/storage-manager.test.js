/**
 * StorageManager 模块测试
 */

describe('StorageManager', () => {
    let storageManager;

    beforeEach(() => {
        jest.clearAllMocks();
        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const match = content.match(/class StorageManager[\s\S]*?\n\};/);
        if (match) {
            const extract = new Function(match[0] + '; return StorageManager;');
            const StorageManagerClass = extract();
            storageManager = new StorageManagerClass();
        }
    });

    describe('constructor', () => {
        it('should initialize with empty data', () => {
            expect(storageManager.data).toBeDefined();
        });
    });

    describe('_flush', () => {
        it('should call GM_setValue', () => {
            storageManager._flush();
            expect(GM_setValue).toHaveBeenCalled();
        });
    });

    describe('invalidateDataCache', () => {
        it('should clear cached data', () => {
            storageManager._cachedData = { test: 'data' };
            storageManager.invalidateDataCache();
            expect(storageManager._cachedData).toBeUndefined();
        });
    });
});
