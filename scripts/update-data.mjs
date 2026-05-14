import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PAGE_URL = 'https://www.ligapalermo.org/serie-b-2026/';
const SHEET_ID = '2PACX-1vSdAJR-xfu56IvAEhKLWretxCs4W6BFtbuUPa9eJyqFmyjwRcnSc7ipcJwmixnXm3AONshXgSPTDkPk';
const RESULTS_GID = '1110485064';
const STANDINGS_GID = '491172477';
const OUTPUT_PATH = resolve('src/data/league.json');

const CATEGORIES = ['2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014', '2013', 'SUB13', 'SUB11', 'F13', 'F11'];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const pageHtml = await fetchText(PAGE_URL);
  const source = buildSource(pageHtml);
  const [resultsCsv, standingsCsv] = await Promise.all([
    fetchText(source.resultsCsvUrl),
    fetchText(source.standingsCsvUrl),
  ]);

  const resultsRows = parseCsv(resultsCsv);
  const standingsRows = parseCsv(standingsCsv);
  const resultsByCategory = parseResults(resultsRows);
  const { standingsByCategory, generalTable } = parseStandings(standingsRows);
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
