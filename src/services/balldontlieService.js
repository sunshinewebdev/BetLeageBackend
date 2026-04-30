const axios = require('axios');

const BASE_URL = 'https://api.balldontlie.io/v1';
const API_KEY = process.env.BALLDONTLIE_API_KEY;

const headers = API_KEY ? { Authorization: API_KEY } : {};

// Per-sport stat maps: market key → accessor function over player stats
const STAT_MAPS = {
  americanfootball_nfl: {
    player_pass_yds:      s => s.passing_yards   ?? 0,
    player_rush_yds:      s => s.rushing_yards   ?? 0,
    player_reception_yds: s => s.receiving_yards ?? 0,
    player_pass_tds:      s => s.passing_tds     ?? 0,
    player_receptions:    s => s.receptions      ?? 0,
  },
  basketball_nba: {
    player_points:   s => s.pts ?? 0,
    player_rebounds: s => s.reb ?? 0,
    player_assists:  s => s.ast ?? 0,
    player_threes:   s => s.fg3 ?? 0,
    player_blocks:   s => s.blk ?? 0,
    player_steals:   s => s.stl ?? 0,
  },
  baseball_mlb: {
    batter_hits:        s => s.hits        ?? 0,
    batter_home_runs:   s => s.home_runs   ?? 0,
    batter_total_bases: s => s.total_bases ?? 0,
    pitcher_strikeouts: s => s.strikeouts  ?? 0,
    pitcher_outs:       s => s.outs_pitched ? Math.round(s.outs_pitched) : 0,
  },
};

async function fetchGameStats(sport, gameId) {
  const sportPath = sport === 'basketball_nba' ? 'nba'
    : sport === 'americanfootball_nfl' ? 'nfl'
    : 'mlb';

  const { data } = await axios.get(`${BASE_URL}/${sportPath}/stats`, {
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
  const sportPath = sport === 'basketball_nba' ? 'nba'
    : sport === 'americanfootball_nfl' ? 'nfl'
    : 'mlb';

  const dateStr = date.toISOString().split('T')[0];

  const { data } = await axios.get(`${BASE_URL}/${sportPath}/games`, {
    params: { dates: [dateStr] },
    headers,
  });

  const games = data.data || [];
  const game = games.find(g => {
    const home = g.home_team?.full_name || g.home_team?.name || '';
    const away = g.visitor_team?.full_name || g.visitor_team?.name || '';
    return home.includes(homeTeam.split(' ').pop())
      && away.includes(awayTeam.split(' ').pop());
  });

  return game?.id || null;
}

module.exports = { fetchGameStats, getStatValue, findGameId, STAT_MAPS };
