// Controlador para datos ionosféricos de GIRO
const axios = require('axios');
const logger = require('../config/logger');
const stations = require('../config/stations');

const GIRO_BASE_URL = 'https://lgdc.uml.edu/common/DIDBGetValues';
const DISTANCE_THRESHOLD_KM = 500; // Aproximación: 1 grado ≈ 111 km

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function findNearestStation(lat, lon) {
  let nearest = null;
  let minDistance = Infinity;

  stations.forEach((station) => {
    const distance = calculateDistance(lat, lon, station.lat, station.lon);

    if (distance < minDistance) {
      minDistance = distance;
      nearest = { ...station, distance: minDistance };
    }
  });

  return nearest;
}

function normalizeLongitude(lon) {
  if (lon > 180) return lon - 360;
  return lon;
}

function formatGiroDate(date) {
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(
    date.getUTCDate()
  ).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(
    date.getUTCMinutes()
  ).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

function parseGiroNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function parseGiroResponse(data) {
  const lines = data.split('\n');

  let lastDataLine = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();

    if (line && /^\d{4}-\d{2}-\d{2}T/.test(line)) {
      lastDataLine = line;
      break;
    }
  }

  if (!lastDataLine) {
    throw new Error('No data found in GIRO response');
  }

  // Formato real esperado:
  // Time CS foF2 QD MUFD QD foEs QD hF2 QD MD QD
  const parts = lastDataLine.split(/\s+/);

  if (parts.length < 12) {
    throw new Error(`Invalid data format in GIRO response: ${lastDataLine}`);
  }

  const timestamp = parts[0];
  const cs = parseInt(parts[1], 10);

  const tokens = parts.slice(2);

  const foF2 = parseGiroNumber(tokens[0]);
  const mufd = parseGiroNumber(tokens[2]);
  const foEs = parseGiroNumber(tokens[4]);
  const hF2 = parseGiroNumber(tokens[6]);
  const md = parseGiroNumber(tokens[8]);

  const measurementDate = new Date(timestamp);

  if (Number.isNaN(measurementDate.getTime())) {
    throw new Error(`Invalid timestamp in GIRO response: ${timestamp}`);
  }

  const now = new Date();
  const ageMinutes = Math.floor((now - measurementDate) / (1000 * 60));

  let freshness = 'old';
  if (ageMinutes < 60) freshness = 'fresh';
  else if (ageMinutes < 180) freshness = 'ok';

  return {
    timestamp: measurementDate.toISOString(),
    foF2,
    mufd,
    mufFactor: md,
    hF2,
    foEs,
    confidence: cs,
    ageMinutes,
    freshness,
  };
}

exports.getHFData = async (req, res) => {
  logger.info('➡️ Received GET request /api/ionosphere/hf');

  try {
    const { lat, lon } = req.query;

    if (lat === undefined || lon === undefined) {
      logger.warn('Missing lat or lon parameters');
      return res.status(400).json({ error: 'lat and lon parameters are required' });
    }

    const userLat = parseFloat(lat);
    const userLon = parseFloat(lon);

    if (Number.isNaN(userLat) || Number.isNaN(userLon)) {
      logger.warn('Invalid lat or lon values');
      return res.status(400).json({ error: 'lat and lon must be valid numbers' });
    }

    const nearestStation = findNearestStation(userLat, userLon);

    if (!nearestStation) {
      logger.warn('No GIRO station found');
      return res.status(500).json({ error: 'No GIRO station available' });
    }

    logger.info('Nearest station found', {
      station: nearestStation.name,
      distance: nearestStation.distance.toFixed(2),
    });

    const now = new Date();
    const toDate = new Date(now);
    const fromDate = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    const fromDateStr = formatGiroDate(fromDate);
    const toDateStr = formatGiroDate(toDate);

    logger.info('GIRO request parameters', {
      ursiCode: nearestStation.ursi,
      fromDate: fromDateStr,
      toDate: toDateStr,
    });

    const giroResponse = await axios.get(GIRO_BASE_URL, {
      params: {
        ursiCode: nearestStation.ursi,
        charName: 'foF2,MUFD,MD,hF2,foEs',
        DMUF: 3000,
        fromDate: fromDateStr,
        toDate: toDateStr,
      },
      timeout: 10000,
    });

    logger.info('GIRO response received', {
      status: giroResponse.status,
      dataLength: giroResponse.data.length,
    });

    const parsedData = parseGiroResponse(giroResponse.data);

    const response = {
      station: {
        ursiCode: nearestStation.ursi,
        name: nearestStation.name,
        distanceKm: Number(nearestStation.distance.toFixed(2)),
      },
      measuredAt: parsedData.timestamp,
      foF2: parsedData.foF2,
      muf: parsedData.mufd,
      mufFactor: parsedData.mufFactor,
      hF2: parsedData.hF2,
      foEs: parsedData.foEs,
      confidence: parsedData.confidence,
      ageMinutes: parsedData.ageMinutes,
      freshness: parsedData.freshness,
    };

    logger.info('Response sent for /api/ionosphere/hf', {
      station: nearestStation.name,
      foF2: parsedData.foF2,
      muf: parsedData.mufd,
      mufFactor: parsedData.mufFactor,
    });

    return res.json(response);
  } catch (error) {
    if (error.response) {
      logger.error('GIRO API error', {
        status: error.response.status,
        data: error.response.data,
      });

      return res.status(500).json({ error: 'Failed to fetch data from GIRO service' });
    }

    logger.error('Error in /api/ionosphere/hf', { error: error.message });
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};