import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';

import {
  dataTableQueriesEqual,
  parseDataTableQuery,
  serializeDataTableQuery,
} from './data-table-query';

describe('data-table-query', () => {
  it('parses search, pagination, sort and column filters from the URL', () => {
    const parsed = parseDataTableQuery(
      convertToParamMap({
        search: 'cta',
        page: '2',
        size: '25',
        sort: '-date',
        status: 'live',
      }),
      { defaultPageSize: 10, filterKeys: ['status', 'role'] },
    );

    expect(parsed).toEqual({
      page: 2,
      pageSize: 25,
      search: 'cta',
      sort: { columnKey: 'date', direction: 'desc' },
      columnFilters: { status: 'live' },
    });
  });

  it('namespaces params when several tables share a page', () => {
    const parsed = parseDataTableQuery(
      convertToParamMap({
        'builds.search': 'tank',
        'builds.role': 'tank',
        search: 'ignored',
        role: 'ignored',
      }),
      { prefix: 'builds', filterKeys: ['role'] },
    );

    expect(parsed.search).toBe('tank');
    expect(parsed.columnFilters).toEqual({ role: 'tank' });
  });

  it('omits default page state so shared URLs stay short', () => {
    const serialized = serializeDataTableQuery(
      {
        page: 1,
        pageSize: 10,
        search: '',
        sort: null,
        columnFilters: { status: '' },
      },
      { defaultPageSize: 10, filterKeys: ['status'] },
    );

    expect(serialized).toEqual({
      search: null,
      page: null,
      size: null,
      sort: null,
      status: null,
    });
  });

  it('writes active filters and descending sort', () => {
    const serialized = serializeDataTableQuery(
      {
        page: 3,
        pageSize: 50,
        search: 'john',
        sort: { columnKey: 'username', direction: 'desc' },
        columnFilters: { role: 'Officer' },
      },
      { defaultPageSize: 10, filterKeys: ['role'] },
    );

    expect(serialized).toEqual({
      search: 'john',
      page: '3',
      size: '50',
      sort: '-username',
      role: 'Officer',
    });
  });

  it('treats empty filter maps as equal', () => {
    expect(
      dataTableQueriesEqual(
        {
          page: 1,
          pageSize: 10,
          search: '',
          sort: null,
          columnFilters: { status: '' },
        },
        {
          page: 1,
          pageSize: 10,
          search: '',
          sort: null,
          columnFilters: {},
        },
      ),
    ).toBe(true);
  });
});
