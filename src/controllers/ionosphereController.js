// Controlador para datos ionosféricos de GIRO
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const stations = require('../config/stations');

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

const giroCache = new Map();

function getCacheKey(station) {
  return station.ursi.toUpperCase();
}

function persistCacheToDisk() {
  try {
    const directory = path.dirname(CACHE_FILE_PATH);

    fs.mkdirSync(directory, {
      recursive: true,
    });

    const stationsCache = {};

    for (const [key, entry] of giroCache.entries()) {
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
    const tempFile = `${CACHE_FILE_PATH}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(payload, null, 2),
      'utf8'
    );

    fs.renameSync(
      tempFile,
      CACHE_FILE_PATH
    );

    logger.debug(
      'GIRO persistent cache saved',
      {
        file: CACHE_FILE_PATH,
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
      'Failed to persist GIRO cache',
      {
        file: CACHE_FILE_PATH,
        error: error.message,
      }
    );
  }
}

function loadPersistentCache() {
  try {
    if (!fs.existsSync(CACHE_FILE_PATH)) {
      logger.info(
        'No persistent GIRO cache found',
        {
          file: CACHE_FILE_PATH,
        }
      );

      return;
    }

    const raw =
      fs.readFileSync(
        CACHE_FILE_PATH,
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

      giroCache.set(
        key.toUpperCase(),
        {
          data: entry.data,
          cachedAt: cachedAtMs,
        }
      );

      loaded++;
    }

    logger.info(
      'Persistent GIRO cache loaded',
      {
        file: CACHE_FILE_PATH,
        loaded,
        discarded,
      }
    );

    /*
     * Si había entradas demasiado antiguas, reescribimos el fichero
     * sin ellas.
     */
    if (discarded > 0) {
      persistCacheToDisk();
    }
  } catch (error) {
    /*
     * Una caché corrupta tampoco debe impedir arrancar DXSun.
     */
    logger.error(
      'Failed to load persistent GIRO cache',
      {
        file: CACHE_FILE_PATH,
        error: error.message,
      }
    );
  }
}

function getCachedData(
  station,
  {
    allowStale = false,
  } = {}
) {
  const key =
    getCacheKey(station);

  const entry =
    giroCache.get(key);

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
    giroCache.delete(key);

    persistCacheToDisk();

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
  data
) {
  const key =
    getCacheKey(station);

  giroCache.set(
    key,
    {
      data: {
        ...data,
      },

      cachedAt:
        Date.now(),
    }
  );

  /*
   * Cada respuesta válida de GIRO actualiza también la copia
   * persistente.
   */
  persistCacheToDisk();
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

/*
 * Restauramos el último dato válido cuando se carga el controlador.
 */
loadPersistentCache();

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

  const dLon =
    (
      (lon2 - lon1) *
      Math.PI
    ) /
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

exports.getHFData =
  async (
    req,
    res
  ) => {
    logger.info(
      '➡️ Received GET request /api/ionosphere/hf'
    );

    /*
     * Debe estar fuera del try para que el catch pueda buscar
     * el último dato válido si GIRO falla.
     */
    let nearestStation =
      null;

    try {
      const {
        lat,
        lon,
        station,
      } = req.query;

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

      /*
       * Caché normal: durante los primeros 15 minutos no volvemos
       * a consultar GIRO.
       */
      const cachedResponse =
        getCachedData(
          nearestStation
        );

      if (
        cachedResponse
      ) {
        logger.info(
          'Serving GIRO data from cache',
          {
            station:
              nearestStation.name,

            cacheAgeSeconds:
              cachedResponse.cacheAgeSeconds,

            ageMinutes:
              cachedResponse.ageMinutes,

            freshness:
              cachedResponse.freshness,

            measuredAt:
              cachedResponse.measuredAt,
          }
        );

        return res.json(
          buildCachedResponse(
            cachedResponse,
            nearestStation
          )
        );
      }

      const now =
        new Date();

      /*
       * Buscar hasta 24 horas atrás para obtener la última
       * medición disponible de la estación.
       */
      const fromDate =
        new Date(
          now.getTime() -
            24 *
              60 *
              60 *
              1000
        );

      const params = {
        ursiCode:
          nearestStation.ursi,

        charName:
          'foF2,foEs,MUF(D),M(D),h`F2',

        DMUF:
          3000,

        fromDate:
          formatGiroDate(
            fromDate
          ),

        toDate:
          formatGiroDate(
            now
          ),
      };

      const queryString =
        new URLSearchParams(
          params
        ).toString();

      logger.info(
        'GIRO request URL',
        {
          url:
            `${GIRO_BASE_URL}?${queryString}`,
        }
      );

      const giroResponse =
        await axios.get(
          GIRO_BASE_URL,
          {
            params,

            timeout:
              10000,
          }
        );

      logger.info(
        'GIRO response received',
        {
          station:
            nearestStation.name,

          ursiCode:
            nearestStation.ursi,

          status:
            giroResponse.status,

          dataLength:
            typeof giroResponse.data ===
            'string'
              ? giroResponse.data.length
              : null,
        }
      );

      let parsedData;

      try {
        parsedData =
          parseGiroResponse(
            giroResponse.data
          );
      } catch (err) {
        /*
         * Guardamos un fragmento para poder diagnosticar cambios
         * de formato de GIRO.
         */
        const snippet =
          typeof giroResponse.data ===
          'string'
            ? giroResponse.data.slice(
                0,
                2000
              )
            : String(
                giroResponse.data
              );

        logger.error(
          'Failed to parse GIRO response',
          {
            station:
              nearestStation.name,

            ursiCode:
              nearestStation.ursi,

            error:
              err.message,

            snippet,
          }
        );

        throw err;
      }

      const response = {
        cached:
          false,

        station: {
          ursiCode:
            nearestStation.ursi,

          name:
            nearestStation.name,

          distanceKm:
            nearestStation.distance !=
            null
              ? Number(
                  nearestStation.distance.toFixed(
                    2
                  )
                )
              : null,
        },

        measuredAt:
          parsedData.timestamp,

        foF2:
          parsedData.foF2,

        muf:
          parsedData.mufd,

        mufFactor:
          parsedData.mufFactor,

        hF2:
          parsedData.hF2,

        foEs:
          parsedData.foEs,

        confidence:
          parsedData.confidence,

        ageMinutes:
          parsedData.ageMinutes,

        freshness:
          parsedData.freshness,
      };

      /*
       * Guarda en RAM y en disco.
       */
      saveCachedData(
        nearestStation,
        response
      );

      logger.info(
        'Response sent for /api/ionosphere/hf',
        {
          station:
            nearestStation.name,

          foF2:
            parsedData.foF2,

          muf:
            parsedData.mufd,

          mufFactor:
            parsedData.mufFactor,

          cached:
            false,
        }
      );

      return res.json(
        response
      );
    } catch (error) {
      /*
       * Si GIRO falla, recuperamos el último dato válido.
       *
       * Puede proceder de:
       *
       * - la memoria del proceso actual;
       * - giro-cache.json restaurado tras un reinicio.
       */
      const staleCachedResponse =
        nearestStation
          ? getCachedData(
              nearestStation,
              {
                allowStale:
                  true,
              }
            )
          : null;

      if (
        staleCachedResponse
      ) {
        logger.warn(
          'GIRO unavailable; serving last cached data',
          {
            station:
              nearestStation.name,

            ursiCode:
              nearestStation.ursi,

            cacheAgeSeconds:
              staleCachedResponse.cacheAgeSeconds,

            ageMinutes:
              staleCachedResponse.ageMinutes,

            freshness:
              staleCachedResponse.freshness,

            measuredAt:
              staleCachedResponse.measuredAt,

            giroError:
              error.message,

            giroStatus:
              error.response
                ?.status ??
              null,
          }
        );

        /*
         * Seguimos devolviendo 200 para mantener compatible la APK
         * actual.
         */
        return res.json(
          buildCachedResponse(
            staleCachedResponse,
            nearestStation,
            {
              sourceStatus:
                'unavailable',
            }
          )
        );
      }

      /*
       * Fallos HTTP, DNS, timeout, conexión reseteada, etc.
       * Son fallos de GIRO, no errores internos de DXSun.
       */
      if (
        axios.isAxiosError(
          error
        )
      ) {
        logger.error(
          'GIRO API error',
          {
            status:
              error.response
                ?.status ??
              null,

            statusText:
              error.response
                ?.statusText ??
              null,

            requestUrl:
              error.config
                ?.url,

            requestParams:
              error.config
                ?.params,

            data:
              error.response
                ?.data ??
              null,

            error:
              error.message,

            code:
              error.code ??
              null,
          }
        );

        return res
          .status(503)
          .json({
            error:
              'GIRO service temporarily unavailable',
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
       * GIRO también puede devolver HTTP 200 pero una respuesta
       * vacía o no interpretable.
       */
      if (
        error.message ===
          'Empty GIRO response' ||
        error.message ===
          'No valid ionospheric measurement found in GIRO response'
      ) {
        return res
          .status(503)
          .json({
            error:
              'GIRO service temporarily unavailable',
          });
      }

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