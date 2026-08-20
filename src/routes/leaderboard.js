const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');
const cache = require('../lib/ttlCache');

const router = express.Router();

const CATEGORIES = ['balance', 'wins', 'odds', 'win_pct', 'profit'];
const globalQuerySchema = z.object({
  period: z.enum(['all', 'yearly', 'monthly']).default('all'),
});

const BOARD_TTL_MS = 5 * 60_000;

// GET /api/leaderboard/global/:category?period=all|yearly|monthly
// Public top-100 boards. Must be registered BEFORE /:league_id below,
// or Express would route /global/* to the league handler.
router.get('/global/:category', async (req, res, next) => {
  try {
    const { category } = req.params;
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Unknown category' });
    }
    const parsed = globalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid period' });
    }
    // Balance is a snapshot — there is no monthly/yearly variant
    const period = category === 'balance' ? 'all' : parsed.data.period;

    const key = `board:${category}:${period}`;
    let rows = cache.get(key);
    if (!rows) {
      const { data, error } = await supabase.rpc('global_leaderboard', {
        p_category: category,
        p_period:   period,
        p_limit:    100,
      });
      if (error) throw error;
      rows = data || [];
      cache.set(key, rows, BOARD_TTL_MS);
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/leaderboard/:league_id
router.get('/:league_id', requireAuth, async (req, res, next) => {
  try {
    // Only league members may view the leaderboard
    const { data: membership } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', req.params.league_id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this league' });
    }

    const { data, error } = await supabase
      .from('leaderboard')
      .select('*')
      .eq('league_id', req.params.league_id)
      .order('rank', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
