const axios = require('axios');
const logger = require('../config/logger');
const SUPPORTED_STATIONS = require('../config/diasStations');

const DIAS_URL = 'https://electron.space.noa.gr/ionostream/api/v2/idb/sao/pager';
const CHARACTERISTICS = ['foF2', 'foEs', 'mufD', 'mD', 'hF2'];

class DiasError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'DiasError';
    this.status = status;
    this.code = code;
  }
}

function parseObservationTimestamp(value) {
  if (typeof value !== 'string') {
    throw new DiasError('DIAS response has an invalid timestamp', {
      code: 'DIAS_INVALID_TIMESTAMP',
    });
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/
  );

  if (!match) {
    throw new DiasError('DIAS response has an invalid timestamp', {
      code: 'DIAS_INVALID_TIMESTAMP',
    });
  }

  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const milliseconds = Number(`0.${fraction || '0'}`) * 1000;
  const wholeSeconds = [year, month, day, hour, minute, second].map(Number);
  const [numericYear, numericMonth, numericDay, numericHour, numericMinute, numericSecond] = wholeSeconds;
  let timestamp;

  if (!zone) {
    // DIAS returns naive ISO timestamps; interpret them as UTC, not server-local time.
    timestamp = new Date(Date.UTC(
      numericYear,
      numericMonth - 1,
      numericDay,
      numericHour,
      numericMinute,
      numericSecond,
      milliseconds
    ));

    if (
      timestamp.getUTCFullYear() !== numericYear ||
      timestamp.getUTCMonth() !== numericMonth - 1 ||
      timestamp.getUTCDate() !== numericDay ||
      timestamp.getUTCHours() !== numericHour ||
      timestamp.getUTCMinutes() !== numericMinute ||
      timestamp.getUTCSeconds() !== numericSecond
    ) {
      throw new DiasError('DIAS response has an invalid timestamp', {
        code: 'DIAS_INVALID_TIMESTAMP',
      });
    }
  } else {
    timestamp = new Date(value);
  }

  if (Number.isNaN(timestamp.getTime())) {
    throw new DiasError('DIAS response has an invalid timestamp', {
      code: 'DIAS_INVALID_TIMESTAMP',
    });
  }

  return timestamp;
}

function normalizeValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number === 9999) {
    return null;
  }

  return Number(number.toFixed(2));
}

function computeFreshness(ageMinutes) {
  if (ageMinutes < 60) return 'fresh';
  if (ageMinutes < 180) return 'ok';
  return 'old';
}

function normalizeResponse(data, requestedStation, now = new Date()) {
  if (!data || !Array.isArray(data.items)) {
    throw new DiasError('DIAS returned a malformed response', {
      code: 'DIAS_INVALID_RESPONSE',
    });
  }

  if (!data.items[0]) {
    throw new DiasError('DIAS returned no observations for this station', {
      code: 'DIAS_NO_OBSERVATIONS',
    });
  }

  const item = data.items[0];
  const dataset = item.dataset;
  const scaled = item.scaled;

  if (!dataset || !scaled || typeof scaled !== 'object') {
    throw new DiasError('DIAS returned a malformed response', {
      code: 'DIAS_INVALID_RESPONSE',
    });
  }

  if (
    typeof dataset.ursi_code !== 'string' ||
    dataset.ursi_code.toUpperCase() !== requestedStation.toUpperCase()
  ) {
    throw new DiasError('DIAS returned a different station than requested', {
      code: 'DIAS_STATION_MISMATCH',
    });
  }

  const observationDate = parseObservationTimestamp(dataset.timestamp);
  const ageMinutes = Math.floor((now.getTime() - observationDate.getTime()) / 60000);

  if (ageMinutes < -5) {
    throw new DiasError('DIAS returned a future observation', {
      code: 'DIAS_FUTURE_OBSERVATION',
    });
  }

  const measurement = {
    timestamp: observationDate.toISOString(),
    foF2: normalizeValue(scaled.foF2),
    foEs: normalizeValue(scaled.foEs),
    mufd: normalizeValue(scaled.mufD),
    mufFactor: normalizeValue(scaled.mD),
    hF2: normalizeValue(scaled.hF2),
    confidence: null,
    ageMinutes: Math.max(0, ageMinutes),
  };

  if (
    ![
      measurement.foF2,
      measurement.foEs,
      measurement.mufd,
      measurement.mufFactor,
      measurement.hF2,
    ].some((value) => value !== null)
  ) {
    throw new DiasError('DIAS response contains no usable ionospheric values', {
      code: 'DIAS_NO_USABLE_VALUES',
    });
  }

  measurement.freshness = computeFreshness(measurement.ageMinutes);
  return measurement;
}

function getPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function fetchLatest(stationCode) {
  const requestedStation = String(stationCode || '').trim().toUpperCase();

  if (!SUPPORTED_STATIONS.has(requestedStation)) {
    const error = new DiasError(`DIAS does not support station ${requestedStation || '(empty)'}`, {
      status: 422,
      code: 'DIAS_STATION_NOT_SUPPORTED',
    });
    error.supportedStations = [...SUPPORTED_STATIONS];
    throw error;
  }

  const now = new Date();
  const windowHours = getPositiveNumber(process.env.DIAS_WINDOW_HOURS, 3);
  const timeoutMs = getPositiveNumber(process.env.DIAS_TIMEOUT_MS, 10000);
  const params = new URLSearchParams();
  params.append('start', new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString());
  params.append('end', now.toISOString());
  params.append('stations', requestedStation);
  CHARACTERISTICS.forEach((characteristic) => params.append('characteristics', characteristic));
  params.append('order_attrs', 'timestamp');
  params.append('order_by', 'desc');
  params.append('page', '1');
  params.append('size', '1');

  const requestUrl = `${DIAS_URL}?${params.toString()}`;
  const startedAt = Date.now();

  logger.info('DIAS request', {
    provider: 'dias',
    station: requestedStation,
    url: requestUrl,
  });

  try {
    const response = await axios.get(DIAS_URL, {
      params,
      timeout: timeoutMs,
    });
    const responseTimeMs = Date.now() - startedAt;

    if (response.status !== 200) {
      throw new DiasError(`DIAS returned HTTP ${response.status}`, {
        status: response.status,
      });
    }

    const measurement = normalizeResponse(response.data, requestedStation);
    if (
      Date.now() - Date.parse(measurement.timestamp) >
      windowHours * 60 * 60 * 1000
    ) {
      throw new DiasError('DIAS observation is older than the configured query window', {
        code: 'DIAS_OBSERVATION_TOO_OLD',
      });
    }
    logger.info('DIAS measurement received', {
      provider: 'dias',
      station: requestedStation,
      responseTimeMs,
      measuredAt: measurement.timestamp,
      ageMinutes: measurement.ageMinutes,
      foF2: measurement.foF2,
      muf: measurement.mufd,
      mufFactor: measurement.mufFactor,
    });

    return measurement;
  } catch (error) {
    const responseTimeMs = Date.now() - startedAt;
    logger.error('DIAS request failed', {
      provider: 'dias',
      station: requestedStation,
      url: requestUrl,
      responseTimeMs,
      status: error.response?.status ?? error.status ?? null,
      code: error.code ?? null,
      error: error.message,
    });

    if (error instanceof DiasError) {
      throw error;
    }

    throw new DiasError(error.message || 'DIAS request failed', {
      status: error.response?.status ?? null,
      code: error.code ?? null,
    });
  }
}

module.exports = {
  DIAS_URL,
  SUPPORTED_STATIONS,
  DiasError,
  fetchLatest,
  normalizeResponse,
};