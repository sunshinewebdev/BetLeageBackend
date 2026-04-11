const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');

const router = express.Router();

// POST /api/leagues — create a league
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      name:           z.string().min(2).max(50),
      is_public:      z.boolean().optional().default(false),
      start_date:     z.string(),
      end_date:       z.string(),
      starting_chips: z.number().int().min(100).max(1000000).default(1000),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    // Premium check
    const { data: account } = await supabase
      .from('account_balances')
      .select('is_premium, premium_expires_at')
      .eq('user_id', req.user.id)
      .single();

    const isPremium = account?.is_premium &&
      (!account.premium_expires_at || new Date(account.premium_expires_at) > new Date());

    if (!isPremium) {
      return res.status(403).json({
        error: 'Premium membership required to create leagues',
        upgrade_required: true,
      });
    }

    const { data: league, error } = await supabase
      .from('leagues')
      .insert({ ...parsed.data, created_by: req.user.id })
      .select()
      .single();

    if (error) throw error;

    // Auto-join creator and initialize their balance
    await supabase.from('league_members').insert({
      league_id: league.id,
      user_id:   req.user.id,
      balance:   parsed.data.starting_chips,
    });

    res.status(201).json(league);
  } catch (err) {
    next(err);
  }
});

// POST /api/leagues/join — join via invite code
router.post('/join', requireAuth, async (req, res, next) => {
  try {
    const { invite_code } = req.body;
    if (!invite_code) return res.status(400).json({ error: 'invite_code required' });

    const { data: league } = await supabase
      .from('leagues')
      .select('id, name, starting_chips, start_date, end_date')
      .eq('invite_code', invite_code.toUpperCase())
      .single();

    if (!league) return res.status(404).json({ error: 'Invalid invite code' });

    const { error } = await supabase.from('league_members').insert({
      league_id: league.id,
      user_id:   req.user.id,
      balance:   league.starting_chips,
    });

    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Already a member of this league' });
    }
    if (error) throw error;

    res.json(league);
  } catch (err) {
    next(err);
  }
});

// GET /api/leagues — list leagues for the current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('leagues')
      .select('*, league_members!inner(user_id)')
      .eq('league_members.user_id', req.user.id);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/leagues/:id/my-balance — get current user's league balance
router.get('/:id/my-balance', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('league_members')
      .select('balance')
      .eq('league_id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not a member of this league' });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
