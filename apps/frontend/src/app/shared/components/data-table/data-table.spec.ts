import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { TranslateService } from '../../../core/services/translate.service';
import { DataTable, type DataTableColumn } from './data-table';

interface Row {
  readonly id: number;
  readonly name: string;
  readonly status: string;
}

const rows: readonly Row[] = [
  { id: 1, name: 'Alpha', status: 'open' },
  { id: 2, name: 'Bravo', status: 'closed' },
];

function columns(): readonly DataTableColumn<Row>[] {
  return [
    {
      key: 'name',
      label: 'common.name',
      searchable: true,
      accessor: (row) => row.name,
    },
    {
      key: 'status',
      label: 'common.status',
      accessor: (row) => row.status,
      filterOptions: [
        { value: 'open', label: 'Open' },
        { value: 'closed', label: 'Closed' },
      ],
    },
  ];
}

describe('DataTable', () => {
  let fixture: ComponentFixture<DataTable<Row>>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DataTable],
      providers: [provideZonelessChangeDetection(), provideRouter([]), TranslateService],
    }).compileComponents();

    fixture = TestBed.createComponent(DataTable<Row>);
    fixture.componentRef.setInput('columns', columns());
    fixture.componentRef.setInput('rows', rows);
    fixture.componentRef.setInput('trackBy', (row: Row) => row.id);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('filters client rows by the shared search input', async () => {
    const input = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;

    input.value = 'brav';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    const body = fixture.nativeElement.querySelector('tbody')?.textContent ?? '';
    expect(body).toContain('Bravo');
    expect(body).not.toContain('Alpha');
  });

  it('emits server queries after a debounced search', async () => {
    vi.useFakeTimers();
    fixture.componentRef.setInput('serverMode', true);
    fixture.componentRef.setInput('totalItems', rows.length);
    fixture.detectChanges();
    await fixture.whenStable();

    const changes: Array<{ search: string }> = [];
    fixture.componentInstance.pageChange.subscribe((change) => changes.push(change));
    const input = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;

    input.value = 'brav';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(changes.at(-1)?.search).toBe('brav');
  });

  it('keeps active search when the host recreates equivalent columns', async () => {
    const input = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
    input.value = 'alpha';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentRef.setInput('columns', columns());
    fixture.detectChanges();
    await fixture.whenStable();

    expect(
      (fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement).value,
    ).toBe('alpha');
  });

  it('filters client rows by the column dropdown', async () => {
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'closed';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    const body = fixture.nativeElement.querySelector('tbody')?.textContent ?? '';
    expect(body).toContain('Bravo');
    expect(body).not.toContain('Alpha');
  });

  it('emits rowClick when the row body is activated, not when a nested button is clicked', async () => {
    fixture.componentRef.setInput('rowClickable', true);
    fixture.detectChanges();
    await fixture.whenStable();

    const clicked: Row[] = [];
    fixture.componentInstance.rowClick.subscribe((row) => clicked.push(row));

    const firstRow = fixture.nativeElement.querySelector('tbody tr') as HTMLTableRowElement;
    firstRow.click();
    expect(clicked).toEqual([rows[0]]);

    clicked.length = 0;
    const nested = document.createElement('button');
    firstRow.appendChild(nested);
    nested.click();
    expect(clicked).toEqual([]);
  });

  it('writes column filters into the URL', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'open';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: expect.objectContaining({ status: 'open' }),
        queryParamsHandling: 'merge',
        replaceUrl: true,
      }),
    );
  });
});
