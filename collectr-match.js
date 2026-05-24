/**
 * Strict Collectr variant matching: card number first, then finish (subType).
 */

function normalizeSubType(subType) {
  return (subType || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeCardNumber(num) {
  if (!num) return '';
  const s = String(num).trim().replace(/^#/, '');
  const m = s.match(/^0*(\d+)\s*\/\s*0*(\d+)$/);
  if (m) return `${parseInt(m[1], 10)}/${parseInt(m[2], 10)}`;
  return s.toLowerCase();
}

function cardNumbersMatch(a, b) {
  const na = normalizeCardNumber(a);
  const nb = normalizeCardNumber(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * Pick exactly one Collectr row.
 * 1) Match card number (e.g. 058/159)
 * 2) Match finish (e.g. Normal, Reverse Holofoil)
 * 3) Optionally confirm collectr_id
 */
function pickMatchingCard(cards, criteria) {
  const { collectrId, subType, cardNumber } = criteria;
  if (!cards?.length) return null;

  let pool = cards;

  if (cardNumber) {
    pool = pool.filter((c) => cardNumbersMatch(c.cardNumber, cardNumber));
    if (!pool.length) return null;
  }

  if (subType) {
    const want = normalizeSubType(subType);
    pool = pool.filter((c) => normalizeSubType(c.subType) === want);
    if (!pool.length) return null;
  }

  if (collectrId && pool.length > 1) {
    const byId = pool.filter((c) => String(c.collectrId) === String(collectrId));
    if (byId.length === 1) return byId[0];
  }

  if (pool.length === 1) return pool[0];
  return null;
}

module.exports = {
  normalizeSubType,
  normalizeCardNumber,
  cardNumbersMatch,
  pickMatchingCard,
};
