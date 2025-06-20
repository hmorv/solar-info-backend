require('dotenv').config(); // Carga las variables de entorno

const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs'); // ✅ Añadido
const morgan = require('morgan');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

const PORT = 3000;
const HOST = '127.0.0.1';

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'dxsun',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'dxsun'
};

const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 peticiones por minuto
  standardHeaders: true,
  legacyHeaders: false
});


app.use(limiter);

// 📄 Crear stream de logs
const accessLogStream = fs.createWriteStream('/home/hugo/dxsun/solar-api-access.log', { flags: 'a' });

// 👉 Log personalizado con IP real y timestamp ISO
app.use(morgan(
  ':remote-addr - :remote-user [:date[iso]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"',
  { stream: accessLogStream }
));

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
    'electron_flux', 'aurora', 'lat_degree', 'solar_wind', 'normalization', 'magnetic_field', 'k_index_nt', 'x_ray'
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
    let sampledRows = [];
    if (range === '3d') {
      // Consulta optimizada para 3 días (864 registros totales)
      const [[{ total }]] = await conn.execute(
        `SELECT COUNT(*) as total FROM solar_readings WHERE timestamp >= ?`,
        [since.toISOString().slice(0, 19).replace('T', ' ')]
      );
      const step = Math.ceil(total / 72); // 864 / 72 = 12 registros (salto de 1 hora)
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
      // Consulta optimizada para 7 días (2016 registros totales)
      const [[{ total }]] = await conn.execute(
        `SELECT COUNT(*) as total FROM solar_readings WHERE timestamp >= ?`,
        [since.toISOString().slice(0, 19).replace('T', ' ')]
      );
      const step = Math.ceil(total / 168); // 2016 / 168 = 12 registros (salto de 1 hora)
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
      // Para 24h, trae todo
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

    sampledRows.forEach(row => {
      roundFields(row, ['value'], 2);
    });

    res.json(sampledRows);

    // const [rows] = await conn.execute(
    //   `SELECT timestamp, \`${param}\` as value
    //    FROM solar_readings
    //    WHERE timestamp >= ?
    //    ORDER BY timestamp ASC`,
    //   [since.toISOString().slice(0, 19).replace('T', ' ')]
    // );

    // await conn.end();

    // Redondear los valores numéricos en cada fila
    // rows.forEach(row => {
    //   roundFields(row, ['value'], 2);
    // });

    // Downsampling según rango
    // let sampledRows = rows;
    // if (range === '3d' && rows.length > 400) {
    //   const step = Math.floor(rows.length / 400);
    //   sampledRows = rows.filter((_, idx) => idx % step === 0);
    //   if (sampledRows[sampledRows.length - 1] !== rows[rows.length - 1]) {
    //     sampledRows.push(rows[rows.length - 1]);
    //   }
    // } else if (range === '7d' && rows.length > 600) {
    //   const step = Math.floor(rows.length / 600);
    //   sampledRows = rows.filter((_, idx) => idx % step === 0);
    //   if (sampledRows[sampledRows.length - 1] !== rows[rows.length - 1]) {
    //     sampledRows.push(rows[rows.length - 1]);
    //   }
    // }
    // Para 24h, no se limita

    // res.json(rows);

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
