import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const RESULTS_GID = '1110485064';
const APERTURA_STANDINGS_GID = '491172477';
const SEASON_STANDINGS_GID = '75535354';
const COMPETITIONS = ['apertura', 'clausura', 'anual'];
const CATEGORIES = ['2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014', '2013', 'SUB13', 'SUB11', 'F13', 'F11'];
const DIVISIONS = [
  {
    name: 'Serie A',
    pageUrl: 'https://www.ligapalermo.org/serie-a-2026/',
    sheetId: '2PACX-1vSPb8Ia3rZxeGNy1FD123YL8-C1YKZeQR2S26j1boqLNXMlGv4cGl7G06snghUenXICkXNi3IYlfAVY',
    outputPath: resolve('src/data/serie-a.json'),
    matchDetailSources: [],
  },
  {
    name: 'Serie B',
    pageUrl: 'https://www.ligapalermo.org/serie-b-2026/',
    sheetId: '2PACX-1vSdAJR-xfu56IvAEhKLWretxCs4W6BFtbuUPa9eJyqFmyjwRcnSc7ipcJwmixnXm3AONshXgSPTDkPk',
    outputPath: resolve('src/data/league.json'),
    matchDetailSources: [
      {
        category: '2018',
        team: 'EXPLORADORES',
        csvUrl: 'https://docs.google.com/spreadsheets/d/1gPjQsQ9osjcg6xvxCIJhHLHP1ZCeehnIDuShvmRcOvg/export?format=csv&gid=409624493',
      },
    ],
  },
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  for (const division of DIVISIONS) await updateDivision(division);
}

async function updateDivision(division) {
  console.log(`Updating ${division.name}…`);
  const pageHtml = await fetchText(division.pageUrl);
  console.log(`Fetched ${division.name} page`);
  const source = buildSource(division, pageHtml);
  const [resultsCsv, aperturaStandingsCsv, seasonStandingsCsv, matchDetailCsvs] = await Promise.all([
    fetchText(source.resultsCsvUrl),
    fetchText(source.standingsCsvUrls.apertura),
    fetchText(source.standingsCsvUrls.clausura),
    Promise.all(division.matchDetailSources.map(async (detailSource) => ({
      ...detailSource,
      csv: await fetchText(detailSource.csvUrl),
    }))),
  ]);
  console.log(`Fetched ${division.name} data`);

  const resultsRows = parseCsv(resultsCsv);
  const resultsByCompetition = parseResults(resultsRows);
  const aperturaStandings = parseStandings(parseCsv(aperturaStandingsCsv));
  const seasonStandings = parseSeasonStandings(parseCsv(seasonStandingsCsv));
  const standingsByCompetition = {
    apertura: aperturaStandings,
    clausura: seasonStandings.clausura,
    anual: seasonStandings.anual,
  };
  const matchDetailsByCompetition = parseMatchDetails(matchDetailCsvs);
  console.log(`Parsed ${division.name} data`);
  for (const competition of ['apertura', 'clausura']) {
    mergeMatchDetails(resultsByCompetition[competition], matchDetailsByCompetition[competition]);
  }
  resultsByCompetition.anual = combineResults(resultsByCompetition);
  const categoryNames = [...new Set(COMPETITIONS.flatMap((competition) => [
    ...Object.keys(standingsByCompetition[competition].standingsByCategory),
    ...Object.keys(resultsByCompetition[competition]),
  ]))]
    .filter((category) => COMPETITIONS.some((competition) => {
      const standings = standingsByCompetition[competition].standingsByCategory[category] ?? [];
      const results = resultsByCompetition[competition][category] ?? [];
      return results.length > 0 || standings.some((row) => row.played > 0);
    }))
    .sort(compareCategories);

  const categories = categoryNames.map((name) => {
    return {
      name,
      competitions: Object.fromEntries(COMPETITIONS.map((competition) => {
        const standings = standingsByCompetition[competition].standingsByCategory[name] ?? [];
        const results = resultsByCompetition[competition][name] ?? [];
        const teams = unique([
          ...standings.map((row) => row.team),
          ...results.flatMap((match) => [match.home, match.away]),
        ]).sort((a, b) => a.localeCompare(b, 'es'));
        const nextGames = competition === 'anual'
          ? inferNextGames(teams, resultsByCompetition.clausura[name] ?? [])
          : inferNextGames(teams, results);

        return [competition, { standings, results, nextGames }];
      })),
    };
  });
  console.log(`Built ${division.name} categories`);

  const data = {
    updatedAt: new Date().toISOString(),
    division: division.name,
    source,
    generalTables: Object.fromEntries(COMPETITIONS.map((competition) => [
      competition,
      standingsByCompetition[competition].generalTable,
    ])),
    categories,
  };

  await mkdir(dirname(division.outputPath), { recursive: true });
  await writeFile(division.outputPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Generated ${division.outputPath}`);
  console.log(`${division.name} categories: ${categories.map((category) => category.name).join(', ')}`);
}

function buildSource(division, pageHtml) {
  const base = `https://docs.google.com/spreadsheets/d/e/${division.sheetId}`;
  const pdfUrls = [...pageHtml.matchAll(/https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[^"'< ]+output=pdf/g)]
    .map((match) => decodeHtml(match[0]));

  return {
    pageUrl: division.pageUrl,
    resultsPdfUrl: `${base}/pub?gid=${RESULTS_GID}&single=true&output=pdf`,
    standingsPdfUrls: {
      apertura: `${base}/pub?gid=${APERTURA_STANDINGS_GID}&single=true&output=pdf`,
      clausura: `${base}/pub?gid=${SEASON_STANDINGS_GID}&single=true&output=pdf`,
      anual: `${base}/pub?gid=${SEASON_STANDINGS_GID}&single=true&output=pdf`,
    },
    resultsCsvUrl: `${base}/pub?gid=${RESULTS_GID}&single=true&output=csv`,
    standingsCsvUrls: {
      apertura: `${base}/pub?gid=${APERTURA_STANDINGS_GID}&single=true&output=csv`,
      clausura: `${base}/pub?gid=${SEASON_STANDINGS_GID}&single=true&output=csv`,
      anual: `${base}/pub?gid=${SEASON_STANDINGS_GID}&single=true&output=csv`,
    },
    matchDetailCsvUrls: division.matchDetailSources.map((detailSource) => detailSource.csvUrl),
    discoveredPdfUrls: unique(pdfUrls),
  };
}

function parseResults(rows) {
  const byCompetition = { apertura: {}, clausura: {} };
  let competition = 'apertura';
  let currentRound = null;
  let headerIndexes = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index].map(cleanCell);
    const tournamentHeading = row.find((cell) => /Resultados Torneo (Apertura|Clausura)/i.test(cell));
    if (tournamentHeading) {
      competition = /Clausura/i.test(tournamentHeading) ? 'clausura' : 'apertura';
      currentRound = null;
      headerIndexes = [];
      continue;
    }
    const round = row.find((cell) => /^\d+ª fecha$/i.test(cell));

    if (round) {
      currentRound = round;
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

      byCompetition[competition][category] ??= [];
      byCompetition[competition][category].push({
        round: currentRound,
        home: team,
        away: nextTeam,
        homeGoals,
        awayGoals,
      });
    }

    index += 1;
  }

  return byCompetition;
}

function combineResults(resultsByCompetition) {
  const combined = {};
  const categoryNames = unique([
    ...Object.keys(resultsByCompetition.apertura),
    ...Object.keys(resultsByCompetition.clausura),
  ]);

  for (const category of categoryNames) {
    combined[category] = [
      ...(resultsByCompetition.apertura[category] ?? []).map((match) => ({ ...match, round: `Apertura · ${match.round}` })),
      ...(resultsByCompetition.clausura[category] ?? []).map((match) => ({ ...match, round: `Clausura · ${match.round}` })),
    ];
  }

  return combined;
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

  generalTable = positionStandings(generalTable);
  for (const [category, rowsForCategory] of Object.entries(standingsByCategory)) {
    standingsByCategory[category] = positionStandings(rowsForCategory);
  }

  return { standingsByCategory, generalTable };
}

function parseSeasonStandings(rows) {
  const parsed = {
    clausura: { standingsByCategory: {}, generalTable: [] },
    anual: { standingsByCategory: {}, generalTable: [] },
  };
  let activeTables = [];

  for (const sourceRow of rows) {
    const row = sourceRow.map(cleanCell);
    const markers = [];

    row.forEach((cell, index) => {
      const categoryMatch = cell.match(/^(CLAUSURA|GENERAL).*Cat\.\s*(\d{4}|SUB\d+)$/i);
      if (categoryMatch) {
        markers.push({
          competition: /^CLAUSURA/i.test(categoryMatch[1]) ? 'clausura' : 'anual',
          category: normalizeCategory(categoryMatch[2]),
          index,
        });
      } else if (/Tabla General Clausura/i.test(cell)) {
        markers.push({ competition: 'clausura', category: null, index });
      } else if (/Tabla General\s+Anual/i.test(cell)) {
        markers.push({ competition: 'anual', category: null, index });
      }
    });

    if (markers.length > 0) {
      activeTables = markers;
      for (const marker of markers) {
        if (marker.category) parsed[marker.competition].standingsByCategory[marker.category] ??= [];
      }
      continue;
    }

    for (const marker of activeTables) {
      const standing = parseStandingAt(row, marker.index, true);
      if (!standing) continue;
      if (marker.category) parsed[marker.competition].standingsByCategory[marker.category].push(standing);
      else parsed[marker.competition].generalTable.push(standing);
    }
  }

  for (const competition of ['clausura', 'anual']) {
    parsed[competition].generalTable = positionStandings(parsed[competition].generalTable);
    for (const [category, standings] of Object.entries(parsed[competition].standingsByCategory)) {
      parsed[competition].standingsByCategory[category] = positionStandings(standings);
    }
  }

  return parsed;
}

function parseMatchDetails(sources) {
  const byCompetition = { apertura: {}, clausura: {} };

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
      const tournament = row[indexes.tournament];
      const competition = /^Apertura$/i.test(tournament)
        ? 'apertura'
        : /^Clausura$/i.test(tournament)
          ? 'clausura'
          : null;
      if (!competition) continue;

      const home = normalizeExternalTeam(row[indexes.home]);
      const away = normalizeExternalTeam(row[indexes.away]);
      const homeGoals = toNumber(row[homeGoalsIndex]);
      const awayGoals = toNumber(row[awayGoalsIndex]);
      if (!home || !away || homeGoals === null || awayGoals === null) continue;
      if (home !== sourceTeam && away !== sourceTeam) continue;

      const sourceTeamGoals = home === sourceTeam ? homeGoals : awayGoals;
      const { goals, note } = parseScorers(row[indexes.scorers], sourceTeam, sourceTeamGoals);

      byCompetition[competition][category] ??= [];
      byCompetition[competition][category].push({
        home,
        away,
        homeGoals,
        awayGoals,
        details: {
          date: normalizeDate(row[indexes.date]),
          venue: normalizeTeam(row[indexes.venue]),
          sourceTeam,
          sourceScore: { home, away, homeGoals, awayGoals },
          goals,
          note,
        },
      });
    }
  }

  return byCompetition;
}

function mergeMatchDetails(resultsByCategory, matchDetailsByCategory) {
  for (const [category, details] of Object.entries(matchDetailsByCategory)) {
    const matches = resultsByCategory[category] ?? [];

    for (const detail of details) {
      const candidates = matches.filter((candidate) => sameTeams(candidate, detail));
      const match = candidates.find((candidate) => sameScore(candidate, detail))
        ?? (candidates.length === 1 ? candidates[0] : null);
      if (match) match.details = detail.details;
    }
  }
}

function parseStandingAt(row, startIndex, includeEmpty = false) {
  const team = normalizeTeam(row[startIndex]);
  if (!team || !isTeamName(team)) return null;

  const values = row.slice(startIndex + 1, startIndex + 9).map(toNumber);
  if (values.some((value) => value === null)) return null;

  const [played, won, drawn, lost, goalsFor, goalsAgainst, points, goalDifference] = values;
  if (!includeEmpty && played === 0 && points === 0 && goalsFor === 0 && goalsAgainst === 0) return null;

  return { team, played, won, drawn, lost, goalsFor, goalsAgainst, points, goalDifference };
}

function positionStandings(rows) {
  return dedupeStandings(rows)
    .sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference)
    .map((row, index) => ({ position: index + 1, ...row }));
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

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      if (attempt === retries) throw new Error(`Failed to fetch ${url}`, { cause: error });
      console.warn(`Retrying ${url} (${attempt + 1}/${retries})…`);
    }
  }

  throw new Error(`Failed to fetch ${url}`);
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

function sameTeams(match, detail) {
  return pairKey(match.home, match.away) === pairKey(detail.home, detail.away);
}

function sameScore(match, detail) {
  return (match.home === detail.home && match.away === detail.away
      && match.homeGoals === detail.homeGoals && match.awayGoals === detail.awayGoals)
    || (match.home === detail.away && match.away === detail.home
      && match.homeGoals === detail.awayGoals && match.awayGoals === detail.homeGoals);
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
    ESTUDIANTES: 'EST. DE LA UNION',
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
