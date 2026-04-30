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

// ── Prop markets by sport ─────────────────────────────────
const PROP_MARKETS = {
  americanfootball_nfl: [
    'player_pass_yds',
    'player_rush_yds',
    'player_reception_yds',
    'player_pass_tds',
    'player_receptions',
  ],
  basketball_nba: [
    'player_points',
    'player_rebounds',
    'player_assists',
    'player_threes',
    'player_blocks',
    'player_steals',
  ],
  baseball_mlb: [
    'batter_hits',
    'batter_home_runs',
    'batter_total_bases',
    'pitcher_strikeouts',
    'pitcher_outs',
  ],
};

// ── Fetch player props for a specific event ───────────────
async function fetchEventProps(eventId, sport) {
  const markets = PROP_MARKETS[sport];
  if (!markets || markets.length === 0) return null;

  try {
    const { data } = await axios.get(`${BASE_URL}/sports/${sport}/events/${eventId}/odds`, {
      params: {
        apiKey:     API_KEY,
        regions:    'us',
        markets:    markets.join(','),
        oddsFormat: 'american',
        bookmakers: BOOKMAKERS.join(','),
      }
    });

    const book = data.bookmakers?.find(b => BOOKMAKERS.includes(b.key))
               || data.bookmakers?.[0];

    if (!book) return null;

    const props = {};

    for (const market of (book.markets || [])) {
      if (!props[market.key]) props[market.key] = {};

      for (const outcome of (market.outcomes || [])) {
        const player = outcome.description;
        if (!player) continue;

        if (!props[market.key][player]) {
          props[market.key][player] = {};
        }

        if (outcome.name === 'Over') {
          props[market.key][player].over = outcome.price;
          props[market.key][player].line = outcome.point;
        } else if (outcome.name === 'Under') {
          props[market.key][player].under = outcome.price;
          if (!props[market.key][player].line) {
            props[market.key][player].line = outcome.point;
          }
        }
      }
    }

    return props;
  } catch (err) {
    if (err.response?.status === 422 || err.response?.status === 404) {
      return null; // Props not available for this event — silent skip
    }
    console.error(`[Props] Failed to fetch props for event ${eventId}:`, err.message);
    return null;
  }
}

module.exports = {
  SPORTS,
  PROP_MARKETS,
  fetchEventsWithOdds,
  fetchEventProps,
  fetchScores,
  normalizeEvent,
  calculatePayout,
};
