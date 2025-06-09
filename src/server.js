const express = require('express');
const mysql = require('mysql2/promise');
const app = express();
const PORT = 3000;
const HOST = '127.0.0.1';

const dbConfig = {
  host: 'localhost',
  user: 'dxsun',
  password: 'Los pajaros de plomo no vuelan tan bien como los de carne y hueso.',
  database: 'dxsun'
};

app.get('/api/solar/last', async (req, res) => {
  console.log("➡️ Recibida petición GET /api/solar/last");

  try {
    const conn = await mysql.createConnection(dbConfig);

    const [rows] = await conn.execute(
      `SELECT * FROM solar_readings ORDER BY timestamp DESC LIMIT 1`
    );
    if (rows.length === 0) return res.status(404).json({ message: 'No data found' });

    const reading = rows[0];

    // Redondear los campos que necesitan limpieza
    roundFields(reading, [
      'solar_flux',
      'a_index',
      'k_index',
      'k_index_nt', // aunque no sea numérico, no afecta si no lo es
      'magnetic_field',
      'helium_line',
      'proton_flux',
      'electron_flux',
      'aurora',
      'normalization',
      'lat_degree',
      'solar_wind'
    ], 2);

    const [bands] = await conn.execute(
      `SELECT band_name, time_of_day, current_condition FROM band_conditions WHERE reading_id = ?`,
      [reading.id]
    );

    const [vhfs] = await conn.execute(
      `SELECT phenomenon_name, location, current_condition FROM vhf_conditions WHERE reading_id = ?`,
      [reading.id]
    );

    await conn.end();

    res.json({
      ...reading,
      bands,
      vhf_conditions: vhfs
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/solar/history', async (req, res) => {
  console.log("➡️ Recibida petición GET /api/solar/history");

  const { param, range } = req.query;

  // Validación rápida
  const allowedParams = [
    'solar_flux', 'sunspots', 'a_index', 'k_index', 'helium_line', 'proton_flux',
    'electron_flux', 'aurora', 'lat_degree', 'solar_wind', 'normalization', 'magnetic_field', 'k_index_nt'
  ];
  if (!allowedParams.includes(param)) {
    return res.status(400).json({ error: 'Invalid param' });
  }

  // Calcular intervalo de tiempo
  const now = new Date();
  let since = new Date();
  if (range === '3d') since.setDate(now.getDate() - 3);
  else if (range === '7d') since.setDate(now.getDate() - 7);
  else since.setDate(now.getDate() - 1); // Por defecto: 24h

  try {
    const conn = await mysql.createConnection(dbConfig);

    const [rows] = await conn.execute(
      `SELECT timestamp, \`${param}\` as value
       FROM solar_readings
       WHERE timestamp >= ?
       ORDER BY timestamp ASC`,
      [since.toISOString().slice(0, 19).replace('T', ' ')]
    );

    await conn.end();

    // Redondear los valores numéricos en cada fila
    rows.forEach(row => {
      roundFields(row, ['value'], 2);
    });

    res.json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


app.listen(PORT, HOST, () => {
  console.log(`🌞 Servidor solar en http://${HOST}:${PORT}`);
});

// Función para redondear campos numéricos
function roundFields(obj, fields, decimals = 2) {
  fields.forEach(field => {
    if (obj[field] !== null && typeof obj[field] === 'number') {
      obj[field] = parseFloat(obj[field].toFixed(decimals));
    }
  });
}
