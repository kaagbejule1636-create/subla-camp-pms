// Resolves a payment amount to the property's base currency (AED).
// Returns { amount, currency, exchange_rate, original_amount } ready to insert
// into folio_transactions. Throws if an unrecognized currency code is given.
async function resolvePaymentAmount(pool, rawAmount, currencyCode) {
  const code = (currencyCode || 'AED').toUpperCase();

  if (code === 'AED') {
    return { amount: Number(rawAmount), currency: 'AED', exchange_rate: 1, original_amount: null };
  }

  const { rows } = await pool.query('SELECT rate_to_base FROM currencies WHERE code = $1', [code]);
  if (!rows.length) {
    const err = new Error(`Unknown currency '${code}' — add it via POST /api/currencies first`);
    err.status = 400;
    throw err;
  }

  const rate = Number(rows[0].rate_to_base);
  const converted = Math.round(Number(rawAmount) * rate * 100) / 100;

  return { amount: converted, currency: code, exchange_rate: rate, original_amount: Number(rawAmount) };
}

module.exports = { resolvePaymentAmount };
