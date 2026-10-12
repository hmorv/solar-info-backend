// Controlador para datos ionosféricos de GIRO
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const stations = require('../config/stations');
const diasService = require('../services/diasService');

const GIRO_BASE_URL = 'https://lgdc.uml.edu/fastchar/getbest';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

/*
 * Durante cuánto tiempo permitimos utilizar el último dato conocido
 * si GIRO está temporalmente indisponible.
 *
 * Por defecto: 6 horas.
 *
 * Puede sobrescribirse en .env con:
 *
 * GIRO_STALE_CACHE_MAX_MINUTES=360
 */
const STALE_CACHE_MAX_MS =
  (Number(process.env.GIRO_STALE_CACHE_MAX_MINUTES) || 360) *
  60 *
  1000;

/*
 * La caché se mantiene en memoria para las consultas habituales y se
 * persiste además en disco para sobrevivir a reinicios del proceso Node.
 *
 * Por defecto se guarda en:
 *
 * <raíz-del-proyecto>/data/giro-cache.json
 *
 * Puede cambiarse mediante:
 *
 * GIRO_CACHE_FILE=/ruta/al/fichero.json
 */
const CACHE_FILE_PATH =
  process.env.GIRO_CACHE_FILE ||
  path.join(__dirname, '../../data/giro-cache.json');
const DIAS_CACHE_FILE_PATH =
  process.env.DIAS_CACHE_FILE ||
  path.join(__dirname, '../../data/dias-cache.json');

const giroCache = new Map();
const diasCache = new Map();
const providerRequestsInFlight = new Map();

function getPositiveEnvironmentNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const AUTO_MAX_DISTANCE_KM = getPositiveEnvironmentNumber(
  'IONOSPHERE_AUTO_MAX_DISTANCE_KM',
  500
);
const MAX_OBSERVATION_AGE_MINUTES = getPositiveEnvironmentNumber(
  'IONOSPHERE_MAX_OBSERVATION_AGE_MINUTES',
  30
);
const AUTO_MAX_ATTEMPTS = Math.max(
  1,
  Math.floor(getPositiveEnvironmentNumber('IONOSPHERE_AUTO_MAX_ATTEMPTS', 3))
);

function getProviderCache(provider) {
  return provider === 'dias'
    ? diasCache
    : giroCache;
}

function getProviderCacheFile(provider) {
  return provider === 'dias'
    ? DIAS_CACHE_FILE_PATH
    : CACHE_FILE_PATH;
}

function getConfiguredProvider() {
  const mode =
    (process.env.IONOSPHERE_PROVIDER || 'hybrid')
      .trim()
      .toLowerCase();
  const preferredProvider =
    (process.env.IONOSPHERE_PREFERRED_PROVIDER || 'dias')
      .trim()
      .toLowerCase();

  if (
    ['dias', 'giro', 'hybrid'].includes(mode) &&
    (mode !== 'hybrid' || ['dias', 'giro'].includes(preferredProvider))
  ) {
    return { mode, preferredProvider };
  }

  logger.error(
    'Invalid ionosphere provider configuration',
    {
      configuredProvider: mode,
      configuredPreferredProvider: preferredProvider,
      allowedProviders: ['dias', 'giro', 'hybrid'],
      allowedPreferredProviders: ['dias', 'giro'],
    }
  );

  return null;
}

function getProviderPlan({ mode, preferredProvider }, station) {
  if (mode !== 'hybrid') {
    return [mode];
  }

  const supportsDias = diasService.SUPPORTED_STATIONS.has(
    station.ursi.toUpperCase()
  );

  if (!supportsDias) {
    return ['giro'];
  }

  const secondaryProvider = preferredProvider === 'dias' ? 'giro' : 'dias';
  return [preferredProvider, secondaryProvider];
}

function getCacheKey(station) {
  return station.ursi.toUpperCase();
}

function fetchProviderMeasurement(provider, station) {
  const requestKey = `${provider}:${getCacheKey(station)}`;
  const inFlightRequest = providerRequestsInFlight.get(requestKey);

  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = provider === 'dias'
    ? diasService.fetchLatest(station.ursi)
    : fetchGiroMeasurement(station);

  providerRequestsInFlight.set(requestKey, request);
  return request.finally(() => {
    providerRequestsInFlight.delete(requestKey);
  });
}

function getDiasCandidates(lat, lon) {
  return stations
    .filter((station) => diasService.SUPPORTED_STATIONS.has(station.ursi.toUpperCase()))
    .map((station) => ({
      ...station,
      distance: calculateDistance(lat, lon, station.lat, station.lon),
    }))
    .sort((left, right) => left.distance - right.distance);
}

function isObservationWithinAge(data, maxAgeMinutes) {
  const measuredAtMs = new Date(data?.measuredAt || data?.timestamp).getTime();
  return Number.isFinite(measuredAtMs) &&
    measuredAtMs <= Date.now() &&
    Date.now() - measuredAtMs <= maxAgeMinutes * 60 * 1000;
}

function persistCacheToDisk(provider = 'giro') {
  try {
    const cacheFilePath = getProviderCacheFile(provider);
    const cache = getProviderCache(provider);
    const directory = path.dirname(cacheFilePath);

    fs.mkdirSync(directory, {
      recursive: true,
    });

    const stationsCache = {};

    for (const [key, entry] of cache.entries()) {
      stationsCache[key] = {
        cachedAt: new Date(entry.cachedAt).toISOString(),
        data: entry.data,
      };
    }

    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      stations: stationsCache,
    };

    /*
     * Escribimos primero a un temporal y después lo renombramos.
     *
     * Así reducimos el riesgo de dejar giro-cache.json incompleto
     * si el proceso se interrumpe durante la escritura.
     */
    const tempFile = `${cacheFilePath}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(payload, null, 2),
      'utf8'
    );

    fs.renameSync(
      tempFile,
      cacheFilePath
    );

    logger.debug(
      'Ionosphere persistent cache saved',
      {
        provider,
        file: cacheFilePath,
        stations:
          Object.keys(stationsCache).length,
      }
    );
  } catch (error) {
    /*
     * Un problema escribiendo la caché persistente no debe impedir
     * que el endpoint siga funcionando.
     */
    logger.error(
      'Failed to persist ionosphere cache',
      {
        provider,
        file: getProviderCacheFile(provider),
        error: error.message,
      }
    );
  }
}

function loadPersistentCache(provider = 'giro') {
  try {
    const cacheFilePath = getProviderCacheFile(provider);
    const cache = getProviderCache(provider);

    if (!fs.existsSync(cacheFilePath)) {
      logger.info(
        'No persistent ionosphere cache found',
        {
          provider,
          file: cacheFilePath,
        }
      );

      return;
    }

    const raw =
      fs.readFileSync(
        cacheFilePath,
        'utf8'
      );

    const parsed =
      JSON.parse(raw);

    const persistedStations =
      parsed?.stations;

    if (
      !persistedStations ||
      typeof persistedStations !== 'object'
    ) {
      throw new Error(
        'Invalid persistent GIRO cache format'
      );
    }

    const nowMs =
      Date.now();

    let loaded = 0;
    let discarded = 0;

    for (
      const [key, entry]
      of Object.entries(persistedStations)
    ) {
      const cachedAtMs =
        new Date(
          entry?.cachedAt
        ).getTime();

      if (
        !entry?.data ||
        Number.isNaN(cachedAtMs) ||
        nowMs - cachedAtMs >
          STALE_CACHE_MAX_MS
      ) {
        discarded++;

        continue;
      }

      cache.set(
        key.toUpperCase(),
        {
          data: {
            ...entry.data,
            source: entry.data.source || provider,
          },
          cachedAt: cachedAtMs,
        }
      );

      loaded++;
    }

    logger.info(
      'Persistent ionosphere cache loaded',
      {
        provider,
        file: cacheFilePath,
        loaded,
        discarded,
      }
    );

    /*
     * Si había entradas demasiado antiguas, reescribimos el fichero
     * sin ellas.
     */
    if (discarded > 0) {
      persistCacheToDisk(provider);
    }
  } catch (error) {
    /*
     * Una caché corrupta tampoco debe impedir arrancar DXSun.
     */
    logger.error(
      'Failed to load persistent ionosphere cache',
      {
        provider,
        file: getProviderCacheFile(provider),
        error: error.message,
      }
    );
  }
}

function getCachedData(
  station,
  {
    allowStale = false,
  } = {},
  provider = 'giro'
) {
  const key =
    getCacheKey(station);

  const entry =
    getProviderCache(provider).get(key);

  if (!entry) {
    return null;
  }

  const nowMs =
    Date.now();

  const cacheAgeMs =
    nowMs - entry.cachedAt;

  /*
   * A partir del máximo configurado eliminamos definitivamente
   * el dato. Hasta entonces puede mantenerse como fallback.
   */
  if (
    cacheAgeMs >
    STALE_CACHE_MAX_MS
  ) {
    getProviderCache(provider).delete(key);

    persistCacheToDisk(provider);

    return null;
  }

  /*
   * Después de 15 minutos deja de ser caché normal.
   *
   * No la eliminamos porque todavía puede servir si GIRO falla.
   */
  const staleCache =
    cacheAgeMs >
    CACHE_TTL_MS;

  if (
    staleCache &&
    !allowStale
  ) {
    return null;
  }

  /*
   * La antigüedad real de la medición se calcula desde measuredAt,
   * no desde cachedAt.
   */
  const measuredAtMs =
    entry.data?.measuredAt
      ? new Date(
          entry.data.measuredAt
        ).getTime()
      : NaN;

  let ageMinutes =
    entry.data?.ageMinutes ??
    0;

  if (
    !Number.isNaN(
      measuredAtMs
    )
  ) {
    ageMinutes =
      Math.max(
        0,
        Math.floor(
          (
            nowMs -
            measuredAtMs
          ) /
            (
              1000 *
              60
            )
        )
      );
  }

  const freshness =
    computeFreshness(
      ageMinutes
    );

  logger.debug(
    'getCachedData calculation',
    {
      cacheAgeSeconds:
        Math.floor(
          cacheAgeMs /
          1000
        ),

      ageMinutes,

      freshness,

      measuredAt:
        entry.data?.measuredAt,

      staleCache,
    }
  );

  /*
   * No modificamos directamente entry.data.
   */
  return {
    ...entry.data,

    ageMinutes,

    freshness,

    cached: true,

    staleCache,

    cacheAgeSeconds:
      Math.floor(
        cacheAgeMs /
        1000
      ),
  };
}

function saveCachedData(
  station,
  data,
  provider = 'giro'
) {
  const key =
    getCacheKey(station);

  getProviderCache(provider).set(
    key,
    {
      data: {
        ...data,
        source: data.source || provider,
      },

      cachedAt:
        Date.now(),
    }
  );

  /*
   * Cada respuesta válida de GIRO actualiza también la copia
   * persistente.
   */
  persistCacheToDisk(provider);
}

function buildCachedResponse(
  cachedResponse,
  nearestStation,
  extra = {}
) {
  return {
    ...cachedResponse,

    ...extra,

    station: {
      ...cachedResponse.station,

      distanceKm:
        nearestStation.distance != null
          ? Number(
              nearestStation.distance.toFixed(
                2
              )
            )
          : cachedResponse.station
              .distanceKm,
    },
  };
}

function buildProviderResponse(
  nearestStation,
  parsedData,
  provider,
  selectionMode
) {
  return {
    cached: false,
    source: provider,
    selectionMode,
    station: {
      ursiCode: nearestStation.ursi,
      name: nearestStation.name,
      distanceKm:
        nearestStation.distance != null
          ? Number(nearestStation.distance.toFixed(2))
          : null,
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
}

/*
 * Restauramos el último dato válido cuando se carga el controlador.
 */
loadPersistentCache('giro');
loadPersistentCache('dias');

function calculateDistance(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371;

  const dLat =
    (
      (lat2 - lat1) *
      Math.PI
    ) /
    180;

  const longitudeDifference =
    ((lon2 - lon1 + 540) % 360) - 180;
  const dLon =
    (longitudeDifference * Math.PI) /
    180;

  const a =
    Math.sin(
      dLat / 2
    ) *
      Math.sin(
        dLat / 2
      ) +
    Math.cos(
      (
        lat1 *
        Math.PI
      ) /
        180
    ) *
      Math.cos(
        (
          lat2 *
          Math.PI
        ) /
          180
      ) *
      Math.sin(
        dLon / 2
      ) *
      Math.sin(
        dLon / 2
      );

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(
        1 - a
      )
    );

  return R * c;
}

function isValidCoordinates(
  lat,
  lon
) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function findNearestStation(
  lat,
  lon
) {
  let nearest = null;
  let minDistance = Infinity;

  stations.forEach(
    (station) => {
      const distance =
        calculateDistance(
          lat,
          lon,
          station.lat,
          station.lon
        );

      if (
        distance <
        minDistance
      ) {
        minDistance =
          distance;

        nearest = {
          ...station,
          distance:
            minDistance,
        };
      }
    }
  );

  return nearest;
}

function findStationById(id) {
  if (!id) {
    return null;
  }

  const normalizedId =
    String(id)
      .trim()
      .toUpperCase();

  return (
    stations.find(
      (station) =>
        station.ursi.toUpperCase() ===
        normalizedId
    ) ??
    null
  );
}

function formatGiroDate(date) {
  return `${date.getUTCFullYear()}/${String(
    date.getUTCMonth() + 1
  ).padStart(
    2,
    '0'
  )}/${String(
    date.getUTCDate()
  ).padStart(
    2,
    '0'
  )} ${String(
    date.getUTCHours()
  ).padStart(
    2,
    '0'
  )}:${String(
    date.getUTCMinutes()
  ).padStart(
    2,
    '0'
  )}:${String(
    date.getUTCSeconds()
  ).padStart(
    2,
    '0'
  )}`;
}

function computeFreshness(
  ageMinutes
) {
  if (
    ageMinutes <
    60
  ) {
    return 'fresh';
  }

  if (
    ageMinutes <
    180
  ) {
    return 'ok';
  }

  return 'old';
}

function parseGiroNumber(
  value
) {
  const n =
    parseFloat(value);

  return Number.isFinite(n)
    ? Number(
        n.toFixed(2)
      )
    : null;
}

function isValidFoF2(
  value
) {
  return (
    value !== null &&
    value > 0 &&
    value <= 30
  );
}

function sanitizeFoEs(
  value
) {
  if (
    value === null ||
    value <= 0 ||
    value > 30
  ) {
    return null;
  }

  return value;
}

function sanitizeMuf(
  value
) {
  if (
    value === null ||
    value <= 0 ||
    value > 100
  ) {
    return null;
  }

  return value;
}

function sanitizeMufFactor(
  value
) {
  if (
    value === null ||
    value <= 0 ||
    value > 10
  ) {
    return null;
  }

  return value;
}

function sanitizeHF2(
  value
) {
  if (
    value === null ||
    value < 100 ||
    value > 1000
  ) {
    return null;
  }

  return value;
}

function parseGiroResponse(
  data
) {
  if (
    typeof data !==
      'string' ||
    !data.trim()
  ) {
    throw new Error(
      'Empty GIRO response'
    );
  }

  const lines =
    data.split(
      /\r?\n/
    );

  /*
   * Recorremos la respuesta desde el final.
   *
   * GIRO puede devolver filas incompletas o respuestas en las que
   * la última línea que contiene una fecha no es realmente una
   * medición válida.
   *
   * En lugar de seleccionar simplemente la última línea con timestamp,
   * buscamos la última fila que tenga una estructura válida y un foF2
   * razonable.
   */
  for (
    let i =
      lines.length - 1;
    i >= 0;
    i--
  ) {
    const raw =
      lines[i];

    if (!raw) {
      continue;
    }

    const line =
      raw.trim();

    if (!line) {
      continue;
    }

    /*
     * Buscamos un timestamp ISO dentro de la línea.
     *
     * Ejemplo:
     * 2026-09-05T17:05:01.000Z
     */
    const timestampMatch =
      line.match(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/
      );

    if (
      !timestampMatch
    ) {
      continue;
    }

    /*
     * Puede existir algún prefijo antes del timestamp.
     */
    const dataLine =
      line.slice(
        timestampMatch.index
      );

    const parts =
      dataLine.split(
        /\s+/
      );

    /*
     * Estructura esperada:
     *
     * timestamp
     * confidence/status
     *
     * foF2 value + qualifier
     * foEs value + qualifier
     * MUF(D) value + qualifier
     * M(D) value + qualifier
     * h`F2 value + qualifier
     */
    if (
      parts.length <
      12
    ) {
      logger.debug(
        'Skipping incomplete GIRO data row',
        {
          fieldCount:
            parts.length,

          line:
            dataLine,
        }
      );

      continue;
    }

    const timestamp =
      parts[0];

    const measurementDate =
      new Date(
        timestamp
      );

    if (
      Number.isNaN(
        measurementDate.getTime()
      )
    ) {
      logger.debug(
        'Skipping GIRO row with invalid timestamp',
        {
          timestamp,

          line:
            dataLine,
        }
      );

      continue;
    }

    const cs =
      parseInt(
        parts[1],
        10
      );

    const tokens =
      parts.slice(2);

    const rawFoF2 =
      parseGiroNumber(
        tokens[0]
      );

    const rawFoEs =
      parseGiroNumber(
        tokens[2]
      );

    const rawMufd =
      parseGiroNumber(
        tokens[4]
      );

    const rawMd =
      parseGiroNumber(
        tokens[6]
      );

    const rawHF2 =
      parseGiroNumber(
        tokens[8]
      );

    /*
     * foF2 es el parámetro fundamental para considerar una fila válida.
     */
    if (
      !isValidFoF2(
        rawFoF2
      )
    ) {
      logger.warn(
        'Skipping GIRO row with invalid foF2',
        {
          foF2:
            rawFoF2,

          timestamp,

          line:
            dataLine,
        }
      );

      continue;
    }

    const foF2 =
      rawFoF2;

    const foEs =
      sanitizeFoEs(
        rawFoEs
      );

    const mufd =
      sanitizeMuf(
        rawMufd
      );

    const md =
      sanitizeMufFactor(
        rawMd
      );

    const hF2 =
      sanitizeHF2(
        rawHF2
      );

    const ageMinutes =
      Math.floor(
        (
          Date.now() -
          measurementDate.getTime()
        ) /
          (
            1000 *
            60
          )
      );

    /*
     * Evitamos aceptar mediciones claramente fechadas en el futuro.
     */
    if (
      ageMinutes <
      -5
    ) {
      logger.warn(
        'Skipping GIRO row with future timestamp',
        {
          timestamp,

          ageMinutes,

          line:
            dataLine,
        }
      );

      continue;
    }

    const normalizedAgeMinutes =
      Math.max(
        0,
        ageMinutes
      );

    const freshness =
      computeFreshness(
        normalizedAgeMinutes
      );

    logger.debug(
      'Valid GIRO data row found',
      {
        timestamp,

        foF2,

        foEs,

        mufd,

        mufFactor:
          md,

        hF2,

        ageMinutes:
          normalizedAgeMinutes,

        freshness,
      }
    );

    return {
      timestamp:
        measurementDate.toISOString(),

      foF2,

      mufd,

      mufFactor:
        md,

      hF2,

      foEs,

      confidence:
        Number.isFinite(
          cs
        )
          ? cs
          : null,

      ageMinutes:
        normalizedAgeMinutes,

      freshness,
    };
  }

  throw new Error(
    'No valid ionospheric measurement found in GIRO response'
  );
}

async function fetchGiroMeasurement(station) {
  const startedAt = Date.now();
  const now = new Date();
  const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const params = {
    ursiCode: station.ursi,
    charName: 'foF2,foEs,MUF(D),M(D),h`F2',
    DMUF: 3000,
    fromDate: formatGiroDate(fromDate),
    toDate: formatGiroDate(now),
  };

  logger.info('GIRO request URL', {
    provider: 'giro',
    station: station.ursi,
    url: `${GIRO_BASE_URL}?${new URLSearchParams(params).toString()}`,
  });

  const response = await axios.get(GIRO_BASE_URL, {
    params,
    timeout: 10000,
  });

  if (response.status !== 200) {
    const error = new Error(`GIRO returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  logger.info('GIRO response received', {
    provider: 'giro',
    station: station.ursi,
    status: response.status,
    dataLength: typeof response.data === 'string' ? response.data.length : null,
  });

  try {
    const measurement = parseGiroResponse(response.data);
    logger.info('GIRO measurement received', {
      provider: 'giro',
      station: station.ursi,
      responseTimeMs: Date.now() - startedAt,
      measuredAt: measurement.timestamp,
      ageMinutes: measurement.ageMinutes,
      foF2: measurement.foF2,
      muf: measurement.mufd,
      mufFactor: measurement.mufFactor,
    });
    return measurement;
  } catch (error) {
    logger.error('Failed to parse GIRO response', {
      provider: 'giro',
      station: station.ursi,
      error: error.message,
      snippet: typeof response.data === 'string'
        ? response.data.slice(0, 2000)
        : String(response.data),
    });
    throw error;
  }
}

async function findRecentDiasStation(lat, lon) {
  const candidates = getDiasCandidates(lat, lon);
  const candidatesInRange = candidates.filter(
    (candidate) => candidate.distance <= AUTO_MAX_DISTANCE_KM
  );

  for (const candidate of candidates) {
    logger.info('Evaluated automatic DIAS station candidate', {
      selectionMode: 'auto',
      provider: 'dias',
      station: candidate.ursi,
      distanceKm: Number(candidate.distance.toFixed(2)),
      withinMaxDistance: candidate.distance <= AUTO_MAX_DISTANCE_KM,
      maxDistanceKm: AUTO_MAX_DISTANCE_KM,
    });
  }

  for (const candidate of candidatesInRange.slice(0, AUTO_MAX_ATTEMPTS)) {
    const cachedData = getCachedData(candidate, {}, 'dias');
    if (cachedData) {
      if (isObservationWithinAge(cachedData, MAX_OBSERVATION_AGE_MINUTES)) {
        logger.info('Selected automatic DIAS station from cache', {
          selectionMode: 'auto',
          provider: 'dias',
          station: candidate.ursi,
          distanceKm: Number(candidate.distance.toFixed(2)),
          ageMinutes: cachedData.ageMinutes,
        });
        return { station: candidate, data: cachedData, cached: true };
      }

      logger.warn('Discarded cached DIAS candidate with old observation', {
        selectionMode: 'auto',
        provider: 'dias',
        station: candidate.ursi,
        distanceKm: Number(candidate.distance.toFixed(2)),
        ageMinutes: cachedData.ageMinutes,
        maxAgeMinutes: MAX_OBSERVATION_AGE_MINUTES,
      });
    }

    try {
      const data = await fetchProviderMeasurement('dias', candidate);
      if (!isObservationWithinAge(data, MAX_OBSERVATION_AGE_MINUTES)) {
        const error = new diasService.DiasError(
          'DIAS observation exceeds automatic selection age limit',
          { code: 'DIAS_AUTO_OBSERVATION_TOO_OLD' }
        );
        error.ageMinutes = data.ageMinutes;
        throw error;
      }

      logger.info('Selected automatic DIAS station', {
        selectionMode: 'auto',
        provider: 'dias',
        station: candidate.ursi,
        distanceKm: Number(candidate.distance.toFixed(2)),
        ageMinutes: data.ageMinutes,
      });
      return { station: candidate, data, cached: false };
    } catch (error) {
      logger.warn('Skipped automatic DIAS station candidate', {
        selectionMode: 'auto',
        provider: 'dias',
        station: candidate.ursi,
        distanceKm: Number(candidate.distance.toFixed(2)),
        ageMinutes: error.ageMinutes ?? null,
        code: error.code ?? null,
        reason: error.message,
      });
    }
  }

  if (candidatesInRange.length > AUTO_MAX_ATTEMPTS) {
    logger.warn('Automatic DIAS candidate attempt limit reached', {
      selectionMode: 'auto',
      maxAttempts: AUTO_MAX_ATTEMPTS,
      candidatesInRange: candidatesInRange.length,
    });
  }

  return {
    candidatesInRange: candidatesInRange.length,
    attempts: Math.min(candidatesInRange.length, AUTO_MAX_ATTEMPTS),
  };
}

exports.getHFData =
  async (
    req,
    res
  ) => {
    const providerConfig = getConfiguredProvider();

    if (!providerConfig) {
      return res.status(500).json({
        error: 'Invalid IONOSPHERE_PROVIDER or IONOSPHERE_PREFERRED_PROVIDER configuration',
      });
    }

    logger.info(
      'Received GET request /api/ionosphere/hf',
      {
        provider: providerConfig.mode,
        preferredProvider: providerConfig.preferredProvider,
      }
    );

    /*
     * Debe estar fuera del try para que el catch pueda buscar
     * el último dato válido si GIRO falla.
     */
    let nearestStation =
      null;
    let providerPlan = [];
    let selectionMode = 'manual';
    let userCoordinates = null;
    const providerErrors = [];

    try {
      const {
        lat,
        lon,
        station,
      } = req.query;
      const hasManualStation = Boolean(station);
      selectionMode = hasManualStation ? 'manual' : 'auto';

      const stationId =
        Array.isArray(
          station
        )
          ? station[0]
          : station;

      let selectedStation =
        null;

      if (
        stationId
      ) {
        selectedStation =
          findStationById(
            stationId
          );

        if (
          !selectedStation
        ) {
          logger.warn(
            'Unknown station requested',
            {
              stationId,
            }
          );

          return res
            .status(400)
            .json({
              error:
                `Unknown station id: ${stationId}`,
            });
        }
      }

      if (
        selectedStation
      ) {
        nearestStation = {
          ...selectedStation,

          distance:
            null,
        };

        if (
          lat !== undefined &&
          lon !== undefined
        ) {
          const userLat =
            parseFloat(
              Array.isArray(
                lat
              )
                ? lat[0]
                : lat
            );

          const userLon =
            parseFloat(
              Array.isArray(
                lon
              )
                ? lon[0]
                : lon
            );

          if (
            isValidCoordinates(
              userLat,
              userLon
            )
          ) {
            nearestStation.distance =
              calculateDistance(
                userLat,
                userLon,
                selectedStation.lat,
                selectedStation.lon
              );

            logger.info(
              'Computed distance for selected station from provided coords',
              {
                station:
                  selectedStation.name,

                distance:
                  nearestStation.distance.toFixed(
                    2
                  ),
              }
            );
          } else {
            logger.warn(
              'Ignoring invalid coordinates supplied with selected station',
              {
                lat,
                lon,
              }
            );
          }
        }

        logger.info(
          'Using selected station from request',
          {
            station:
              selectedStation.name,
          }
        );
      } else {
        if (
          lat === undefined ||
          lon === undefined
        ) {
          logger.warn(
            'Missing lat or lon parameters'
          );

          return res
            .status(400)
            .json({
              error:
                'station or lat and lon parameters are required',
            });
        }

        const userLat =
          parseFloat(
            Array.isArray(
              lat
            )
              ? lat[0]
              : lat
          );

        const userLon =
          parseFloat(
            Array.isArray(
              lon
            )
              ? lon[0]
              : lon
          );

        userCoordinates = {
          lat: userLat,
          lon: userLon,
        };

        if (
          !isValidCoordinates(
            userLat,
            userLon
          )
        ) {
          logger.warn(
            'Invalid lat or lon values',
            {
              lat,
              lon,
            }
          );

          return res
            .status(400)
            .json({
              error:
                'lat must be between -90 and 90 and lon between -180 and 180',
            });
        }

        nearestStation =
          findNearestStation(
            userLat,
            userLon
          );

        if (
          !nearestStation
        ) {
          logger.warn(
            'No GIRO station found'
          );

          return res
            .status(500)
            .json({
              error:
                'No GIRO station available',
            });
        }

        logger.info(
          'Nearest station found',
          {
            station:
              nearestStation.name,

            distance:
              nearestStation.distance.toFixed(
                2
              ),
          }
        );
      }

      if (
        !hasManualStation &&
        ['hybrid', 'dias'].includes(providerConfig.mode)
      ) {
        const diasSelection = await findRecentDiasStation(
          userCoordinates.lat,
          userCoordinates.lon
        );

        if (diasSelection.station) {
          nearestStation = diasSelection.station;

          if (diasSelection.cached) {
            return res.json(buildCachedResponse(
              diasSelection.data,
              nearestStation,
              { selectionMode }
            ));
          }

          const response = buildProviderResponse(
            nearestStation,
            diasSelection.data,
            'dias',
            selectionMode
          );
          saveCachedData(nearestStation, response, 'dias');
          return res.json(response);
        }

        if (providerConfig.mode === 'dias') {
          return res.status(503).json({
            error: 'No recent DIAS observation found within the configured radius',
            provider: 'dias',
            selectionMode,
            maxDistanceKm: AUTO_MAX_DISTANCE_KM,
            maxObservationAgeMinutes: MAX_OBSERVATION_AGE_MINUTES,
            candidatesInRange: diasSelection.candidatesInRange,
            attempts: diasSelection.attempts,
          });
        }

        logger.warn('No recent DIAS station found; using nearest GIRO station', {
          selectionMode,
          fallbackProvider: 'giro',
          station: nearestStation.ursi,
          distanceKm: Number(nearestStation.distance.toFixed(2)),
          candidatesInRange: diasSelection.candidatesInRange,
          attempts: diasSelection.attempts,
        });
        providerPlan = ['giro'];
      }

      if (providerPlan.length === 0) {
        providerPlan = getProviderPlan(providerConfig, nearestStation);
      }
      logger.info('Ionosphere provider plan selected', {
        mode: providerConfig.mode,
        preferredProvider: providerConfig.preferredProvider,
        providers: providerPlan,
        station: nearestStation.name,
        ursiCode: nearestStation.ursi,
        selectionMode,
      });

      if (
        providerConfig.mode === 'dias' &&
        !diasService.SUPPORTED_STATIONS.has(nearestStation.ursi.toUpperCase())
      ) {
        logger.warn('Requested station is not supported by DIAS', {
          provider: 'dias',
          ursiCode: nearestStation.ursi,
        });

        return res.status(422).json({
          error: `DIAS does not support station ${nearestStation.ursi}`,
          provider: 'dias',
          station: nearestStation.ursi,
          supportedStations: [...diasService.SUPPORTED_STATIONS],
        });
      }

      for (const activeProvider of providerPlan) {
        const cachedResponse = getCachedData(
          nearestStation,
          {},
          activeProvider
        );

        if (cachedResponse) {
          logger.info('Serving ionosphere data from cache', {
            provider: cachedResponse.source,
            mode: providerConfig.mode,
            selectionMode,
            station: nearestStation.name,
            ursiCode: nearestStation.ursi,
            cacheAgeSeconds: cachedResponse.cacheAgeSeconds,
            ageMinutes: cachedResponse.ageMinutes,
            freshness: cachedResponse.freshness,
            measuredAt: cachedResponse.measuredAt,
          });

          return res.json(buildCachedResponse(
            cachedResponse,
            nearestStation,
            { selectionMode }
          ));
        }

        const requestStartedAt = Date.now();

        try {
          const parsedData = await fetchProviderMeasurement(activeProvider, nearestStation);
          const response = buildProviderResponse(
            nearestStation,
            parsedData,
            activeProvider,
            selectionMode
          );

          saveCachedData(nearestStation, response, activeProvider);
          logger.info('Response sent for /api/ionosphere/hf', {
            provider: activeProvider,
            mode: providerConfig.mode,
            selectionMode,
            fallbackUsed: providerErrors.length > 0 || (
              providerConfig.mode === 'hybrid' &&
              selectionMode === 'auto' &&
              activeProvider === 'giro'
            ),
            station: nearestStation.name,
            ursiCode: nearestStation.ursi,
            responseTimeMs: Date.now() - requestStartedAt,
            measuredAt: response.measuredAt,
            ageMinutes: response.ageMinutes,
            foF2: response.foF2,
            muf: response.muf,
            mufFactor: response.mufFactor,
            cached: false,
          });

          return res.json(response);
        } catch (error) {
          providerErrors.push({ provider: activeProvider, error });
          logger.warn('Ionosphere provider attempt failed', {
            provider: activeProvider,
            mode: providerConfig.mode,
            station: nearestStation.name,
            ursiCode: nearestStation.ursi,
            responseTimeMs: Date.now() - requestStartedAt,
            status: error.response?.status ?? error.status ?? null,
            code: error.code ?? null,
            error: error.message,
          });
        }
      }

      const lastProviderError = providerErrors[providerErrors.length - 1]?.error;
      if (lastProviderError) {
        throw lastProviderError;
      }

      throw new Error('No ionosphere provider was available');
    } catch (error) {
      const staleCandidates = nearestStation
        ? providerPlan
            .map((cachedProvider) => getCachedData(
              nearestStation,
              { allowStale: true },
              cachedProvider
            ))
            .filter(Boolean)
            .sort((left, right) => left.ageMinutes - right.ageMinutes)
        : [];
      const staleCachedResponse = staleCandidates[0] || null;

      if (staleCachedResponse) {
        logger.warn('Serving stale ionosphere cache after provider failures', {
          source: staleCachedResponse.source,
          mode: providerConfig.mode,
          selectionMode,
          providersTried: providerErrors.map(({ provider: failedProvider }) => failedProvider),
          station: nearestStation.ursi,
          cacheAgeSeconds: staleCachedResponse.cacheAgeSeconds,
          ageMinutes: staleCachedResponse.ageMinutes,
          freshness: staleCachedResponse.freshness,
          measuredAt: staleCachedResponse.measuredAt,
        });

        return res.json(buildCachedResponse(
          staleCachedResponse,
          nearestStation,
          { sourceStatus: 'unavailable', selectionMode }
        ));
      }

      if (providerErrors.length > 0) {
        logger.error('All ionosphere provider attempts failed', {
          mode: providerConfig.mode,
          station: nearestStation?.ursi ?? null,
          providers: providerErrors.map(({ provider: failedProvider, error: providerError }) => ({
            provider: failedProvider,
            status: providerError.response?.status ?? providerError.status ?? null,
            code: providerError.code ?? null,
            error: providerError.message,
          })),
        });

        return res.status(503).json({
          error: providerConfig.mode === 'hybrid'
            ? 'Ionosphere providers temporarily unavailable'
            : `${providerPlan[0].toUpperCase()} service temporarily unavailable`,
          providersTried: providerPlan,
        });
      }

      logger.error(
        'Error in /api/ionosphere/hf',
        {
          error:
            error.message,
        }
      );

      /*
       * Solo dejamos 500 para errores realmente internos de DXSun.
       */
      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Server error',
        });
    }
  };

exports.getStations =
  (
    req,
    res
  ) => {
    const mode =
      (process.env.IONOSPHERE_PROVIDER || 'hybrid')
        .trim()
        .toLowerCase();
    const stationList =
      stations.map(
        ({
          ursi,
          name,
        }) => ({
          ursi,

          name,
        })
      );

    return res.json(
      stationList
    );
  };