import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PAGE_URL = 'https://www.ligapalermo.org/serie-b-2026/';
const SHEET_ID = '2PACX-1vSdAJR-xfu56IvAEhKLWretxCs4W6BFtbuUPa9eJyqFmyjwRcnSc7ipcJwmixnXm3AONshXgSPTDkPk';
const RESULTS_GID = '1110485064';
const STANDINGS_GID = '491172477';
const OUTPUT_PATH = resolve('src/data/league.json');

const CATEGORIES = ['2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014', '2013', 'SUB13', 'SUB11', 'F13', 'F11'];
const MATCH_DETAIL_SOURCES = [
  {
    category: '2018',
    team: 'EXPLORADORES',
    csvUrl: 'https://docs.google.com/spreadsheets/d/1gPjQsQ9osjcg6xvxCIJhHLHP1ZCeehnIDuShvmRcOvg/export?format=csv&gid=409624493',
  },
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const pageHtml = await fetchText(PAGE_URL);
  const source = buildSource(pageHtml);
  const [resultsCsv, standingsCsv, matchDetailCsvs] = await Promise.all([
    fetchText(source.resultsCsvUrl),
    fetchText(source.standingsCsvUrl),
    Promise.all(MATCH_DETAIL_SOURCES.map(async (detailSource) => ({
      ...detailSource,
      csv: await fetchText(detailSource.csvUrl),
    }))),
  ]);

  const resultsRows = parseCsv(resultsCsv);
  const standingsRows = parseCsv(standingsCsv);
  const resultsByCategory = parseResults(resultsRows);
  const { standingsByCategory, generalTable } = parseStandings(standingsRows);
  const matchDetailsByCategory = parseMatchDetails(matchDetailCsvs);
  mergeMatchDetails(resultsByCategory, matchDetailsByCategory);
  const categoryNames = [...new Set([...Object.keys(standingsByCategory), ...Object.keys(resultsByCategory)])]
    .sort(compareCategories);

  const categories = categoryNames.map((name) => {
    const standings = standingsByCategory[name] ?? [];
    const results = resultsByCategory[name] ?? [];
    const teams = unique([
      ...standings.map((row) => row.team),
      ...results.flatMap((match) => [match.home, match.away]),
    ]).sort((a, b) => a.localeCompare(b, 'es'));

    return {
      name,
      standings,
      results,
      nextGames: inferNextGames(teams, results),
    };
  });

  const data = {
    updatedAt: new Date().toISOString(),
    source,
    generalTable,
    categories,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Generated ${OUTPUT_PATH}`);
  console.log(`Categories: ${categories.map((category) => category.name).join(', ')}`);
}

function buildSource(pageHtml) {
  const base = `https://docs.google.com/spreadsheets/d/e/${SHEET_ID}`;
  const pdfUrls = [...pageHtml.matchAll(/https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[^"'< ]+output=pdf/g)]
    .map((match) => decodeHtml(match[0]));

  return {
    pageUrl: PAGE_URL,
    resultsPdfUrl: `${base}/pub?gid=${RESULTS_GID}&single=true&output=pdf`,
    standingsPdfUrl: `${base}/pub?gid=${STANDINGS_GID}&single=true&output=pdf`,
    resultsCsvUrl: `${base}/pub?gid=${RESULTS_GID}&single=true&output=csv`,
    standingsCsvUrl: `${base}/pub?gid=${STANDINGS_GID}&single=true&output=csv`,
    matchDetailCsvUrls: MATCH_DETAIL_SOURCES.map((detailSource) => detailSource.csvUrl),
    discoveredPdfUrls: unique(pdfUrls),
  };
}

function parseResults(rows) {
  const byCategory = {};
  let currentRound = null;
  let headers = [];
  let headerIndexes = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index].map(cleanCell);
    const round = row.find((cell) => /^\d+ª fecha$/i.test(cell));

    if (round) {
      currentRound = round;
      headers = row;
      headerIndexes = row
        .map((cell, cellIndex) => ({ cell: normalizeCategory(cell), cellIndex }))
        .filter(({ cell }) => CATEGORIES.includes(cell));
      continue;
    }

    if (!currentRound || headerIndexes.length === 0) continue;

    const nextRow = rows[index + 1]?.map(cleanCell);
    const team = normalizeTeam(row[2]);
    const nextTeam = normalizeTeam(nextRow?.[2]);
    if (!team || !nextTeam || !isTeamName(team) || !isTeamName(nextTeam)) continue;

    for (const { cell: category, cellIndex } of headerIndexes) {
      const homeGoals = toNumber(row[cellIndex]);
      const awayGoals = toNumber(nextRow[cellIndex]);
      if (homeGoals === null || awayGoals === null) continue;

      byCategory[category] ??= [];
      byCategory[category].push({
        round: currentRound,
        home: team,
        away: nextTeam,
        homeGoals,
        awayGoals,
      });
    }

    index += 1;
  }

  return byCategory;
}

function parseStandings(rows) {
  const standingsByCategory = {};
  let generalTable = [];
  let activeCategories = [];
  let inGeneralTable = false;

  for (const sourceRow of rows) {
    const row = sourceRow.map(cleanCell);
    const categoryMarkers = row
      .map((cell, index) => ({ category: normalizeCategory(cell.replace(/^Categoria\s+/i, '')), index }))
      .filter(({ category }) => /^\d{4}$/.test(category) || /^SUB\d+$/.test(category));

    if (categoryMarkers.length > 0) {
      activeCategories = categoryMarkers;
      inGeneralTable = false;
      for (const { category } of activeCategories) standingsByCategory[category] ??= [];
      continue;
    }

    if (row.some((cell) => /TABLA GENERAL/i.test(cell))) {
      activeCategories = [];
      inGeneralTable = true;
      continue;
    }

    if (inGeneralTable) {
      const standing = parseStandingAt(row, 2);
      if (standing) generalTable.push(standing);
      continue;
    }

    for (const { category, index } of activeCategories) {
      const standing = parseStandingAt(row, index);
      if (standing) standingsByCategory[category].push(standing);
    }
  }

  generalTable = dedupeStandings(generalTable).map((row, index) => ({ position: index + 1, ...row }));
  for (const [category, rowsForCategory] of Object.entries(standingsByCategory)) {
    standingsByCategory[category] = dedupeStandings(rowsForCategory).map((row, index) => ({ position: index + 1, ...row }));
  }

  return { standingsByCategory, generalTable };
}

function parseMatchDetails(sources) {
  const byCategory = {};

  for (const source of sources) {
    const category = normalizeCategory(source.category);
    const sourceTeam = normalizeExternalTeam(source.team);
    const rows = parseCsv(source.csv);
    const headerIndex = rows.findIndex((row) => row.some((cell) => /^Fecha$/i.test(cleanCell(cell))));
    if (headerIndex === -1) continue;

    const headers = rows[headerIndex].map((cell) => cleanCell(cell).toLowerCase());
    const indexes = {
      date: headers.findIndex((header) => header === 'fecha'),
      venue: headers.findIndex((header) => header === 'cancha'),
      home: headers.findIndex((header) => header === 'local'),
      away: headers.findIndex((header) => header === 'visitante'),
      scorers: headers.findIndex((header) => header === 'goles'),
      tournament: headers.findIndex((header) => header === 'torneo'),
    };

    if ([indexes.date, indexes.home, indexes.away, indexes.scorers, indexes.tournament].some((index) => index === -1)) continue;

    const homeGoalsIndex = indexes.home + 1;
    const awayGoalsIndex = indexes.away + 1;

    for (const sourceRow of rows.slice(headerIndex + 1)) {
      const row = sourceRow.map(cleanCell);
      if (!row.some(Boolean)) continue;
      if (!/^Apertura$/i.test(row[indexes.tournament])) continue;

      const home = normalizeExternalTeam(row[indexes.home]);
      const away = normalizeExternalTeam(row[indexes.away]);
      const homeGoals = toNumber(row[homeGoalsIndex]);
      const awayGoals = toNumber(row[awayGoalsIndex]);
      if (!home || !away || homeGoals === null || awayGoals === null) continue;
      if (home !== sourceTeam && away !== sourceTeam) continue;

      const sourceTeamGoals = home === sourceTeam ? homeGoals : awayGoals;
      const { goals, note } = parseScorers(row[indexes.scorers], sourceTeam, sourceTeamGoals);

      byCategory[category] ??= [];
      byCategory[category].push({
        home,
        away,
        homeGoals,
        awayGoals,
        details: {
          date: normalizeDate(row[indexes.date]),
          venue: normalizeTeam(row[indexes.venue]),
          sourceTeam,
          goals,
          note,
        },
      });
    }
  }

  return byCategory;
}

function mergeMatchDetails(resultsByCategory, matchDetailsByCategory) {
  for (const [category, details] of Object.entries(matchDetailsByCategory)) {
    const matches = resultsByCategory[category] ?? [];

    for (const detail of details) {
      const match = matches.find((candidate) => sameMatch(candidate, detail));
      if (match) match.details = detail.details;
    }
  }
}

function parseStandingAt(row, startIndex) {
  const team = normalizeTeam(row[startIndex]);
  if (!team || !isTeamName(team)) return null;

  const values = row.slice(startIndex + 1, startIndex + 9).map(toNumber);
  if (values.some((value) => value === null)) return null;

  const [played, won, drawn, lost, goalsFor, goalsAgainst, points, goalDifference] = values;
  if (played === 0 && points === 0 && goalsFor === 0 && goalsAgainst === 0) return null;

  return { team, played, won, drawn, lost, goalsFor, goalsAgainst, points, goalDifference };
}

function inferNextGames(teams, results) {
  const playedPairs = new Set(results.map((match) => pairKey(match.home, match.away)));
  const games = [];

  for (let i = 0; i < teams.length; i += 1) {
    for (let j = i + 1; j < teams.length; j += 1) {
      const home = teams[i];
      const away = teams[j];
      if (!playedPairs.has(pairKey(home, away))) games.push({ home, away });
    }
  }

  return games;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function dedupeStandings(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.team)) return false;
    seen.add(row.team);
    return true;
  });
}

function compareCategories(a, b) {
  const aNumber = Number(a.replace(/\D/g, ''));
  const bNumber = Number(b.replace(/\D/g, ''));
  if (Number.isFinite(bNumber - aNumber) && aNumber !== bNumber) return bNumber - aNumber;
  return a.localeCompare(b, 'es');
}

function pairKey(a, b) {
  return [normalizeTeam(a), normalizeTeam(b)].sort((x, y) => x.localeCompare(y, 'es')).join('::');
}

function sameMatch(match, detail) {
  return pairKey(match.home, match.away) === pairKey(detail.home, detail.away)
    && ((match.homeGoals === detail.homeGoals && match.awayGoals === detail.awayGoals)
      || (match.home === detail.away && match.away === detail.home
        && match.homeGoals === detail.awayGoals && match.awayGoals === detail.homeGoals));
}

function parseScorers(value, team, expectedGoals) {
  const text = cleanCell(value);
  if (!text) return { goals: [], note: null };

  const goals = [];
  for (const part of text.split(',')) {
    const match = cleanCell(part).match(/^(\d+)\s*(.+)$/);
    if (!match) continue;
    goals.push({ team, player: cleanCell(match[2]), goals: Number(match[1]) });
  }

  if (goals.length > 0) return { goals, note: null };
  return { goals: [], note: expectedGoals > 0 ? text : null };
}

function normalizeDate(value) {
  const match = cleanCell(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return cleanCell(value) || null;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function toNumber(value) {
  const cleaned = cleanCell(value);
  if (!/^-?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

function normalizeCategory(value) {
  return cleanCell(value).toUpperCase().replace(/^F(\d+)$/, 'SUB$1');
}

function normalizeTeam(value) {
  return cleanCell(value).replace(/\s+/g, ' ');
}

function normalizeExternalTeam(value) {
  const team = normalizeTeam(value).toUpperCase();
  const aliases = {
    AEBU: 'AEBU',
    'ALAS ROJAS': 'ALAS ROJAS',
    'DEPORTIVO ORIENTAL': 'DEP.ORIENTAL',
    DRYCO: 'DRYCO',
    'EST. DE LA UNION': 'EST. DE LA UNION',
    EXPLORADORES: 'EXPLORADORES',
    INTERMEZZO: 'INTERMEZZO',
    'NUEVA PALMIRA': 'NUEVA PALMIRA',
    'NUEVO AMANECER': 'NVO. AMANECER',
    'RAYO ROJO': 'RAYO ROJO',
    'RINCON DE REDUCTO': 'R.DEL REDUCTO',
    STOCKOLMO: 'STOCKOLMO',
    'SUR 200': 'SUR2000',
    'SUR 2000': 'SUR2000',
    SUR2000: 'SUR2000',
    TERREMOTO: 'TERREMOTO',
    'URUGUAY BUCEO': 'URUGUAY BUCEO',
  };

  return aliases[team] ?? team;
}

function isTeamName(value) {
  return value !== ',' && /[A-ZÁÉÍÓÚÑ]/i.test(value) && !/^\d+$/.test(value);
}

function cleanCell(value = '') {
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function decodeHtml(value) {
  return value.replaceAll('&amp;', '&');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
