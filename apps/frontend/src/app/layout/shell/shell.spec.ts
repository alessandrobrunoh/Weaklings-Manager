import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { AuthService } from '../../core/services/auth.service';
import { Shell } from './shell';

let pageInstances = 0;

@Component({ selector: 'app-test-dashboard', template: 'dashboard' })
class TestDashboard {
  constructor() {
    pageInstances++;
  }
}

@Component({ selector: 'app-test-events', template: 'events' })
class TestEvents {
  constructor() {
    pageInstances++;
  }
}

/**
 * The real Shell class with a reduced template: the sidebar, topbar and tenant
 * rail are irrelevant here, only the keyed router outlet matters.
 */
async function setup() {
  pageInstances = 0;
  const profile = signal<{ tenant_id: string } | null>({ tenant_id: '111' });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        { path: 'dashboard', component: TestDashboard },
        { path: 'events', component: TestEvents },
      ]),
      { provide: AuthService, useValue: { profile, hasPermission: () => false } },
    ],
  });
  TestBed.overrideComponent(Shell, {
    set: {
      imports: [RouterOutlet],
      template: '@for (pageKey of pageKeys(); track pageKey) { <router-outlet /> }',
    },
  });
  const fixture = TestBed.createComponent(Shell);
  const router = TestBed.inject(Router);
  await router.navigateByUrl('/dashboard');
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, router, profile };
}

describe('Shell tenant switching', () => {
  it('recreates the page when the tenant changes while the URL stays on /dashboard', async () => {
    const { fixture, router, profile } = await setup();
    expect(pageInstances).toBe(1);

    profile.set({ tenant_id: '222' });
    await router.navigateByUrl('/dashboard'); // what TenantRail does after switchTenant
    fixture.detectChanges();
    await fixture.whenStable();

    expect(pageInstances).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('dashboard');
  });

  it('does not recreate the page for a same-URL navigation without a tenant change', async () => {
    const { fixture, router } = await setup();

    await router.navigateByUrl('/dashboard');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(pageInstances).toBe(1);
  });

  it('does not instantiate the old route under the new tenant when switching from another page', async () => {
    const { fixture, router, profile } = await setup();
    await router.navigateByUrl('/events');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(pageInstances).toBe(2);

    profile.set({ tenant_id: '222' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(pageInstances).toBe(2); // the profile change alone must not rebuild /events

    await router.navigateByUrl('/dashboard');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(pageInstances).toBe(3);
    expect(fixture.nativeElement.textContent).toContain('dashboard');
  });
});
