function americanToDecimal(americanOdds) {
  const o = Number(americanOdds);
  if (o > 0) return 1 + o / 100;
  return 1 + 100 / Math.abs(o);
}

function decimalToAmerican(decimalOdds) {
  const d = Number(decimalOdds);
  if (d >= 2) return Math.round((d - 1) * 100);
  return Math.round(-100 / (d - 1));
}

function calculateParlayOdds(americanOddsArray) {
  if (!Array.isArray(americanOddsArray) || americanOddsArray.length === 0) return 0;
  const combinedDecimal = americanOddsArray.reduce((acc, o) => acc * americanToDecimal(o), 1);
  return decimalToAmerican(combinedDecimal);
}

function calculateParlayPayout(wager, americanOddsArray) {
  if (!Array.isArray(americanOddsArray) || americanOddsArray.length === 0) return 0;
  const combinedDecimal = americanOddsArray.reduce((acc, o) => acc * americanToDecimal(o), 1);
  return +(Number(wager) * combinedDecimal).toFixed(2);
}

module.exports = {
  americanToDecimal,
  decimalToAmerican,
  calculateParlayOdds,
  calculateParlayPayout,
};
