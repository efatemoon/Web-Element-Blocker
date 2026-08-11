/**
 * 测试环境配置
 * 为 web-element-blocker.user.js 提供 Tampermonkey GM API mock
 */

// Mock Tampermonkey GM APIs
global.GM_registerMenuCommand = jest.fn();
global.GM_setValue = jest.fn();
global.GM_getValue = jest.fn().mockReturnValue(null);
global.GM_deleteValue = jest.fn();
global.GM_addStyle = jest.fn().mockReturnValue({});
global.GM_info = {
    script: { name: 'Web Element Blocker', version: '0.12.0' },
    scriptHandler: 'Tampermonkey'
};

// Mock browser APIs
global.chrome = {
    storage: {
        local: { get: jest.fn(), set: jest.fn() },
        sync: { get: jest.fn(), set: jest.fn() }
    },
    runtime: {
        sendMessage: jest.fn(),
        onMessage: { addListener: jest.fn() }
    }
};

// Mock fetch
global.fetch = jest.fn().mockResolvedValue({
    json: jest.fn().mockResolvedValue({}),
    text: jest.fn().mockResolvedValue('')
});

// Mock WebSocket
global.WebSocket = class MockWebSocket {
    constructor() { this.readyState = 0; }
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
};

// Mock Performance API
global.performance = {
    now: jest.fn().mockReturnValue(0),
    mark: jest.fn(),
    measure: jest.fn(),
    getEntriesByName: jest.fn()
};

// Mock MutationObserver
global.MutationObserver = class MockMutationObserver {
    constructor(callback) { this._callback = callback; }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};

// Mock IntersectionObserver
global.IntersectionObserver = class MockIntersectionObserver {
    constructor(callback) { this._callback = callback; }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
};

// Mock ResizeObserver
global.ResizeObserver = class MockResizeObserver {
    constructor(callback) { this._callback = callback; }
    observe() {}
    disconnect() {}
};

// Mock URL constructor
global.URL = class MockURL {
    constructor(url) {
        this.href = url;
        this.hostname = url.replace(/https?:\/\//, '').split('/')[0];
    }
};

// Mock localStorage
const store = {};
global.localStorage = {
    getItem: jest.fn(key => store[key] || null),
    setItem: jest.fn((key, value) => { store[key] = value; }),
    removeItem: jest.fn(key => { delete store[key]; }),
    clear: jest.fn()
};

// Mock document
Object.defineProperty(global, 'document', {
    value: {
        createElement: jest.fn(() => ({
            style: {},
            classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
            setAttribute: jest.fn(),
            getAttribute: jest.fn(),
            appendChild: jest.fn(),
            removeChild: jest.fn(),
            remove: jest.fn(),
            querySelector: jest.fn(),
            querySelectorAll: jest.fn().mockReturnValue([]),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn()
        })),
        createTextNode: jest.fn(text => ({ textContent: text })),
        getElementById: jest.fn(),
        getElementsByClassName: jest.fn().mockReturnValue([]),
        querySelector: jest.fn(),
        querySelectorAll: jest.fn().mockReturnValue([]),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        body: {
            appendChild: jest.fn(),
            removeChild: jest.fn(),
            style: {},
            classList: { add: jest.fn(), remove: jest.fn() }
        },
        head: {
            appendChild: jest.fn(),
            removeChild: jest.fn()
        },
        readyState: 'complete',
        createElementNS: jest.fn(() => ({
            setAttribute: jest.fn(),
            addEventListener: jest.fn(),
            style: {}
        }))
    },
    writable: true
});

// Mock window
Object.defineProperty(global, 'window', {
    value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        setTimeout: jest.fn(),
        clearTimeout: jest.fn(),
        setInterval: jest.fn(),
        clearInterval: jest.fn(),
        location: { href: 'https://example.com', hostname: 'example.com' },
        self: global,
        top: global,
        getComputedStyle: jest.fn(() => ({
            display: 'block',
            visibility: 'visible',
            opacity: '1'
        })),
        requestAnimationFrame: jest.fn(cb => setTimeout(cb, 0)),
        cancelAnimationFrame: jest.fn(),
        navigator: { sendBeacon: jest.fn() }
    },
    writable: true
});

// Mock console to suppress test output
global.console = {
    ...console,
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn()
};
