// Server-side validation of a bet/parlay leg against the odds stored on the
// event row. Never trust prices or lines sent by the client — payouts must be
// computed from what the server knows.

const SELECTIONS_BY_TYPE = {
  moneyline: ['home', 'away'],
  spread:    ['home', 'away'],
  totals:    ['over', 'under'],
  prop:      ['over', 'under'],
};

/**
 * Returns { price, point } with the server-known american odds and the
 * current line for this leg (point is null for moneyline), or { error }
 * when the market is unavailable / the leg is malformed. The caller stores
 * `point` on the wager so settlement grades against the line the bettor
 * actually took, not a later snapshot.
 */
function getServerOdds(event, leg) {
  const { bet_type, selection, prop_player, prop_market, prop_line } = leg;

  const allowed = SELECTIONS_BY_TYPE[bet_type];
  if (!allowed || !allowed.includes(selection)) {
    return { error: `Invalid selection "${selection}" for ${bet_type} bet` };
  }

  const odds = event.odds || {};
  let price = null;
  let point = null;

  if (bet_type === 'moneyline') {
    price = odds.moneyline?.[selection];
  } else if (bet_type === 'spread') {
    price = odds.spread?.[selection]?.price;
    point = odds.spread?.[selection]?.point;
    if (price != null && point == null) {
      return { error: 'Odds are not available for this market' };
    }
  } else if (bet_type === 'totals') {
    price = odds.totals?.[selection];
    point = odds.totals?.point;
    if (price != null && point == null) {
      return { error: 'Odds are not available for this market' };
    }
  } else if (bet_type === 'prop') {
    if (!prop_player || !prop_market || prop_line == null) {
      return { error: 'Prop bets require prop_player, prop_market and prop_line' };
    }
    const market = event.props?.[prop_market]?.[prop_player];
    if (!market || market.line == null) {
      return { error: 'This prop market is not available' };
    }
    if (Number(market.line) !== Number(prop_line)) {
      return { error: 'Odds have changed — refresh and try again' };
    }
    price = market[selection];
    point = market.line;
  }

  if (price == null || !Number.isFinite(Number(price))) {
    return { error: 'Odds are not available for this market' };
  }

  return { price: Number(price), point: point == null ? null : Number(point) };
}

/**
 * Validates that an event can still be bet on: it must exist, be upcoming,
 * and not have started yet (status only flips to completed via cron, so
 * commence_time is the reliable in-play guard).
 */
function eventIsBettable(event) {
  if (!event || event.status !== 'upcoming') return false;
  return new Date(event.commence_time) > new Date();
}

module.exports = { getServerOdds, eventIsBettable };
