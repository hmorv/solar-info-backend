// Controlador para las rutas solares
const { getConnection } = require('../config/mysql');
const logger = require('../config/logger');

// Redondear campos numéricos
function roundFields(obj, fields, decimals = 2) {
  fields.forEach((field) => {
    if (obj[field] !== null && typeof obj[field] === 'number') {
      obj[field] = parseFloat(obj[field].toFixed(decimals));
    }
  });
}

exports.getLast = async (req, res) => {
  logger.info('➡️ Received GET request /api/solar/last');
  let conn;
  try {
    conn = await getConnection();
    const [rows] = await conn.execute(
      `SELECT * FROM solar_readings ORDER BY timestamp DESC LIMIT 1`
    );
    if (rows.length === 0) {
      logger.warn('No data found in /api/solar/last');
      return res.status(404).json({ message: 'No data found' });
    }
    const reading = rows[0];
    roundFields(
      reading,
      [
        'solar_flux',
        'a_index',
        'k_index',
        'k_index_nt',
        'magnetic_field',
        'helium_line',
        'proton_flux',
        'electron_flux',
        'aurora',
        'normalization',
        'lat_degree',
        'solar_wind',
      ],
      2
    );
    const [bands] = await conn.execute(
      `SELECT band_name, time_of_day, current_condition FROM band_conditions WHERE reading_id = ?`,
      [reading.id]
    );
    const [vhfs] = await conn.execute(
      `SELECT phenomenon_name, location, current_condition FROM vhf_conditions WHERE reading_id = ?`,
      [reading.id]
    );
    await conn.end();
    logger.info('Response sent for /api/solar/last');
    res.json({
      ...reading,
      bands,
      vhf_conditions: vhfs,
    });
  } catch (err) {
    logger.error('Error in /api/solar/last', { error: err });
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getHistory = async (req, res) => {
  logger.info('➡️ Received GET request /api/solar/history', {
    query: req.query,
  });
  const { param, range } = req.query;
  const allowedParams = [
    'solar_flux',
    'sunspots',
    'a_index',
    'k_index',
    'helium_line',
    'proton_flux',
    'electron_flux',
    'aurora',
    'lat_degree',
    'solar_wind',
    'normalization',
    'magnetic_field',
    'k_index_nt',
    'x_ray',
  ];
  if (!allowedParams.includes(param)) {
    logger.warn('Invalid param in /api/solar/history', { param });
    return res.status(400).json({ error: 'Invalid param' });
  }
  const now = new Date();
  let since = new Date();
  if (range === '3d') since.setDate(now.getDate() - 3);
  else if (range === '7d') since.setDate(now.getDate() - 7);
  else since.setDate(now.getDate() - 1);
  try {
    const conn = await getConnection();
    let sampledRows = [];
    if (range === '3d') {
      const [[{ total }]] = await conn.execute(
        `SELECT COUNT(*) as total FROM solar_readings WHERE timestamp >= ?`,
        [since.toISOString().slice(0, 19).replace('T', ' ')]
      );
      const step = Math.ceil(total / 72);
      const [rows] = await conn.execute(
        `SELECT timestamp, \`${param}\` as value
         FROM (
           SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp ASC) as rn
           FROM solar_readings
           WHERE timestamp >= ?
         ) t
         WHERE MOD(rn - 1, ?) = 0
         ORDER BY timestamp ASC`,
        [since.toISOString().slice(0, 19).replace('T', ' '), step]
      );
      sampledRows = rows;
    } else if (range === '7d') {
      const [[{ total }]] = await conn.execute(
        `SELECT COUNT(*) as total FROM solar_readings WHERE timestamp >= ?`,
        [since.toISOString().slice(0, 19).replace('T', ' ')]
      );
      const step = Math.ceil(total / 168);
      const [rows] = await conn.execute(
        `SELECT timestamp, \`${param}\` as value
         FROM (
           SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp ASC) as rn
           FROM solar_readings
           WHERE timestamp >= ?
         ) t
         WHERE MOD(rn - 1, ?) = 0
         ORDER BY timestamp ASC`,
        [since.toISOString().slice(0, 19).replace('T', ' '), step]
      );
      sampledRows = rows;
    } else {
      const [rows] = await conn.execute(
        `SELECT timestamp, \`${param}\` as value
         FROM solar_readings
         WHERE timestamp >= ?
         ORDER BY timestamp ASC`,
        [since.toISOString().slice(0, 19).replace('T', ' ')]
      );
      sampledRows = rows;
    }
    await conn.end();
    sampledRows.forEach((row) => {
      roundFields(row, ['value'], 2);
    });
    logger.info('Response sent for /api/solar/history', {
      count: sampledRows.length,
    });
    res.json(sampledRows);
  } catch (err) {
    logger.error('Error in /api/solar/history', { error: err });
    res.status(500).json({ error: 'Server error' });
  }
};

// ======================= NOW CONTEXT (agregado) =======================

// Utilidades
const WINDOW_MINUTES = { '1h': 60, '3h': 180, '6h': 360, '12h': 720, '24h': 1440 };

function median(nums) {
  const arr = (nums ?? []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function slopePerHour(points) {
  // points: [{ t: Date|string, v: number }] en orden ASC
  const p = (points ?? []).filter((x) => Number.isFinite(x.v));
  if (p.length < 2) return null;

  const t0 = new Date(p[0].t).getTime();
  const t1 = new Date(p[p.length - 1].t).getTime();
  const dtH = (t1 - t0) / (1000 * 60 * 60);
  if (dtH <= 0) return null;

  return (p[p.length - 1].v - p[0].v) / dtH;
}

function xrayClass(x) {
  const m = String(x ?? '').trim().match(/^([ABCMX])\s*\d/i);
  return m ? m[1].toUpperCase() : null;
}

function maxXrayClassFromRows(rows) {
  const rank = { A: 1, B: 2, C: 3, M: 4, X: 5 };
  let best = null;
  for (const r of rows ?? []) {
    const c = xrayClass(r.x_ray);
    if (!c) continue;
    if (!best || rank[c] > rank[best]) best = c;
  }
  return best; // 'A'|'B'|'C'|'M'|'X'|null
}

function toIsoSqlDate(d) {
  // yyyy-mm-dd hh:mm:ss (como ya haces)
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

exports.getNowContext = async (req, res) => {
  logger.info('➡️ Received GET request /api/solar/now-context', { query: req.query });

  const window = (req.query.window || '6h').toString();
  const minutes = WINDOW_MINUTES[window] ?? 360;

  // Ventanas útiles:
  // - last 25m: ~6 muestras (para medianas y evitar flicker)
  // - last 65m: ~13 muestras (para slope 60m)
  // - window: 1h..24h (persistencia/picos)
  const now = new Date();
  const since25 = new Date(now.getTime() - 25 * 60 * 1000);
  const since65 = new Date(now.getTime() - 65 * 60 * 1000);
  const sinceW = new Date(now.getTime() - minutes * 60 * 1000);

  let conn;
  try {
    conn = await getConnection();

    // 1) current (la última fila)
    const [curRows] = await conn.execute(
      `SELECT timestamp, k_index, a_index, proton_flux, solar_wind, magnetic_field, x_ray
       FROM solar_readings
       ORDER BY timestamp DESC
       LIMIT 1`
    );
    const current = curRows?.[0] ?? null;

    // 2) últimas ~25 min (median)
    const [rows25] = await conn.execute(
      `SELECT timestamp, k_index, solar_wind, magnetic_field
       FROM solar_readings
       WHERE timestamp >= ?
       ORDER BY timestamp ASC`,
      [toIsoSqlDate(since25)]
    );

    // 3) últimas ~65 min (slope 60m)
    const [rows65] = await conn.execute(
      `SELECT timestamp, k_index, solar_wind
       FROM solar_readings
       WHERE timestamp >= ?
       ORDER BY timestamp ASC`,
      [toIsoSqlDate(since65)]
    );

    // 4) ventana grande (persistencia/picos + xray/protones)
    const [winRows] = await conn.execute(
      `SELECT timestamp, k_index, a_index, proton_flux, solar_wind, magnetic_field, x_ray
       FROM solar_readings
       WHERE timestamp >= ?
       ORDER BY timestamp ASC`,
      [toIsoSqlDate(sinceW)]
    );

    await conn.end();

    if (!current) {
      logger.warn('No data found in /api/solar/now-context');
      return res.status(404).json({ message: 'No data found' });
    }

    // Median 25m
    const kMedian25 = median(rows25.map((r) => Number(r.k_index)));
    const swMedian25 = median(rows25.map((r) => Number(r.solar_wind)));
    const bMedian25 = median(rows25.map((r) => Number(r.magnetic_field)));

    // Slope 60m
    const kSlope60 = slopePerHour(rows65.map((r) => ({ t: r.timestamp, v: Number(r.k_index) })));
    const swSlope60 = slopePerHour(rows65.map((r) => ({ t: r.timestamp, v: Number(r.solar_wind) })));

    // Picos y persistencia (aprox por muestras*5min)
    const kVals = winRows.map((r) => Number(r.k_index)).filter(Number.isFinite);
    const pVals = winRows.map((r) => Number(r.proton_flux)).filter(Number.isFinite);

    const maxK = kVals.length ? Math.max(...kVals) : null;
    const maxP = pVals.length ? Math.max(...pVals) : null;

    const minutesKge4 = winRows.filter((r) => Number(r.k_index) >= 4).length * 5;
    const minutesPge10 = winRows.filter((r) => Number(r.proton_flux) >= 10).length * 5;

    const maxXClass = maxXrayClassFromRows(winRows);

    // Trend simple (puedes ajustar umbrales)
    let trend = 'steady';
    if ((kSlope60 !== null && kSlope60 >= 0.6) || (swSlope60 !== null && swSlope60 >= 80)) trend = 'worsening';
    else if ((kSlope60 !== null && kSlope60 <= -0.6) || (swSlope60 !== null && swSlope60 <= -80)) trend = 'improving';

    // Confidence: depende de cuántas muestras tengas dentro de la ventana elegida
    const expected = Math.max(1, Math.round(minutes / 5));
    const ratio = winRows.length / expected;
    const confidence = ratio >= 0.8 ? 'high' : ratio >= 0.35 ? 'medium' : 'low';

    // Redondeos de salida (consistente con tu API)
    const payload = {
      window,
      trend,
      confidence,
      k: {
        current: Number(current.k_index),
        median_25m: kMedian25,
        slope_60m: kSlope60,
        max_window: maxK,
        minutes_ge_4: minutesKge4,
      },
      a: { current: Number(current.a_index) },
      p: {
        current: Number(current.proton_flux),
        max_window: maxP,
        minutes_ge_10: minutesPge10,
      },
      x: {
        current: (current.x_ray ?? '').toString(),
        maxClass_window: maxXClass,
      },
      sw: {
        current: Number(current.solar_wind),
        median_25m: swMedian25,
        slope_60m: swSlope60,
      },
      b: {
        current: Number(current.magnetic_field),
        median_25m: bMedian25,
      },
    };

    // redondea campos numéricos (2 decimales)
    roundFields(payload.k, ['current', 'median_25m', 'slope_60m', 'max_window'], 2);
    roundFields(payload.p, ['current', 'max_window'], 2);
    roundFields(payload.sw, ['current', 'median_25m', 'slope_60m'], 2);
    roundFields(payload.b, ['current', 'median_25m'], 2);

    logger.info('Response sent for /api/solar/now-context', { window, trend, confidence });
    return res.json(payload);
  } catch (err) {
    if (conn) {
      try { await conn.end(); } catch {}
    }
    logger.error('Error in /api/solar/now-context', { error: err });
    return res.status(500).json({ error: 'Server error' });
  }
};
