import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TranslateService } from '../../../core/services/translate.service';
import type { DestinyItemNode } from '../../data/albion-destiny-board';
import { DestinyBoard } from './destiny-board';

function item(
  identifier: string,
  name: string,
  category: 'weapon' | 'armor',
  level = 0,
): DestinyItemNode {
  return {
    node_key: `${category}:${identifier}`,
    node_name: name,
    category,
    level,
    icon: null,
    identifier,
  };
}

const SAMPLE: DestinyItemNode[] = [
  { ...item('2H_BOW_HELL', 'Wailing Bow', 'weapon', 45), icon: 'https://render.example/wailing.png' },
  { ...item('2H_BOW', 'Bow', 'weapon', 120), icon: 'https://render.example/bow.png' },
  item('2H_WARBOW', 'Warbow', 'weapon', 80),
  item('MAIN_SWORD', 'Broadsword', 'weapon', 0),
  item('SHOES_PLATE_KEEPER', 'Judicator Boots', 'armor', 30),
  item('SHOES_PLATE_SET1', 'Soldier Boots', 'armor', 10),
];

describe('DestinyBoard', () => {
  let fixture: ComponentFixture<DestinyBoard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DestinyBoard],
      providers: [provideZonelessChangeDetection(), TranslateService],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(DestinyBoard);
    fixture.componentRef.setInput('nodes', SAMPLE);
    fixture.componentRef.setInput('editable', true);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function nodeButton(label: string): SVGGElement | undefined {
    return [...fixture.nativeElement.querySelectorAll('[role="button"]')].find((el) =>
      (el as SVGElement).getAttribute('aria-label')?.includes(label),
    ) as SVGGElement | undefined;
  }

  it('zooms the map from the overlay controls', () => {
    const scene = () => fixture.nativeElement.querySelector('.destiny-scene') as HTMLElement;
    expect(scene().style.transform).toContain('scale(1.7)');
    const zoomIn = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button) => (button as HTMLButtonElement).getAttribute('aria-label') === 'Zoom in',
    ) as HTMLButtonElement;
    zoomIn.click();
    fixture.detectChanges();
    expect(scene().style.transform).toContain('scale(2.125)');
    const reset = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button) => (button as HTMLButtonElement).getAttribute('aria-label') === 'Fit',
    ) as HTMLButtonElement;
    reset.click();
    fixture.detectChanges();
    expect(scene().style.transform).toContain('scale(1.7)');
  });

  it('renders a radial map with Weapons and Armor hubs', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(fixture.nativeElement.querySelector('svg')).toBeTruthy();
    expect(text).toContain('Weapons');
    expect(text).toContain('Armor');
    expect(text).toContain('Bows');
    expect(nodeButton('Wailing Bow')).toBeTruthy();
    const icon = fixture.nativeElement.querySelector(
      'image[href="https://render.example/wailing.png"]',
    );
    expect(icon).toBeTruthy();
  });

  it('opens the inspector with a slider when a weapon is clicked', async () => {
    nodeButton('Wailing Bow')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    const slider = fixture.nativeElement.querySelector('#destiny-slider') as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.value).toBe('45');
    expect(fixture.nativeElement.textContent).toContain('Wailing Bow');
    expect(fixture.nativeElement.textContent).toContain('Reset item');
  });

  it('search for wailing keeps the bow path and drops swords', async () => {
    const search = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
    search.value = 'wailing';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(nodeButton('Wailing Bow')).toBeTruthy();
    expect(nodeButton('Broadsword')).toBeUndefined();
    expect(nodeButton('Judicator Boots')).toBeUndefined();
    expect(fixture.nativeElement.textContent).toContain('Bows');
  });

  it('emits the edited draft on save after moving the slider', async () => {
    const emitted: DestinyItemNode[][] = [];
    fixture.componentInstance.save.subscribe((nodes) => emitted.push(nodes));

    nodeButton('Wailing Bow')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    const slider = fixture.nativeElement.querySelector('#destiny-slider') as HTMLInputElement;
    slider.value = '90';
    slider.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    const save = [...fixture.nativeElement.querySelectorAll('button')].find((button) =>
      (button as HTMLButtonElement).textContent?.includes('Save specializations'),
    ) as HTMLButtonElement;
    save.click();
    fixture.detectChanges();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].find((node) => node.node_key === 'weapon:2H_BOW_HELL')?.level).toBe(90);
  });

  it('raises every bow when the Bows branch slider is moved', async () => {
    nodeButton('Bows')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    const slider = fixture.nativeElement.querySelector('#destiny-slider') as HTMLInputElement;
    slider.value = '100';
    slider.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    const emitted: DestinyItemNode[][] = [];
    fixture.componentInstance.save.subscribe((nodes) => emitted.push(nodes));
    const save = [...fixture.nativeElement.querySelectorAll('button')].find((button) =>
      (button as HTMLButtonElement).textContent?.includes('Save specializations'),
    ) as HTMLButtonElement;
    save.click();

    const byId = new Map(emitted[0].map((node) => [node.node_key, node.level]));
    expect(byId.get('weapon:2H_BOW')).toBe(100);
    expect(byId.get('weapon:2H_WARBOW')).toBe(100);
    expect(byId.get('weapon:2H_BOW_HELL')).toBe(100);
    expect(byId.get('weapon:MAIN_SWORD')).toBe(0);
  });

  it('resets the whole board from the centre hub', async () => {
    nodeButton('Combat')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    (fixture.componentInstance as unknown as { resetBoard: () => void }).resetBoard();
    fixture.detectChanges();
    await fixture.whenStable();

    const emitted: DestinyItemNode[][] = [];
    fixture.componentInstance.save.subscribe((nodes) => emitted.push(nodes));
    const save = [...fixture.nativeElement.querySelectorAll('button')].find((button) =>
      (button as HTMLButtonElement).textContent?.includes('Save specializations'),
    ) as HTMLButtonElement;
    save.click();
    expect(emitted[0].every((node) => node.level === 0)).toBe(true);
  });

  it('clamps an out-of-range level to 120 before save', async () => {
    const emitted: DestinyItemNode[][] = [];
    fixture.componentInstance.save.subscribe((nodes) => emitted.push(nodes));

    nodeButton('Wailing Bow')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    const number = fixture.nativeElement.querySelector('input[type="number"]') as HTMLInputElement;
    number.value = '121';
    number.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    const save = [...fixture.nativeElement.querySelectorAll('button')].find((button) =>
      (button as HTMLButtonElement).textContent?.includes('Save specializations'),
    ) as HTMLButtonElement;
    save.click();
    expect(emitted[0].find((node) => node.node_key === 'weapon:2H_BOW_HELL')?.level).toBe(120);
  });

  it('hides the slider when the board is read-only', async () => {
    fixture.componentRef.setInput('editable', false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('#destiny-slider')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('input[type="number"]').length).toBe(0);
  });
});
