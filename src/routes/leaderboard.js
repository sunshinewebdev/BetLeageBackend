const express = require('express');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /api/leaderboard/:league_id
router.get('/:league_id', requireAuth, async (req, res, next) => {
  try {
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
