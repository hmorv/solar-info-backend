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
