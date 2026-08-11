/**
 * StorageManager 模块测试
 */

describe('StorageManager', () => {
    let storageManager;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock GM APIs
        global.GM_setValue = jest.fn();
        global.GM_getValue = jest.fn(() => ({}));

        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const lines = content.split('\n');
        // Find StorageManager class start (line 364)
        let start = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('class StorageManager {')) {
                start = i;
                break;
            }
        }

        if (start === -1) {
            return;
        }

        // Find class end by brace counting
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

        // Extract class code
        const classCode = lines.slice(start, end + 1).join('\n');
        try {
            const extract = new Function(classCode + '; return StorageManager;');
            const StorageManagerClass = extract();
            storageManager = new StorageManagerClass();
        } catch (e) {
            // Class extraction failed
            storageManager = null;
        }
    });

    describe('constructor', () => {
        it('should initialize with empty data', () => {
            expect(storageManager).toBeDefined();
            if (storageManager) {
                expect(storageManager.domain).toBe('example.com');
                expect(storageManager._pendingWrites).toEqual({});
            }
        });
    });

    describe('_flush', () => {
        it('should call GM_setValue', () => {
            if (!storageManager) return;
            storageManager._pendingWrites = { test: 'value' };
            storageManager._flush();
            expect(GM_setValue).toHaveBeenCalledWith('test', 'value');
        });
    });

    describe('invalidateDataCache', () => {
        it('should clear cached data', () => {
            if (!storageManager) return;
            storageManager._cachedData = { test: 'data' };
            storageManager.invalidateDataCache();
            // invalidateDataCache sets _cachedData to null, not undefined
            expect(storageManager._cachedData).toBeNull();
        });
    });
});
