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

  const d = parsed.solar?.solardata || parsed.solar;
  if (!d) {
    throw new Error('XML inválido: no se encontró solar/solardata');
  }

  function parseIntOrNull(value) {
    return (value !== undefined && value !== null && value !== '' && /^-?\d+$/.test(value)) ? parseInt(value, 10) : null;
  }

  function parseFloatOrNull(value) {
    return (value !== undefined && value !== null && value !== '' && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value)) ? parseFloat(value) : null;
  }

  function trimOrNull(value) {
    return typeof value === 'string' ? value.trim() || null : value || null;
  }

  const conn = await mysql.createConnection(dbConfig);
  try {
    const [result] = await conn.execute(`
      INSERT INTO solar_readings (
        updated, solar_flux, a_index, k_index, k_index_nt, x_ray, sunspots,
        helium_line, proton_flux, electron_flux, aurora, normalization,
        lat_degree, solar_wind, magnetic_field, geomag_field, signal_noise,
        fof2, muffactor, muf
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trimOrNull(d.updated),
        parseFloatOrNull(d.solarflux),
        parseIntOrNull(d.aindex),
        parseIntOrNull(d.kindex),
        trimOrNull(d.kindexnt),
        trimOrNull(d.xray),
        parseIntOrNull(d.sunspots),
        parseFloatOrNull(d.heliumline),
        parseFloatOrNull(d.protonflux),
        parseIntOrNull(d.electonflux ?? d.electronflux),
        parseIntOrNull(d.aurora),
        parseFloatOrNull(d.normalization),
        parseFloatOrNull(d.latdegree),
        parseFloatOrNull(d.solarwind),
        parseFloatOrNull(d.magneticfield),
        trimOrNull(d.geomagfield),
        trimOrNull(d.signalnoise),
        trimOrNull(d.fof2),
        trimOrNull(d.muffactor),
        trimOrNull(d.muf)
      ]
    );

    const readingId = result.insertId;
    if (!readingId) {
      throw new Error('No se obtuvo insertId al crear solar_readings');
    }

    await conn.execute('COMMIT');

    const calculatedBands = d.calculatedconditions ?? d.bandconditions;
    const bands = calculatedBands?.band || [];
    const bandArray = Array.isArray(bands) ? bands : bands ? [bands] : [];

    for (const band of bandArray) {
      await conn.execute(`
        INSERT INTO band_conditions (reading_id, band_name, time_of_day, current_condition)
        VALUES (?, ?, ?, ?)`,
        [readingId, band.$?.name || null, band.$?.time || null, band._ || null]
      );
    }

    const vhfSource = d.calculatedvhfconditions ?? d.vhfconditions;
    const vhfs = vhfSource?.phenomenon || [];
    const vhfArray = Array.isArray(vhfs) ? vhfs : vhfs ? [vhfs] : [];

    for (const pheno of vhfArray) {
      await conn.execute(`
        INSERT INTO vhf_conditions (reading_id, phenomenon_name, location, current_condition)
        VALUES (?, ?, ?, ?)`,
        [readingId, pheno.$?.name || null, pheno.$?.location || null, pheno._ || null]
      );
    }

    await conn.commit();
    console.log(`✅ Lectura guardada (id ${readingId})`);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }
}

parseAndStore().catch(err => console.error('❌ Error:', err.message));
