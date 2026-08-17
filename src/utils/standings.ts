import type { Standing } from '../types';

export function sortStandings(rows: Standing[]): Standing[] {
  return [...rows]
    .sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference)
    .map((row, index) => ({ ...row, position: index + 1 }));
}
