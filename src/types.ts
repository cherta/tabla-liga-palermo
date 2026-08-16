export interface Standing {
  position: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  goalDifference: number;
}

export interface Goal {
  team: string;
  player: string;
  goals: number;
}

export interface MatchDetails {
  date: string | null;
  venue: string;
  sourceTeam: string;
  goals: Goal[];
  note: string | null;
}

export interface Match {
  round: string;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  details?: MatchDetails;
}

export interface NextGame {
  home: string;
  away: string;
}

export interface LeagueCategory {
  name: string;
  competitions: Record<Competition, CompetitionCategory>;
}

export type Competition = 'apertura' | 'clausura' | 'anual';

export interface CompetitionCategory {
  standings: Standing[];
  results: Match[];
  nextGames: NextGame[];
}

export interface LeagueData {
  updatedAt: string;
  division: string;
  source: {
    pageUrl: string;
    resultsPdfUrl: string;
    standingsPdfUrls: Record<Competition, string>;
    resultsCsvUrl: string;
    standingsCsvUrls: Record<Competition, string>;
    matchDetailCsvUrls: string[];
    discoveredPdfUrls: string[];
  };
  generalTables: Record<Competition, Standing[]>;
  categories: LeagueCategory[];
}
