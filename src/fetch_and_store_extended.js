const https = require('https');
const mysql = require('mysql2/promise');
const { parseStringPromise } = require('xml2js');

const dbConfig = {
  host: 'localhost',
  user: 'dxsun',
  password: 'Los pajaros de plomo no vuelan tan bien como los de carne y hueso.',
  database: 'dxsun'
};

const url = 'https://www.hamqsl.com/solarxml.php';

async function fetchXML() {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  });
}

async function parseAndStore() {
  const xml = await fetchXML();
  const parsed = await parseStringPromise(xml, { explicitArray: false });

  const d = parsed.solar.solardata;

  const conn = await mysql.createConnection(dbConfig);

  const [result] = await conn.execute(`
    INSERT INTO solar_readings (
      updated, solar_flux, a_index, k_index, k_index_nt, x_ray, sunspots,
      helium_line, proton_flux, electron_flux, aurora, normalization,
      lat_degree, solar_wind, magnetic_field, geomag_field, signal_noise,
      fof2, muffactor, muf
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.updated?.trim() || null,
      (d.solarflux !== undefined && d.solarflux !== null && d.solarflux !== '') ? parseFloat(d.solarflux) : null,
      (d.aindex !== undefined && d.aindex !== null && d.aindex !== '') ? parseInt(d.aindex) : null,
      (d.kindex !== undefined && d.kindex !== null && d.kindex !== '') ? parseInt(d.kindex) : null,
      d.kindexnt || null,
      d.xray || null,
      (d.sunspots !== undefined && d.sunspots !== null && d.sunspots !== '') ? parseInt(d.sunspots) : null,
      (d.heliumline !== undefined && d.heliumline !== null && d.heliumline !== '') ? parseFloat(d.heliumline) : null,
      (d.protonflux !== undefined && d.protonflux !== null && d.protonflux !== '') ? parseFloat(d.protonflux) : null,
      (d.electonflux !== undefined && d.electonflux !== null && d.electonflux !== '') ? parseInt(d.electonflux) : null,
      (d.aurora !== undefined && d.aurora !== null && d.aurora !== '') ? parseInt(d.aurora) : null,
      (d.normalization !== undefined && d.normalization !== null && d.normalization !== '') ? parseFloat(d.normalization) : null,
      (d.latdegree !== undefined && d.latdegree !== null && d.latdegree !== '') ? parseFloat(d.latdegree) : null,
      (d.solarwind !== undefined && d.solarwind !== null && d.solarwind !== '') ? parseFloat(d.solarwind) : null,
      (d.magneticfield !== undefined && d.magneticfield !== null && d.magneticfield !== '') ? parseFloat(d.magneticfield) : null,
      d.geomagfield || null,
      d.signalnoise || null,
      d.fof2 || null,
      d.muffactor || null,
      d.muf || null
    ]
  );

  const readingId = result.insertId;

  // Band conditions
  const bands = d.calculatedconditions?.band || [];
  for (const band of Array.isArray(bands) ? bands : [bands]) {
    await conn.execute(`
      INSERT INTO band_conditions (reading_id, band_name, time_of_day, current_condition)
      VALUES (?, ?, ?, ?)`,
      [readingId, band.$.name, band.$.time, band._]
    );
  }

  // VHF conditions
  const vhfs = d.calculatedvhfconditions?.phenomenon || [];
  for (const pheno of Array.isArray(vhfs) ? vhfs : [vhfs]) {
    await conn.execute(`
      INSERT INTO vhf_conditions (reading_id, phenomenon_name, location, current_condition)
      VALUES (?, ?, ?, ?)`,
      [readingId, pheno.$.name, pheno.$.location, pheno._]
    );
  }

  await conn.end();
  console.log(`✅ Lectura guardada (id ${readingId})`);
}

parseAndStore().catch(err => console.error('❌ Error:', err.message));
