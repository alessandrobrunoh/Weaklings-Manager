import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastService } from './toast.service';

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    service = TestBed.inject(ToastService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-dismisses success toasts', () => {
    service.success('saved');
    expect(service.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(service.toasts()).toHaveLength(0);
  });

  it('keeps error toasts until they are dismissed', () => {
    service.error('Conflict: the comp is used by 3 events and cannot be deleted.');
    vi.advanceTimersByTime(10 * 60_000);
    expect(service.toasts()).toHaveLength(1);

    service.dismiss(service.toasts()[0].id);
    expect(service.toasts()).toHaveLength(0);
  });

  it('does not repeat an identical message already on screen', () => {
    service.error('boom');
    service.error('boom');
    expect(service.toasts()).toHaveLength(1);
  });

  it('caps the number of visible toasts, dropping the oldest', () => {
    for (let i = 0; i < 8; i++) {
      service.error(`error ${i}`);
    }
    const messages = service.toasts().map((toast) => toast.message);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toBe('error 3');
    expect(messages[4]).toBe('error 7');
  });
});
