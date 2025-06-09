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
      parseFloat(d.solarflux) || null,
      parseInt(d.aindex) || null,
      parseInt(d.kindex) || null,
      d.kindexnt || null,
      d.xray || null,
      parseInt(d.sunspots) || null,
      parseFloat(d.heliumline) || null,
      parseFloat(d.protonflux) || null,
      parseInt(d.electonflux) || null,
      parseInt(d.aurora) || null,
      parseFloat(d.normalization) || null,
      parseFloat(d.latdegree) || null,
      parseFloat(d.solarwind) || null,
      parseFloat(d.magneticfield) || null,
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
