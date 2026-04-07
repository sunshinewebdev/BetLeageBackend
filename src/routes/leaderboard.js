const express = require('express');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /api/leaderboard/:season_id
router.get('/:season_id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('leaderboard')
      .select('*')
      .eq('season_id', req.params.season_id)
      .order('rank', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
