const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { calculateParlayOdds, calculateParlayPayout } = require('../lib/parlayOdds');
const { getServerOdds, eventIsBettable } = require('../lib/betValidation');
const supabase = require('../lib/supabase');

const router = express.Router();

const LegSchema = z.object({
  event_id:        z.string(),
  bet_type:        z.enum(['moneyline', 'spread', 'totals', 'prop']),
  selection:       z.enum(['home', 'away', 'over', 'under']),
  selection_label: z.string(),
  american_odds:   z.number().int(),
  prop_player:     z.string().optional().nullable(),
  prop_market:     z.string().optional().nullable(),
  prop_line:       z.number().optional().nullable(),
}).refine(
  l => l.bet_type !== 'prop' || (l.prop_player && l.prop_market && l.prop_line != null),
  { message: 'Prop legs require prop_player, prop_market, and prop_line' },
);

const PlaceParlaySchema = z.object({
  league_id:     z.string().uuid().optional().nullable(),
  tournament_id: z.string().uuid().optional().nullable(),
  wager:         z.number().positive().max(10000),
  legs:          z.array(LegSchema).min(2).max(12),
}).refine(
  p => !(p.league_id && p.tournament_id),
  { message: 'A parlay cannot belong to both a league and a tournament' },
);

// POST /api/parlays
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = PlaceParlaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { league_id, tournament_id, wager, legs } = parsed.data;
    const userId = req.user.id;

    // Reject duplicate legs — identical legs are perfectly correlated, so
    // they multiply the payout without adding any risk.
    const legKeys = legs.map(l =>
      [l.event_id, l.bet_type, l.selection, l.prop_market ?? '', l.prop_player ?? ''].join('|')
    );
    if (new Set(legKeys).size !== legKeys.length) {
      return res.status(400).json({ error: 'Parlay contains duplicate legs' });
    }

    const eventIds = legs.map(l => l.event_id);
    const uniqueEventIds = [...new Set(eventIds)];

    // Verify all events are still upcoming and have not started
    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('id, status, commence_time, odds, props')
      .in('id', uniqueEventIds);

    if (eventsError) throw eventsError;
    if (!events || events.length !== uniqueEventIds.length) {
      return res.status(400).json({ error: 'One or more events could not be found' });
    }
    if (events.some(e => !eventIsBettable(e))) {
      return res.status(400).json({ error: 'One or more events are no longer open for betting' });
    }

    // Price every leg from the stored event odds — never trust client odds
    const eventsById = new Map(events.map(e => [e.id, e]));
    const oddsArray = [];
    const pointsArray = [];
    for (const leg of legs) {
      const { price, point, error: oddsError } = getServerOdds(eventsById.get(leg.event_id), leg);
      if (oddsError) {
        return res.status(400).json({ error: oddsError });
      }
      if (price !== leg.american_odds) {
        return res.status(409).json({ error: 'Odds have changed — refresh and try again' });
      }
      oddsArray.push(price);
      pointsArray.push(point);
    }

    const combinedOdds    = calculateParlayOdds(oddsArray);
    const potentialPayout = calculateParlayPayout(wager, oddsArray);

    // Deduct from the correct bankroll atomically (deduct_* RPCs only
    // succeed when the balance covers the wager)
    if (tournament_id) {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('id, status, end_date')
        .eq('id', tournament_id)
        .single();

      if (!tournament || tournament.status !== 'active') {
        return res.status(400).json({ error: 'Tournament is not open for betting' });
      }
      // Every leg must start before the tournament ends, or the wager can't
      // resolve in time to count in the final ranking
      const tournamentEnd = new Date(tournament.end_date);
      if (events.some(e => new Date(e.commence_time) >= tournamentEnd)) {
        return res.status(400).json({ error: 'One or more events start after this tournament ends' });
      }

      const { data: entry } = await supabase
        .from('tournament_entries')
        .select('id')
        .eq('tournament_id', tournament_id)
        .eq('user_id', userId)
        .single();

      if (!entry) return res.status(400).json({ error: 'You have not entered this tournament' });

      const { data: deducted, error } = await supabase.rpc('deduct_tournament_balance', {
        p_tournament_id: tournament_id,
        p_user_id:       userId,
        p_amount:        wager,
      });
      if (error) throw error;
      if (!deducted) return res.status(400).json({ error: 'Insufficient tournament balance' });

    } else if (league_id) {
      const { data: member } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', league_id)
        .eq('user_id', userId)
        .single();

      if (!member) return res.status(403).json({ error: 'You are not a member of this league' });

      const { data: deducted, error } = await supabase.rpc('deduct_league_balance', {
        p_league_id: league_id,
        p_user_id:   userId,
        p_amount:    wager,
      });
      if (error) throw error;
      if (!deducted) return res.status(400).json({ error: 'Insufficient league balance' });

    } else {
      const { data: deducted, error } = await supabase.rpc('deduct_account_balance', {
        p_user_id: userId,
        p_amount:  wager,
      });
      if (error) throw error;
      if (!deducted) return res.status(400).json({ error: 'Insufficient account balance' });
    }

    // Insert parlay
    const { data: parlay, error: parlayError } = await supabase
      .from('parlays')
      .insert({
        user_id:          userId,
        league_id:        league_id     || null,
        tournament_id:    tournament_id || null,
        combined_odds:    combinedOdds,
        wager,
        potential_payout: potentialPayout,
      })
      .select()
      .single();

    if (parlayError) {
      // Refund and bail
      await refundWager({ userId, league_id, tournament_id, wager });
      throw parlayError;
    }

    // Insert legs
    const legRows = legs.map((l, i) => ({
      parlay_id:       parlay.id,
      event_id:        l.event_id,
      bet_type:        l.bet_type,
      selection:       l.selection,
      selection_label: l.selection_label,
      american_odds:   oddsArray[i],
      line:            pointsArray[i],
      prop_player:     l.prop_player ?? null,
      prop_market:     l.prop_market ?? null,
      prop_line:       l.prop_line   ?? null,
    }));

    const { error: legsError } = await supabase.from('parlay_legs').insert(legRows);

    if (legsError) {
      await supabase.from('parlays').delete().eq('id', parlay.id);
      await refundWager({ userId, league_id, tournament_id, wager });
      throw legsError;
    }

    res.status(201).json({ ...parlay, legs: legRows });
  } catch (err) {
    next(err);
  }
});

// GET /api/parlays
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { league_id, tournament_id, source, status } = req.query;

    let query = supabase
      .from('parlays')
      .select('*, legs:parlay_legs(*, event:events(home_team, away_team, commence_time, sport))')
      .eq('user_id', req.user.id)
      .order('placed_at', { ascending: false });

    if (source === 'account') {
      query = query.is('league_id', null).is('tournament_id', null);
    } else if (league_id) {
      query = query.eq('league_id', league_id);
    }

    if (tournament_id) query = query.eq('tournament_id', tournament_id);
    if (status)        query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    next(err);
  }
});

async function refundWager({ userId, league_id, tournament_id, wager }) {
  if (tournament_id) {
    await supabase.rpc('adjust_tournament_balance', {
      p_tournament_id: tournament_id,
      p_user_id:       userId,
      p_amount:        wager,
    });
  } else if (league_id) {
    await supabase.rpc('adjust_league_balance', {
      p_league_id: league_id,
      p_user_id:   userId,
      p_amount:    wager,
    });
  } else {
    await supabase.rpc('adjust_account_balance', {
      p_user_id: userId,
      p_amount:  wager,
    });
  }
}

module.exports = router;
