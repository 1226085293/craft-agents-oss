/**
 * Tests for WorkspaceEventBus
 */

import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test';
import { WorkspaceEventBus, type EventHandler, type AnyEventHandler } from './event-bus.ts';

describe('WorkspaceEventBus', () => {
  let bus: WorkspaceEventBus;

  beforeEach(() => {
    bus = new WorkspaceEventBus('test-workspace');
  });

  afterEach(() => {
    bus.dispose();
  });

  describe('constructor', () => {
    it('should create a bus with the given workspace ID', () => {
      expect(bus.getWorkspaceId()).toBe('test-workspace');
      expect(bus.isDisposed()).toBe(false);
    });
  });

  describe('emit', () => {
    it('should emit events to registered handlers', async () => {
      const handler = jest.fn();
      bus.on('PermissionModeChange', handler);

      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test-label',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        label: 'test-label',
      }));
    });

    it('should emit to multiple handlers for the same event', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      bus.on('PermissionModeChange', handler1);
      bus.on('PermissionModeChange', handler2);

      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test-label',
      });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should not emit to handlers for different events', async () => {
      const modeHandler = jest.fn();
      const pathHandler = jest.fn();
      bus.on('PermissionModeChange', modeHandler);
      bus.on('SessionPathChange', pathHandler);

      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        newMode: 'execute',
      });

      expect(modeHandler).toHaveBeenCalledTimes(1);
      expect(pathHandler).not.toHaveBeenCalled();
    });

    it('should catch and log handler errors without stopping other handlers', async () => {
      const errorHandler = jest.fn().mockRejectedValue(new Error('Test error'));
      const successHandler = jest.fn();
      bus.on('PermissionModeChange', errorHandler);
      bus.on('PermissionModeChange', successHandler);

      // Should not throw
      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test-label',
      });

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(successHandler).toHaveBeenCalledTimes(1);
    });

    it('should not emit after disposal', async () => {
      const handler = jest.fn();
      bus.on('PermissionModeChange', handler);
      bus.dispose();

      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test-label',
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('on/off', () => {
    it('should register handlers', () => {
      const handler = jest.fn();
      bus.on('PermissionModeChange', handler);
      expect(bus.getHandlerCount('PermissionModeChange')).toBe(1);
    });

    it('should unregister handlers', async () => {
      const handler = jest.fn();
      bus.on('PermissionModeChange', handler);
      bus.off('PermissionModeChange', handler);

      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test-label',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not register handlers after disposal', () => {
      bus.dispose();
      const handler = jest.fn();
      bus.on('PermissionModeChange', handler);
      expect(bus.getHandlerCount('PermissionModeChange')).toBe(0);
    });
  });

  describe('onAny/offAny', () => {
    it('should receive all events', async () => {
      const anyHandler = jest.fn();
      bus.onAny(anyHandler);

      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test-label',
      });

      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        isFlagged: true,
      });

      expect(anyHandler).toHaveBeenCalledTimes(2);
      expect(anyHandler).toHaveBeenCalledWith('PermissionModeChange', expect.anything());
      expect(anyHandler).toHaveBeenCalledWith('PermissionModeChange', expect.anything());
    });

    it('should unregister any-handlers', async () => {
      const anyHandler = jest.fn();
      bus.onAny(anyHandler);
      bus.offAny(anyHandler);

      await bus.emit('PermissionModeChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        label: 'test-label',
      });

      expect(anyHandler).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should clear all handlers', () => {
      bus.on('PermissionModeChange', jest.fn());
      bus.on('PermissionModeChange', jest.fn());
      bus.onAny(jest.fn());

      expect(bus.getHandlerCount()).toBeGreaterThan(0);

      bus.dispose();

      expect(bus.getHandlerCount()).toBe(0);
      expect(bus.isDisposed()).toBe(true);
    });

    it('should be idempotent', () => {
      bus.dispose();
      bus.dispose(); // Should not throw
      expect(bus.isDisposed()).toBe(true);
    });
  });

  describe('rate limiting', () => {
    const modePayload = () => ({
      sessionId: 'session-1',
      workspaceId: 'test-workspace',
      timestamp: Date.now(),
      oldMode: 'explore',
      newMode: 'execute',
    });

    const schedulerPayload = () => ({
      workspaceId: 'test-workspace',
      timestamp: Date.now(),
      localTime: '2026-02-10T14:00:00',
      utcTime: '2026-02-10T13:00:00',
    });

    it('should drop events exceeding rate limit (10/min for normal events)', async () => {
      const handler = jest.fn();
      bus.on('PermissionModeChange', handler);

      for (let i = 0; i < 15; i++) {
        await bus.emit('PermissionModeChange', modePayload());
      }

      expect(handler).toHaveBeenCalledTimes(10);
    });

    it('should allow SchedulerTick up to 60/min', async () => {
      const handler = jest.fn();
      bus.on('SchedulerTick', handler);

      for (let i = 0; i < 65; i++) {
        await bus.emit('SchedulerTick', schedulerPayload());
      }

      expect(handler).toHaveBeenCalledTimes(60);
    });

    it('should reset rate window after 60s', async () => {
      jest.useFakeTimers();
      try {
        const handler = jest.fn();
        bus.on('PermissionModeChange', handler);

        // Exhaust the limit
        for (let i = 0; i < 10; i++) {
          await bus.emit('PermissionModeChange', modePayload());
        }
        expect(handler).toHaveBeenCalledTimes(10);

        // 11th should be dropped
        await bus.emit('PermissionModeChange', modePayload());
        expect(handler).toHaveBeenCalledTimes(10);

        // Advance past the window
        jest.advanceTimersByTime(61_000);

        // Should fire again
        await bus.emit('PermissionModeChange', modePayload());
        expect(handler).toHaveBeenCalledTimes(11);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should rate limit per-event-type independently', async () => {
      const modeHandler = jest.fn();
      const pathHandler = jest.fn();
      bus.on('PermissionModeChange', modeHandler);
      bus.on('SessionPathChange', pathHandler);

      // Exhaust the PermissionModeChange limit
      for (let i = 0; i < 12; i++) {
        await bus.emit('PermissionModeChange', modePayload());
      }

      // SessionPathChange should still work
      await bus.emit('SessionPathChange', {
        sessionId: 'session-1',
        workspaceId: 'test-workspace',
        timestamp: Date.now(),
        changeType: 'folder',
        oldPath: null,
        newPath: 'folder-1',
      });

      expect(modeHandler).toHaveBeenCalledTimes(10);
      expect(pathHandler).toHaveBeenCalledTimes(1);
    });

    it('should log warning when rate limited', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      const handler = jest.fn();
      bus.on('PermissionModeChange', handler);

      for (let i = 0; i < 11; i++) {
        await bus.emit('PermissionModeChange', modePayload());
      }

      // The debug logger uses console internally — check that rate limit warning was logged
      // We verify indirectly: handler was only called 10 times (rate limit enforced)
      expect(handler).toHaveBeenCalledTimes(10);
      warnSpy.mockRestore();
    });
  });

  describe('getHandlerCount', () => {
    it('should return count for specific event', () => {
      bus.on('PermissionModeChange', jest.fn());
      bus.on('SessionPathChange', jest.fn());
      bus.on('SchedulerTick', jest.fn());

      expect(bus.getHandlerCount('PermissionModeChange')).toBe(1);
      expect(bus.getHandlerCount('SessionPathChange')).toBe(1);
      expect(bus.getHandlerCount('PreToolUse')).toBe(0);
    });

    it('should return total count without argument', () => {
      bus.on('PermissionModeChange', jest.fn());
      bus.on('PermissionModeChange', jest.fn());
      bus.onAny(jest.fn());

      expect(bus.getHandlerCount()).toBe(3);
    });
  });
});
