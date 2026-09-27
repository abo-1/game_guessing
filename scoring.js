const POINTS_EXACT   = 3;
const POINTS_OUTCOME = 1;

function getOutcome(a, b) {
  if (a > b) return 'win_a';
  if (b > a) return 'win_b';
  return 'draw';
}

function calculatePoints(predictedA, predictedB, actualA, actualB) {
  if (predictedA === actualA && predictedB === actualB) return POINTS_EXACT;
  if (getOutcome(predictedA, predictedB) === getOutcome(actualA, actualB)) return POINTS_OUTCOME;
  return 0;
}

module.exports = { POINTS_EXACT, POINTS_OUTCOME, getOutcome, calculatePoints };
