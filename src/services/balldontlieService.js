const axios = require('axios');

const BASE_URLS = {
  basketball_nba:       'https://api.balldontlie.io/v1',
  americanfootball_nfl: 'https://api.balldontlie.io/nfl/v1',
  baseball_mlb:         'https://api.balldontlie.io/mlb/v1',
};
const API_KEY = process.env.BALLDONTLIE_API_KEY;

const headers = API_KEY ? { Authorization: API_KEY } : {};

// Per-sport stat maps: market key → accessor function over player stats
const STAT_MAPS = {
  americanfootball_nfl: {
    player_pass_yds:      s => s.passing_yards       ?? 0,
    player_rush_yds:      s => s.rushing_yards       ?? 0,
    player_reception_yds: s => s.receiving_yards     ?? 0,
    player_pass_tds:      s => s.passing_touchdowns  ?? 0,
    player_receptions:    s => s.receptions          ?? 0,
  },
  basketball_nba: {
    player_points:   s => s.pts  ?? 0,
    player_rebounds: s => s.reb  ?? 0,
    player_assists:  s => s.ast  ?? 0,
    player_threes:   s => s.fg3m ?? 0,
    player_blocks:   s => s.blk  ?? 0,
    player_steals:   s => s.stl  ?? 0,
  },
  baseball_mlb: {
    batter_hits:        s => s.hits          ?? 0,
    batter_home_runs:   s => s.hr            ?? 0,
    batter_total_bases: s => s.total_bases   ?? 0,
    pitcher_strikeouts: s => s.p_k           ?? 0,
    pitcher_outs:       s => s.pitching_outs ?? 0,
  },
};

async function fetchGameStats(sport, gameId) {
  const baseUrl = BASE_URLS[sport];
  if (!baseUrl) return [];

  const { data } = await axios.get(`${baseUrl}/stats`, {
    params: { game_ids: [gameId] },
    headers,
  });

  return data.data || [];
}

function getStatValue(playerStats, market, sport) {
  const sportMap = STAT_MAPS[sport];
  if (!sportMap) return null;

  const accessor = sportMap[market];
  if (!accessor) return null;

  return accessor(playerStats);
}

async function findGameId(sport, homeTeam, awayTeam, date) {
  const baseUrl = BASE_URLS[sport];
  if (!baseUrl) return null;

  // commence_time is UTC; balldontlie indexes games by US local date,
  // so a night game in the US can sit on the prior calendar day there.
  const utcDay = new Date(date);
  const prevDay = new Date(utcDay);
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);
  const dates = [
    prevDay.toISOString().split('T')[0],
    utcDay.toISOString().split('T')[0],
  ];

  const { data } = await axios.get(`${baseUrl}/games`, {
    params: { dates },
    headers,
  });

  const teamName = (t, fallback) =>
    t?.full_name || t?.display_name || t?.name || fallback || '';

  const games = data.data || [];
  const game = games.find(g => {
    const home = teamName(g.home_team, g.home_team_name);
    const away = teamName(g.visitor_team || g.away_team, g.away_team_name);
    return home.includes(homeTeam.split(' ').pop())
      && away.includes(awayTeam.split(' ').pop());
  });

  return game?.id || null;
}

module.exports = { fetchGameStats, getStatValue, findGameId, STAT_MAPS };
