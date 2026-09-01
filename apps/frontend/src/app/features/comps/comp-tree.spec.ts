import { describe, expect, it } from 'vitest';

import type { CompSummary } from '../../core/models/api.models';
import {
  buildCompForest,
  filterCompForest,
  flattenCompForest,
} from './comp-tree';

function comp(
  id: number,
  name: string,
  totalQuantity: number,
  parentId: number | null = null,
): CompSummary {
  return {
    id,
    name,
    description: null,
    category_id: 1,
    version: 1,
    category_name: 'ZvZ',
    created_by_username: 'officer',
    created_at: '2026-09-01T00:00:00Z',
    build_count: 1,
    total_quantity: totalQuantity,
    parent_id: parentId,
  };
}

describe('comp expansion tree', () => {
  it('renders an arbitrary expansion chain with depth and capacity increment', () => {
    const forest = buildCompForest([
      comp(10, '10-man', 10),
      comp(15, '15-man', 15, 10),
      comp(20, '20-man', 20, 15),
      comp(25, '25-man', 25, 20),
    ]);

    expect(flattenCompForest(forest, new Set([10, 15, 20]))).toMatchObject([
      { comp: { id: 10 }, depth: 0, capacityIncrement: null },
      { comp: { id: 15 }, depth: 1, capacityIncrement: 5 },
      { comp: { id: 20 }, depth: 2, capacityIncrement: 5 },
      { comp: { id: 25 }, depth: 3, capacityIncrement: 5 },
    ]);
  });

  it('keeps ancestors visible and expanded when a search only matches a deep child', () => {
    const forest = buildCompForest([
      comp(10, '10-man', 10),
      comp(15, '15-man', 15, 10),
      comp(20, '20-man', 20, 15),
    ]);
    const filtered = filterCompForest(forest, (entry) => entry.name === '20-man');

    expect(flattenCompForest(filtered, new Set(), true).map((entry) => entry.comp.id)).toEqual([
      10, 15, 20,
    ]);
  });

  it('honours each branch expansion state independently', () => {
    const forest = buildCompForest([
      comp(10, '10-man', 10),
      comp(15, '15-man', 15, 10),
      comp(20, '20-man', 20, 15),
      comp(30, '30-man', 30),
      comp(35, '35-man', 35, 30),
    ]);

    expect(flattenCompForest(forest, new Set([10])).map((entry) => entry.comp.id)).toEqual([
      10, 15, 30,
    ]);
  });

  it('renders each legacy cyclic comp at most once as a recovery root', () => {
    const forest = buildCompForest([
      comp(10, '10-man', 10, 15),
      comp(15, '15-man', 15, 10),
      comp(20, '20-man', 20),
    ]);

    const rows = flattenCompForest(forest, new Set([10, 15]), true);
    expect(rows.map((entry) => entry.comp.id).sort()).toEqual([10, 15, 20]);
    expect(new Set(rows.map((entry) => entry.comp.id)).size).toBe(3);
  });

  it('renders a comp with a missing parent as a recovery root', () => {
    const forest = buildCompForest([
      comp(10, '10-man', 10),
      comp(15, 'orphaned 15-man', 15, 999),
    ]);

    const rows = flattenCompForest(forest, new Set(), true);
    expect(rows.map((entry) => entry.comp.id)).toEqual([10, 15]);
    expect(rows[1]).toMatchObject({ depth: 0, capacityIncrement: null });
  });
});
