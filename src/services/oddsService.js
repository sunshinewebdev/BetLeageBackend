const axios = require('axios');

const BASE_URL = 'https://api.the-odds-api.com/v4';
const API_KEY  = process.env.ODDS_API_KEY;

const SPORTS = [
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
];

const BOOKMAKERS = ['draftkings', 'fanduel', 'betmgm'];

// ── Fetch upcoming events with odds ────────────────────────
async function fetchEventsWithOdds(sport) {
  const { data } = await axios.get(`${BASE_URL}/sports/${sport}/odds`, {
    params: {
      apiKey:    API_KEY,
      regions:   'us',
      markets:   'h2h,spreads,totals',
      oddsFormat: 'american',
      bookmakers: BOOKMAKERS.join(','),
    }
  });
  return data;
}

// ── Fetch scores for a sport ───────────────────────────────
async function fetchScores(sport, daysFrom = 1) {
  const { data } = await axios.get(`${BASE_URL}/sports/${sport}/scores`, {
    params: { apiKey: API_KEY, daysFrom }
  });
  return data;
}

// ── Normalize raw event into our DB shape ──────────────────
function normalizeEvent(raw, sport) {
  // Pick the best available bookmaker odds
  const book = raw.bookmakers?.find(b => BOOKMAKERS.includes(b.key))
             || raw.bookmakers?.[0];

  const odds = {};

  if (book) {
    for (const market of (book.markets || [])) {
      if (market.key === 'h2h') {
        odds.moneyline = {
          home: market.outcomes.find(o => o.name === raw.home_team)?.price,
          away: market.outcomes.find(o => o.name === raw.away_team)?.price,
        };
      }
      if (market.key === 'spreads') {
        odds.spread = {
          home: {
            price: market.outcomes.find(o => o.name === raw.home_team)?.price,
            point: market.outcomes.find(o => o.name === raw.home_team)?.point,
          },
          away: {
            price: market.outcomes.find(o => o.name === raw.away_team)?.price,
            point: market.outcomes.find(o => o.name === raw.away_team)?.point,
          }
        };
      }
      if (market.key === 'totals') {
        odds.totals = {
          over:  market.outcomes.find(o => o.name === 'Over')?.price,
          under: market.outcomes.find(o => o.name === 'Under')?.price,
          point: market.outcomes.find(o => o.name === 'Over')?.point,
        };
      }
    }
  }

  return {
    id:            raw.id,
    sport,
    home_team:     raw.home_team,
    away_team:     raw.away_team,
    commence_time: raw.commence_time,
    status:        'upcoming',
    odds,
    fetched_at:    new Date().toISOString(),
  };
}

// ── Payout calculator (American odds) ─────────────────────
function calculatePayout(wager, americanOdds) {
  if (americanOdds > 0) {
    return +(wager + (wager * americanOdds) / 100).toFixed(2);
  } else {
    return +(wager + (wager * 100) / Math.abs(americanOdds)).toFixed(2);
  }
}

module.exports = {
  SPORTS,
  fetchEventsWithOdds,
  fetchScores,
  normalizeEvent,
  calculatePayout,
};
