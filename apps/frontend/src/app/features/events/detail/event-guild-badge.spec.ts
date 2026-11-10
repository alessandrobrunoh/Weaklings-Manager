import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { TranslateService } from '../../../core/services/translate.service';
import { EventGuildBadge } from './event-guild-badge';

function render(guild: { tenant_id: string; name: string } | null | undefined) {
  TestBed.configureTestingModule({
    imports: [EventGuildBadge],
    providers: [
      {
        provide: TranslateService,
        useValue: {
          t: (key: string, params?: Record<string, string>) =>
            params ? `${key}:${params['name']}` : key,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(EventGuildBadge);
  fixture.componentRef.setInput('guild', guild);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('EventGuildBadge', () => {
  it('names the guild the participant signed up for', () => {
    const host = render({ tenant_id: 'guild-a', name: 'Weaklings' });

    const badge = host.querySelector('.event-guild-badge');
    expect(badge?.textContent?.trim()).toBe('Weaklings');
  });

  it('renders nothing when the participant is unattributed or the event is not linked', () => {
    expect(render(null).querySelector('.event-guild-badge')).toBeNull();
  });

  it('renders nothing when the backend omits the field entirely', () => {
    expect(render(undefined).querySelector('.event-guild-badge')).toBeNull();
  });
});
