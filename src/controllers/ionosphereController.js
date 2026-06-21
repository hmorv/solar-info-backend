// Controlador para datos ionosféricos de GIRO
const axios = require('axios');
const logger = require('../config/logger');
const stations = require('../config/stations');

const GIRO_BASE_URL = 'https://lgdc.uml.edu/fastchar/getbest';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos
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

  // Calcular la antigüedad actual: antigüedad que se guardó + tiempo transcurrido desde el cacheo
  const nowMs = Date.now();
  const elapsedMs = nowMs - entry.cachedAt;
  const elapsedMinutes = Math.floor(elapsedMs / (1000 * 60));

  // Determinar la antigüedad almacenada cuando se guardó (fallback a 0 si no está disponible)
  let storedAge = null;
  if (entry.data && typeof entry.data.ageMinutes === 'number') {
    storedAge = entry.data.ageMinutes;
  } else if (entry.data && entry.data.measuredAt) {
    const measuredAtMs = new Date(entry.data.measuredAt).getTime();
    if (!Number.isNaN(measuredAtMs)) {
      storedAge = Math.floor((entry.cachedAt - measuredAtMs) / (1000 * 60));
    }
  }
  if (storedAge === null) storedAge = 0;

  const updatedAgeMinutes = storedAge + elapsedMinutes;

  // Recalcular freshness con la antigüedad actualizada
  const freshness = computeFreshness(updatedAgeMinutes);

  logger.debug('getCachedData calculation', {
    storedAge,
    elapsedMinutes,
    updatedAgeMinutes,
    freshness,
    elapsedMs,
    measuredAt: entry.data.measuredAt,
  });

  // Actualizar la entrada en caché para que el frontal reciba ageMinutes actualizado
  entry.data.ageMinutes = updatedAgeMinutes;
  entry.data.freshness = freshness;

  // Actualizamos cachedAt para que no se vuelva a sumar el mismo intervalo en siguientes lecturas
  entry.cachedAt = nowMs;

  return {
    ...entry.data,
    cached: true,
    // cacheAgeSeconds refleja cuánto tiempo había pasado desde el cacheo original hasta ahora
    cacheAgeSeconds: Math.floor(elapsedMs / 1000),
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

function computeFreshness(ageMinutes) {
  let freshness = 'old';
  if (ageMinutes < 60) freshness = 'fresh';
  else if (ageMinutes < 180) freshness = 'ok';
  return freshness;
}

function parseGiroNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function parseGiroResponse(data) {
  // split on any common newline sequence and search for the last line
  const lines = data.split(/\r?\n/);

  let lastDataLine = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw) continue;
    const line = raw.trim();

    // Be tolerante: puede haber prefijos o espacios, buscamos la primera ocurrencia de timestamp
    const match = line.match(/\d{4}-\d{2}-\d{2}T/);
    if (match) {
      // Extraemos desde la posición donde aparece el timestamp
      lastDataLine = line.slice(match.index);
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

  const freshness = computeFreshness(ageMinutes);

  logger.debug('parseGiroResponse calculated ageMinutes', {
    timestamp,
    measurementDate: measurementDate.toISOString(),
    ageMinutes,
    freshness,
  });

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

      // Si nos pasan coordenadas junto con el id de estación, calcular la distancia
      if (lat !== undefined && lon !== undefined) {
        const userLat = parseFloat(Array.isArray(lat) ? lat[0] : lat);
        const userLon = parseFloat(Array.isArray(lon) ? lon[0] : lon);

        if (!Number.isNaN(userLat) && !Number.isNaN(userLon)) {
          nearestStation.distance = calculateDistance(userLat, userLon, selectedStation.lat, selectedStation.lon);
          logger.info('Computed distance for selected station from provided coords', {
            station: selectedStation.name,
            distance: nearestStation.distance.toFixed(2),
          });
        }
      }

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
        ageMinutes: cachedResponse.ageMinutes,
        freshness: cachedResponse.freshness,
        measuredAt: cachedResponse.measuredAt,
      });

      // No mutamos la caché aquí; construimos una copia y sobrescribimos distanceKm
      const responseToSend = {
        ...cachedResponse,
        station: {
          ...cachedResponse.station,
          distanceKm:
            nearestStation && nearestStation.distance != null
              ? Number(nearestStation.distance.toFixed(2))
              : cachedResponse.station.distanceKm,
        },
      };

      return res.json(responseToSend);
    }

    const now = new Date();
    const toDate = new Date(now);
    const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);  // Extender búsqueda a 24 horas para obtener datos más recientes

    const fromDateStr = formatGiroDate(fromDate);
    const toDateStr = formatGiroDate(toDate);

    const params = {
      ursiCode: nearestStation.ursi,
      charName: 'foF2,foEs,MUF(D),M(D),h`F2',
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

    let parsedData;
    try {
      parsedData = parseGiroResponse(giroResponse.data);
    } catch (err) {
      // Log a snippet of the GIRO response to help debugging when parsing fails
      const snippet = typeof giroResponse.data === 'string' ? giroResponse.data.slice(0, 2000) : String(giroResponse.data);
      logger.error('Failed to parse GIRO response', { error: err.message, snippet });
      throw err;
    }

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