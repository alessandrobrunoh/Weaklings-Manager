import { provideZonelessChangeDetection, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { Blocked } from './blocked';

describe('Blocked', () => {
  let fixture: ComponentFixture<Blocked>;
  let load: ReturnType<typeof vi.fn>;
  let accessBlocked: WritableSignal<boolean>;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    load = vi.fn();
    accessBlocked = signal(true);
    navigate = vi.fn().mockResolvedValue(true);
    await TestBed.configureTestingModule({
      imports: [Blocked],
      providers: [
        provideZonelessChangeDetection(),
        { provide: AuthService, useValue: { load, accessBlocked, logout: vi.fn() } },
        { provide: Router, useValue: { navigate } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Blocked);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  function checkButton(): HTMLButtonElement {
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')];
    return buttons.find((b) => b.textContent?.includes('blocked.check')) as HTMLButtonElement;
  }

  it('says the access is blocked, in words and with an icon', () => {
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toContain('blocked.title');
    expect(element.textContent).toContain('blocked.body');
    expect(element.querySelector('app-icon')).not.toBeNull();
  });

  it('stays put and says so while the block stands', async () => {
    load.mockResolvedValue(null);
    checkButton().click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('blocked.stillBlocked');
  });

  it('returns to the app once the block is lifted', async () => {
    load.mockResolvedValue({ tenant_id: 'g1' });
    checkButton().click();
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith(['/dashboard']);
  });
});
