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

function durationMinutesAboveThreshold(rows, field, threshold, referenceNow = new Date()) {
  if (!Array.isArray(rows) || !rows.length) return 0;

  let activeSince = null;
  let totalMs = 0;

  for (const row of rows) {
    const value = Number(row[field]);
    const ts = new Date(row.timestamp);

    if (!Number.isFinite(value)) {
      if (activeSince) {
        totalMs += ts.getTime() - activeSince.getTime();
        activeSince = null;
      }
      continue;
    }

    if (value >= threshold) {
      if (!activeSince) activeSince = ts;
    } else if (activeSince) {
      totalMs += ts.getTime() - activeSince.getTime();
      activeSince = null;
    }
  }

  if (activeSince) {
    totalMs += referenceNow.getTime() - activeSince.getTime();
  }

  return Math.round(totalMs / 60000);
}

function peakAgeMinutes(rows, field, threshold, referenceNow = new Date()) {
  if (!Array.isArray(rows) || !rows.length) return null;

  let peak = null;
  let peakTs = null;
  for (const row of rows) {
    const value = Number(row[field]);
    if (!Number.isFinite(value)) continue;

    if (value >= threshold && (!peak || value > peak)) {
      peak = value;
      peakTs = new Date(row.timestamp);
    }
  }

  if (peakTs === null) return null;
  return Math.max(0, Math.round((referenceNow.getTime() - peakTs.getTime()) / 60000));
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
    const kMedianWindow = median(winRows.map((r) => Number(r.k_index)));

    // Slope 60m
    const kSlope60 = slopePerHour(rows65.map((r) => ({ t: r.timestamp, v: Number(r.k_index) })));
    const swSlope60 = slopePerHour(rows65.map((r) => ({ t: r.timestamp, v: Number(r.solar_wind) })));

    const kTrend =
      kSlope60 === null ? 'steady' :
      kSlope60 > 0.3 ? 'rising' :
      kSlope60 < -0.3 ? 'falling' : 'steady';

    const swTrend =
      swSlope60 === null ? 'steady' :
      swSlope60 > 40 ? 'rising' :
      swSlope60 < -40 ? 'falling' : 'steady';

    // Picos y persistencia (calculados por timestamp, no por "muestras * 5 min")
    const kVals = winRows.map((r) => Number(r.k_index)).filter(Number.isFinite);
    const pVals = winRows.map((r) => Number(r.proton_flux)).filter(Number.isFinite);

    const maxK = kVals.length ? Math.max(...kVals) : null;
    const maxP = pVals.length ? Math.max(...pVals) : null;
    const minutesKge4 = durationMinutesAboveThreshold(winRows, 'k_index', 4, now);
    const minutesPge10 = durationMinutesAboveThreshold(winRows, 'proton_flux', 10, now);
    const peakXAgeMinutes = peakAgeMinutes(winRows, 'k_index', maxK ?? 0, now);
    const peakPAgeMinutes = peakAgeMinutes(winRows, 'proton_flux', maxP ?? 0, now);

    const maxXClass = maxXrayClassFromRows(winRows);
    const xrayCurrent = (current.x_ray ?? '').toString().trim();
    const xrayCurrentClass = xrayClass(xrayCurrent);
    const xrayPeakAgeMinutes = (() => {
      const candidates = (winRows ?? []).filter((r) => xrayClass(r.x_ray));
      if (!candidates.length) return null;
      let peakRecord = null;
      let peakRank = 0;
      const rank = { A: 1, B: 2, C: 3, M: 4, X: 5 };
      for (const row of candidates) {
        const cls = xrayClass(row.x_ray);
        if (!cls) continue;
        if (rank[cls] > peakRank) {
          peakRank = rank[cls];
          peakRecord = row;
        }
      }
      if (!peakRecord) return null;
      return Math.max(0, Math.round((now.getTime() - new Date(peakRecord.timestamp).getTime()) / 60000));
    })();

    // Trend global simple pero no inmoviliza el viento solar como único causante
    let trend = 'steady';
    if (kSlope60 !== null && kSlope60 >= 0.3) trend = 'worsening';
    else if (kSlope60 !== null && kSlope60 <= -0.3) trend = 'improving';
    else if (swSlope60 !== null && swSlope60 >= 40) trend = 'worsening';
    else if (swSlope60 !== null && swSlope60 <= -40) trend = 'improving';

    // Coverage y confidence del contexto
    const expected = Math.max(1, Math.round(minutes / 5));
    const actualSamples = winRows.length;
    const coverage = Number((actualSamples / expected).toFixed(2));
    const confidence = coverage >= 0.8 ? 'high' : coverage >= 0.35 ? 'medium' : 'low';

    const drivers = [];
    if (kSlope60 !== null && kSlope60 > 0.3) drivers.push('rising_k');
    if (swSlope60 !== null && swSlope60 > 40) drivers.push('elevated_solar_wind');
    if (xrayCurrentClass && ['M', 'X'].includes(xrayCurrentClass)) drivers.push('xray_activity');
    if ((current.proton_flux ?? 0) >= 10) drivers.push('proton_event');

    const state =
      (kSlope60 !== null && kSlope60 >= 0.3) || (current.k_index >= 5) || (current.proton_flux >= 100) || (xrayCurrentClass && ['M', 'X'].includes(xrayCurrentClass))
        ? 'disturbed'
        : 'quiet';

    // Redondeos de salida (consistente con tu API)
    const severity =
      (current.k_index >= 5 || current.proton_flux >= 100 || xrayCurrentClass === 'M' || xrayCurrentClass === 'X')
        ? 'poor'
        : ((current.k_index >= 3 || (current.proton_flux ?? 0) >= 10 || xrayCurrentClass === 'C') ? 'fair' : 'good');

    const phase =
      severity === 'good' ? 'quiet' :
      (kSlope60 !== null && kSlope60 > 0.3) ? 'rising' :
      (kSlope60 !== null && kSlope60 < -0.3) ? 'recovering' :
      'active';

    const payload = {
      timestamp: current.timestamp,
      window,
      trend,
      confidence,
      data_quality: {
        actual_samples: actualSamples,
        expected_samples: expected,
        coverage,
        confidence,
      },
      trends: {
        geomagnetic: trend,
        solar_wind: swTrend === 'rising' ? 'worsening' : swTrend === 'falling' ? 'improving' : 'steady',
        xray: xrayCurrentClass && ['M', 'X'].includes(xrayCurrentClass) ? 'worsening' : 'steady',
        protons: (current.proton_flux ?? 0) >= 10 ? 'worsening' : 'steady',
        overall: {
          severity,
          phase,
        },
      },
      summary: {
        state,
        trend,
        drivers,
      },
      geomagnetic: {
        k: {
          current: Number(current.k_index),
          median_25m: kMedian25,
          median_window: kMedianWindow,
          slope_60m: kSlope60,
          trend: kTrend,
          max_window: maxK,
          minutes_ge_4: minutesKge4,
          delta_vs_window: kMedianWindow !== null ? Number(current.k_index) - kMedianWindow : null,
        },
        a: { current: Number(current.a_index) },
        state: (current.k_index >= 5 || (kSlope60 !== null && kSlope60 >= 0.3)) ? 'disturbed' : 'quiet',
        trend,
      },
      solar_wind: {
        speed: {
          current: Number(current.solar_wind),
          median_25m: swMedian25,
          median_window: median(winRows.map((r) => Number(r.solar_wind))),
          slope_60m: swSlope60,
          trend: swTrend,
        },
      },
      xray: {
        current: xrayCurrent || null,
        max_window: (winRows.some((r) => !!r.x_ray) ? (maxXClass ? maxXClass : null) : null),
        max_class: maxXClass,
        peak_age_minutes: xrayPeakAgeMinutes,
        minutes_since_peak: xrayPeakAgeMinutes,
      },
      protons: {
        current: Number(current.proton_flux),
        max_window: maxP,
        minutes_ge_10: minutesPge10,
        above_10_now: (Number(current.proton_flux) ?? 0) >= 10,
        peak_age_minutes: peakPAgeMinutes,
      },
      k: {
        current: Number(current.k_index),
        median_25m: kMedian25,
        median_window: kMedianWindow,
        slope_60m: kSlope60,
        trend: kTrend,
        max_window: maxK,
        minutes_ge_4: minutesKge4,
        delta_vs_window: kMedianWindow !== null ? Number(current.k_index) - kMedianWindow : null,
      },
      a: { current: Number(current.a_index) },
      p: {
        current: Number(current.proton_flux),
        max_window: maxP,
        minutes_ge_10: minutesPge10,
        above_10_now: (Number(current.proton_flux) ?? 0) >= 10,
        peak_age_minutes: peakPAgeMinutes,
      },
      x: {
        current: xrayCurrent || null,
        maxClass_window: maxXClass,
        max_window: (maxXClass ? maxXClass : null),
        max_class: maxXClass,
        peak_age_minutes: xrayPeakAgeMinutes,
        minutes_since_peak: xrayPeakAgeMinutes,
      },
      sw: {
        current: Number(current.solar_wind),
        median_25m: swMedian25,
        median_window: median(winRows.map((r) => Number(r.solar_wind))),
        slope_60m: swSlope60,
        trend: swTrend,
      },
      b: {
        current: Number(current.magnetic_field),
        median_25m: bMedian25,
      },
    };

    // redondea campos numéricos (2 decimales)
    roundFields(payload.k, ['current', 'median_25m', 'median_window', 'slope_60m', 'max_window', 'delta_vs_window'], 2);
    roundFields(payload.p, ['current', 'max_window'], 2);
    roundFields(payload.sw, ['current', 'median_25m', 'median_window', 'slope_60m'], 2);
    roundFields(payload.b, ['current', 'median_25m'], 2);
    roundFields(payload.geomagnetic.k, ['current', 'median_25m', 'median_window', 'slope_60m', 'max_window', 'delta_vs_window'], 2);
    roundFields(payload.solar_wind.speed, ['current', 'median_25m', 'median_window', 'slope_60m'], 2);
    roundFields(payload.protons, ['current', 'max_window'], 2);

    logger.info('Response sent for /api/solar/now-context', { window, trend, confidence, coverage });
    return res.json(payload);
  } catch (err) {
    if (conn) {
      try { await conn.end(); } catch {}
    }
    logger.error('Error in /api/solar/now-context', { error: err });
    return res.status(500).json({ error: 'Server error' });
  }
};
