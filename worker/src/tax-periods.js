export function previousCompletedQuarter(now = new Date()) {
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const currentQuarter = Math.floor(month / 3) + 1;
  return currentQuarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: currentQuarter - 1 };
}

export function periodBounds(year, quarter = null) {
  const y = normalizeYear(year);
  if (quarter == null) return { start: `${y}-01-01T00:00:00.000Z`, endExclusive: `${y + 1}-01-01T00:00:00.000Z` };
  const q = normalizeQuarter(quarter);
  const startMonth = (q - 1) * 3;
  return {
    start: new Date(Date.UTC(y, startMonth, 1)).toISOString(),
    endExclusive: new Date(Date.UTC(y, startMonth + 3, 1)).toISOString(),
  };
}

export function normalizeYear(value) {
  const y = Number(value);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) throw Object.assign(new Error('invalid tax year'), { status: 400 });
  return y;
}

export function normalizeQuarter(value) {
  const q = Number(value);
  if (!Number.isInteger(q) || q < 1 || q > 4) throw Object.assign(new Error('quarter must be 1-4'), { status: 400 });
  return q;
}
