/**
 * EventBus 模块测试
 */

describe('EventBus', () => {
    let eventBus;

    beforeEach(() => {
        jest.clearAllMocks();
        const fs = require('fs');
        const path = require('path');
        const content = fs.readFileSync(
            path.join(__dirname, '..', 'web-element-blocker.user.js'),
            'utf8'
        );

        const match = content.match(/const EventBus = \{[\s\S]*?\n    \};/);
        if (match) {
            const extract = new Function(match[0] + '; return EventBus;');
            eventBus = extract();
        }
    });

    describe('on', () => {
        it('should register event handler', () => {
            const handler = jest.fn();
            eventBus.on('test:event', handler);
            eventBus.emit('test:event', { data: 'test' });
            expect(handler).toHaveBeenCalled();
            expect(handler.mock.calls[0][0]).toEqual({ data: 'test' });
        });
    });

    describe('off', () => {
        it('should remove event handler', () => {
            const handler = jest.fn();
            eventBus.on('test:event', handler);
            eventBus.off('test:event', handler);
            eventBus.emit('test:event');
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe('emit', () => {
        it('should call all registered handlers', () => {
            const handler1 = jest.fn();
            const handler2 = jest.fn();
            eventBus.on('test:event', handler1);
            eventBus.on('test:event', handler2);
            eventBus.emit('test:event', { payload: 'data' });
            expect(handler1).toHaveBeenCalled();
            expect(handler2).toHaveBeenCalled();
        });
    });
});
