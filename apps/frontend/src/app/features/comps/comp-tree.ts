import type { CompSummary } from '../../core/models/api.models';

/** A composition placed in its expansion hierarchy. */
export interface CompTreeNode {
  comp: CompSummary;
  children: CompTreeNode[];
  depth: number;
  /** Additional capacity contributed by this expansion, or `null` for a root. */
  capacityIncrement: number | null;
  isLastSibling: boolean;
}

const compareComps = (left: CompSummary, right: CompSummary): number =>
  left.total_quantity - right.total_quantity ||
  left.name.localeCompare(right.name) ||
  left.id - right.id;

function withSiblingMetadata(nodes: readonly CompTreeNode[]): CompTreeNode[] {
  return nodes.map((node, index) => ({
    ...node,
    isLastSibling: index === nodes.length - 1,
  }));
}

/**
 * Builds a complete, deterministic comp forest from the API's flat parent links.
 * Invalid legacy links (including cycles) are emitted once as recovery roots.
 */
export function buildCompForest(comps: readonly CompSummary[]): CompTreeNode[] {
  const sorted = [...comps].sort(compareComps);
  const compIds = new Set(sorted.map((comp) => comp.id));
  const childrenByParent = new Map<number, CompSummary[]>();

  for (const comp of sorted) {
    if (comp.parent_id !== null && compIds.has(comp.parent_id)) {
      const children = childrenByParent.get(comp.parent_id) ?? [];
      children.push(comp);
      childrenByParent.set(comp.parent_id, children);
    }
  }

  const visited = new Set<number>();
  const visit = (
    comp: CompSummary,
    depth: number,
    parentCapacity: number | null,
  ): CompTreeNode | null => {
    if (visited.has(comp.id)) {
      return null;
    }

    visited.add(comp.id);
    const children = (childrenByParent.get(comp.id) ?? [])
      .map((child) => visit(child, depth + 1, comp.total_quantity))
      .filter((child): child is CompTreeNode => child !== null);

    return {
      comp,
      children: withSiblingMetadata(children),
      depth,
      capacityIncrement: parentCapacity === null ? null : comp.total_quantity - parentCapacity,
      isLastSibling: false,
    };
  };

  const roots = sorted
    .filter((comp) => comp.parent_id === null || !compIds.has(comp.parent_id))
    .map((comp) => visit(comp, 0, null))
    .filter((node): node is CompTreeNode => node !== null);

  // A cycle has no natural root. Render the first unvisited member as a root so
  // administrators can still inspect and repair historical malformed data.
  for (const comp of sorted) {
    const recoveryRoot = visit(comp, 0, null);
    if (recoveryRoot !== null) {
      roots.push(recoveryRoot);
    }
  }

  return withSiblingMetadata(roots);
}

/**
 * Retains matching nodes and the ancestor path required to reach each match.
 * The source forest is never mutated.
 */
export function filterCompForest(
  forest: readonly CompTreeNode[],
  matches: (comp: CompSummary) => boolean,
): CompTreeNode[] {
  const filterNode = (node: CompTreeNode): CompTreeNode | null => {
    const children = withSiblingMetadata(
      node.children
        .map(filterNode)
        .filter((child): child is CompTreeNode => child !== null),
    );

    if (!matches(node.comp) && children.length === 0) {
      return null;
    }

    return { ...node, children };
  };

  return withSiblingMetadata(
    forest.map(filterNode).filter((node): node is CompTreeNode => node !== null),
  );
}

/**
 * Produces visible table rows according to the individual expansion state.
 * `forceExpand` is used while filtering so a matching deep descendant is visible.
 */
export function flattenCompForest(
  forest: readonly CompTreeNode[],
  expandedIds: ReadonlySet<number>,
  forceExpand = false,
): CompTreeNode[] {
  const rows: CompTreeNode[] = [];

  const visit = (node: CompTreeNode): void => {
    rows.push(node);
    if (forceExpand || expandedIds.has(node.comp.id)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  for (const root of forest) {
    visit(root);
  }

  return rows;
}
