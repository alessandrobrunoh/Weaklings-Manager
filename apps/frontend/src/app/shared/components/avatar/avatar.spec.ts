import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { Avatar } from './avatar';

describe('Avatar', () => {
  let fixture: ComponentFixture<Avatar>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Avatar],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(Avatar);
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('renders fallback initials when no avatar is provided', async () => {
    fixture.componentRef.setInput('username', 'Alessandro Bruno');
    fixture.detectChanges();
    await fixture.whenStable();

    const img = fixture.nativeElement.querySelector('img');
    const span = fixture.nativeElement.querySelector('span');

    expect(img).toBeNull();
    expect(span?.textContent?.trim()).toBe('AB');
  });

  it('renders 2-character initials for single word names', async () => {
    fixture.componentRef.setInput('username', 'weakling');
    fixture.detectChanges();
    await fixture.whenStable();

    const span = fixture.nativeElement.querySelector('span');
    expect(span?.textContent?.trim()).toBe('WE');
  });

  it('renders ? for empty or whitespace username', async () => {
    fixture.componentRef.setInput('username', '   ');
    fixture.detectChanges();
    await fixture.whenStable();

    const span = fixture.nativeElement.querySelector('span');
    expect(span?.textContent?.trim()).toBe('?');
  });

  it('uses full HTTP / HTTPS avatar URL when provided', async () => {
    fixture.componentRef.setInput('avatar', 'https://example.com/custom-avatar.png');
    fixture.componentRef.setInput('username', 'Test User');
    fixture.detectChanges();
    await fixture.whenStable();

    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe('https://example.com/custom-avatar.png');
  });

  it('constructs Discord CDN URL for static avatar hash', async () => {
    fixture.componentRef.setInput('userId', '386488773351047168');
    fixture.componentRef.setInput('avatar', '855476a6be8c962b8813bc30f6de92a7');
    fixture.detectChanges();
    await fixture.whenStable();

    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe(
      'https://cdn.discordapp.com/avatars/386488773351047168/855476a6be8c962b8813bc30f6de92a7.webp?size=128',
    );
  });

  it('constructs Discord CDN URL with .gif for animated avatar hash (a_ prefix)', async () => {
    fixture.componentRef.setInput('userId', '386488773351047168');
    fixture.componentRef.setInput('avatar', 'a_855476a6be8c962b8813bc30f6de92a7');
    fixture.detectChanges();
    await fixture.whenStable();

    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe(
      'https://cdn.discordapp.com/avatars/386488773351047168/a_855476a6be8c962b8813bc30f6de92a7.gif?size=128',
    );
  });

  it('calculates Discord default avatar for snowflake userId when avatar is null', async () => {
    fixture.componentRef.setInput('userId', '386488773351047168');
    fixture.componentRef.setInput('avatar', null);
    fixture.detectChanges();
    await fixture.whenStable();

    // (BigInt('386488773351047168') >> 22n) % 6n = 1n
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe('https://cdn.discordapp.com/embed/avatars/1.png');
  });

  it('falls back to initials when numeric userId is internal id (<10 digits) and avatar is null', async () => {
    fixture.componentRef.setInput('userId', 42);
    fixture.componentRef.setInput('avatar', null);
    fixture.componentRef.setInput('username', 'Officer John');
    fixture.detectChanges();
    await fixture.whenStable();

    const img = fixture.nativeElement.querySelector('img');
    expect(img).toBeNull();
    const span = fixture.nativeElement.querySelector('span');
    expect(span?.textContent?.trim()).toBe('OJ');
  });

  it('falls back gracefully to initials when image loading fails with error event', async () => {
    fixture.componentRef.setInput('userId', '386488773351047168');
    fixture.componentRef.setInput('avatar', 'broken_avatar');
    fixture.componentRef.setInput('username', 'Broken User');
    fixture.detectChanges();
    await fixture.whenStable();

    let img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();

    img.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    await fixture.whenStable();

    img = fixture.nativeElement.querySelector('img');
    expect(img).toBeNull();
    const span = fixture.nativeElement.querySelector('span');
    expect(span?.textContent?.trim()).toBe('BU');
  });

  it('applies sizes and shapes correctly', async () => {
    fixture.componentRef.setInput('size', 'lg');
    fixture.componentRef.setInput('shape', 'rounded');
    fixture.componentRef.setInput('username', 'Admin');
    fixture.detectChanges();
    await fixture.whenStable();

    const container = fixture.nativeElement.firstElementChild as HTMLElement;
    expect(container.classList.contains('h-16')).toBe(true);
    expect(container.classList.contains('w-16')).toBe(true);
    expect(container.classList.contains('rounded-2xl')).toBe(true);
  });
});
