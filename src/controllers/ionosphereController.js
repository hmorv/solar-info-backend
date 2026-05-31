// Controlador para datos ionosféricos de GIRO
const axios = require('axios');
const logger = require('../config/logger');
const stations = require('../config/stations');

const GIRO_BASE_URL = 'https://lgdc.uml.edu/fastchar/getbest';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const giroCache = new Map();

function getCacheKey(station) {
  return station.ursi.toUpperCase();
}

function getCachedData(station) {
  const key = getCacheKey(station);
  const entry = giroCache.get(key);

  if (!entry) return null;

  const ageMs = Date.now() - entry.cachedAt;

  if (ageMs > CACHE_TTL_MS) {
    giroCache.delete(key);
    return null;
  }

  return {
    ...entry.data,
    cached: true,
    cacheAgeSeconds: Math.floor(ageMs / 1000),
  };
}

function saveCachedData(station, data) {
  const key = getCacheKey(station);

  giroCache.set(key, {
    data,
    cachedAt: Date.now(),
  });
}

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

function findStationById(id) {
  if (!id) return null;
  const normalizedId = String(id).trim().toUpperCase();
  return stations.find((station) => station.ursi.toUpperCase() === normalizedId) ?? null;
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

  const parts = lastDataLine.split(/\s+/);

  const timestamp = parts[0];
  const cs = parseInt(parts[1], 10);

  const tokens = parts.slice(2);

  const foF2 = parseGiroNumber(tokens[0]);
  const foEs = parseGiroNumber(tokens[2]);
  const mufd = parseGiroNumber(tokens[4]);
  const md = parseGiroNumber(tokens[6]);
  const hF2 = parseGiroNumber(tokens[8]);

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
    confidence: Number.isFinite(cs) ? cs : null,
    ageMinutes,
    freshness,
  };
}

exports.getHFData = async (req, res) => {
  logger.info('➡️ Received GET request /api/ionosphere/hf');

  try {
    const { lat, lon, station } = req.query;
    const stationId = Array.isArray(station) ? station[0] : station;

    let selectedStation = null;

    if (stationId) {
      selectedStation = findStationById(stationId);

      if (!selectedStation) {
        logger.warn('Unknown station requested', { stationId });
        return res.status(400).json({ error: `Unknown station id: ${stationId}` });
      }
    }

    let nearestStation = null;

    if (selectedStation) {
      nearestStation = { ...selectedStation, distance: null };
      logger.info('Using selected station from request', { station: selectedStation.name });
    } else {
      if (lat === undefined || lon === undefined) {
        logger.warn('Missing lat or lon parameters');
        return res.status(400).json({ error: 'station or lat and lon parameters are required' });
      }

      const userLat = parseFloat(Array.isArray(lat) ? lat[0] : lat);
      const userLon = parseFloat(Array.isArray(lon) ? lon[0] : lon);

      if (Number.isNaN(userLat) || Number.isNaN(userLon)) {
        logger.warn('Invalid lat or lon values');
        return res.status(400).json({ error: 'lat and lon must be valid numbers' });
      }

      nearestStation = findNearestStation(userLat, userLon);

      if (!nearestStation) {
        logger.warn('No GIRO station found');
        return res.status(500).json({ error: 'No GIRO station available' });
      }

      logger.info('Nearest station found', {
        station: nearestStation.name,
        distance: nearestStation.distance.toFixed(2),
      });
    }

    const cachedResponse = getCachedData(nearestStation);

    if (cachedResponse) {
      logger.info('Serving GIRO data from cache', {
        station: nearestStation.name,
        cacheAgeSeconds: cachedResponse.cacheAgeSeconds,
      });

      return res.json(cachedResponse);
    }

    const now = new Date();
    const toDate = new Date(now);
    const fromDate = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    const fromDateStr = formatGiroDate(fromDate);
    const toDateStr = formatGiroDate(toDate);

    const params = {
      ursiCode: nearestStation.ursi,
      charName: 'foF2,foEs,MUFD,MD,hF2',
      DMUF: 3000,
      fromDate: fromDateStr,
      toDate: toDateStr,
    };

    const queryString = new URLSearchParams(params).toString();

    logger.info('GIRO request URL', {
      url: `${GIRO_BASE_URL}?${queryString}`,
    });

    const giroResponse = await axios.get(GIRO_BASE_URL, {
      params,
      timeout: 10000,
    });

    logger.info('GIRO response received', {
      status: giroResponse.status,
      dataLength: giroResponse.data.length,
    });

    const parsedData = parseGiroResponse(giroResponse.data);

    const response = {
      cached: false,
      station: {
        ursiCode: nearestStation.ursi,
        name: nearestStation.name,
        distanceKm: nearestStation.distance != null ? Number(nearestStation.distance.toFixed(2)) : null,
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

    saveCachedData(nearestStation, response);

    logger.info('Response sent for /api/ionosphere/hf', {
      station: nearestStation.name,
      foF2: parsedData.foF2,
      muf: parsedData.mufd,
      mufFactor: parsedData.mufFactor,
      cached: false,
    });

    return res.json(response);
  } catch (error) {
    if (error.response) {
      logger.error('GIRO API error', {
        status: error.response.status,
        statusText: error.response.statusText,
        requestUrl: error.config?.url,
        requestParams: error.config?.params,
        data: error.response.data,
      });

      return res.status(500).json({ error: 'Failed to fetch data from GIRO service' });
    }

    logger.error('Error in /api/ionosphere/hf', { error: error.message });
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};

exports.getStations = (req, res) => {
  const stationList = stations.map(({ ursi, name }) => ({ ursi, name }));
  return res.json(stationList);
};