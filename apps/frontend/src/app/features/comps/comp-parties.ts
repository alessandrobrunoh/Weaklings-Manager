import type { BuildRole, BuildSummary, CompBuildEntry } from '../../core/models/api.models';

/** Albion ZvZ party cap — same chunk size as the event roster. */
export const COMP_PARTY_SIZE = 20;

export interface CompPartySeat {
  readonly seatNumber: number;
  readonly globalIndex: number;
  readonly buildId: number;
  readonly build: BuildSummary;
  readonly role: BuildRole;
}

export interface CompPartyView {
  readonly partyNumber: number;
  readonly seats: readonly CompPartySeat[];
}

const ROLE_PRIORITY: Record<BuildRole, number> = {
  tank: 0,
  healer: 1,
  support: 2,
  brawler: 3,
  dps: 4,
  battle_mount: 5,
};

/**
 * Expands each build's quantity into seats, sorts by role, then chunks into
 * parties of {@link COMP_PARTY_SIZE}. The last party may be smaller.
 */
export function simulateCompParties(
  builds: readonly CompBuildEntry[],
  partySize = COMP_PARTY_SIZE,
): CompPartyView[] {
  const allSeats: { buildId: number; build: BuildSummary; role: BuildRole }[] = [];
  for (const entry of builds) {
    for (let i = 0; i < entry.quantity; i++) {
      allSeats.push({
        buildId: entry.build_id,
        build: entry.build,
        role: entry.build.role,
      });
    }
  }

  if (allSeats.length === 0) {
    return [];
  }

  allSeats.sort((a, b) => (ROLE_PRIORITY[a.role] ?? 99) - (ROLE_PRIORITY[b.role] ?? 99));

  const totalParties = Math.ceil(allSeats.length / partySize);
  const parties: CompPartyView[] = [];

  for (let p = 0; p < totalParties; p++) {
    const start = p * partySize;
    const chunk = allSeats.slice(start, start + partySize);
    parties.push({
      partyNumber: p + 1,
      seats: chunk.map((seat, idx) => ({
        seatNumber: idx + 1,
        globalIndex: start + idx + 1,
        buildId: seat.buildId,
        build: seat.build,
        role: seat.role,
      })),
    });
  }

  return parties;
}
