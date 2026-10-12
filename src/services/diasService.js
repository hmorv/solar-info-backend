const axios = require('axios');
const logger = require('../config/logger');
const SUPPORTED_STATIONS = require('../config/diasStations');

const DIAS_URL = 'https://electron.space.noa.gr/ionostream/api/v2/idb/sao/pager';
const CHARACTERISTICS = ['foF2', 'foEs', 'mufD', 'mD', 'hF2'];
const PARAMETER_FIELDS = {
  foF2: 'foF2',
  muf: 'mufD',
  mufFactor: 'mD',
  hF2: 'hF2',
  foEs: 'foEs',
};

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
  const calendarDate = new Date(Date.UTC(
    numericYear,
    numericMonth - 1,
    numericDay,
    numericHour,
    numericMinute,
    numericSecond
  ));

  if (
    calendarDate.getUTCFullYear() !== numericYear ||
    calendarDate.getUTCMonth() !== numericMonth - 1 ||
    calendarDate.getUTCDate() !== numericDay ||
    calendarDate.getUTCHours() !== numericHour ||
    calendarDate.getUTCMinutes() !== numericMinute ||
    calendarDate.getUTCSeconds() !== numericSecond
  ) {
    throw new DiasError('DIAS response has an invalid timestamp', {
      code: 'DIAS_INVALID_TIMESTAMP',
    });
  }

  let timestamp;

  if (!zone) {
    // The live pager returns naive ISO values aligned with the requested Z interval.
    timestamp = new Date(calendarDate.getTime() + milliseconds);
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

  return number;
}

function computeFreshness(ageMinutes) {
  if (ageMinutes < 60) return 'fresh';
  if (ageMinutes < 180) return 'ok';
  return 'old';
}

function normalizeObservations(
  items,
  requestedStation,
  now,
  maxAgeMinutes,
  { allowNoUsableValues = false } = {}
) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DiasError('DIAS returned no observations for this station', {
      code: 'DIAS_NO_OBSERVATIONS',
    });
  }

  const validRows = items.map((item) => {
    const dataset = item?.dataset;
    const scaled = item?.scaled;

    if (!dataset || !scaled || typeof scaled !== 'object') {
      throw new DiasError('DIAS returned a malformed observation', {
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
    const ageMs = now.getTime() - observationDate.getTime();

    if (ageMs < -5 * 60 * 1000) {
      throw new DiasError('DIAS returned a future observation', {
        code: 'DIAS_FUTURE_OBSERVATION',
      });
    }

    return {
      scaled,
      observationDate,
      ageMs: Math.max(0, ageMs),
    };
  }).sort((left, right) => right.observationDate - left.observationDate);

  const values = Object.fromEntries(
    Object.keys(PARAMETER_FIELDS).map((field) => [field, null])
  );
  const parameterTimestamps = Object.fromEntries(
    Object.keys(PARAMETER_FIELDS).map((field) => [field, null])
  );
  let latestObservation = null;
  let hasOldUsableValues = false;

  for (const row of validRows) {
    if (!latestObservation) {
      latestObservation = row;
    }

    if (row.ageMs > maxAgeMinutes * 60 * 1000) {
      hasOldUsableValues ||= Object.values(PARAMETER_FIELDS).some(
        (diasField) => normalizeValue(row.scaled[diasField]) !== null
      );
      continue;
    }

    for (const [responseField, diasField] of Object.entries(PARAMETER_FIELDS)) {
      if (values[responseField] !== null) {
        continue;
      }

      const value = normalizeValue(row.scaled[diasField]);
      if (value === null) {
        continue;
      }

      values[responseField] = value;
      parameterTimestamps[responseField] = row.observationDate.toISOString();
    }
  }

  if (
    !allowNoUsableValues &&
    !Object.values(values).some((value) => value !== null)
  ) {
    throw new DiasError(
      hasOldUsableValues
        ? 'DIAS observations have values, but only outside the configured parameter window'
        : 'DIAS response contains no usable ionospheric values',
      {
        code: hasOldUsableValues
          ? 'DIAS_PARAMETERS_TOO_OLD'
          : 'DIAS_NO_USABLE_VALUES',
      }
    );
  }

  const ageMinutes = Math.floor(latestObservation.ageMs / 60000);
  return {
    timestamp: latestObservation.observationDate.toISOString(),
    ...values,
    mufd: values.muf,
    parameterTimestamps,
    hasOldUsableValues,
    confidence: null,
    ageMinutes,
    freshness: computeFreshness(ageMinutes),
  };
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
  const maxAgeMinutes = getPositiveNumber(
    process.env.DIAS_PARAMETER_MAX_AGE_MINUTES,
    30
  );
  const timeoutMs = getPositiveNumber(process.env.DIAS_TIMEOUT_MS, 10000);
  const maxPages = Math.floor(getPositiveNumber(process.env.DIAS_PARAMETER_MAX_PAGES, 3));
  const pageSize = 100;
  const params = new URLSearchParams();
  params.append('start', new Date(now.getTime() - maxAgeMinutes * 60 * 1000).toISOString());
  params.append('end', now.toISOString());
  params.append('stations', requestedStation);
  CHARACTERISTICS.forEach((characteristic) => params.append('characteristics', characteristic));
  params.append('order_attrs', 'timestamp');
  params.append('order_by', 'desc');
  params.append('size', String(pageSize));
  const startedAt = Date.now();

  try {
    const observations = [];
    let totalPages = 1;
    let measurement;
    let pagesFetched = 0;
    let lastRequestUrl = null;

    for (let page = 1; page <= Math.min(totalPages, maxPages); page++) {
      const pageParams = new URLSearchParams(params);
      pageParams.append('page', String(page));
      const requestUrl = `${DIAS_URL}?${pageParams.toString()}`;
      lastRequestUrl = requestUrl;

      logger.info('DIAS request', {
        provider: 'dias',
        station: requestedStation,
        page,
        url: requestUrl,
      });

      const response = await axios.get(DIAS_URL, {
        params: pageParams,
        timeout: timeoutMs,
      });
      if (response.status !== 200) {
        throw new DiasError(`DIAS returned HTTP ${response.status}`, {
          status: response.status,
          code: 'DIAS_HTTP_ERROR',
        });
      }

      if (!response.data || !Array.isArray(response.data.items)) {
        throw new DiasError('DIAS returned a malformed pager response', {
          code: 'DIAS_INVALID_RESPONSE',
        });
      }

      observations.push(...response.data.items);
      pagesFetched++;
      totalPages = Math.max(1, Number(response.data.pages) || 1);
      measurement = normalizeObservations(
        observations,
        requestedStation,
        now,
        maxAgeMinutes,
        { allowNoUsableValues: true }
      );

      const hasAllParameters = Object.values(measurement.parameterTimestamps)
        .every((timestamp) => timestamp !== null);
      if (hasAllParameters || page >= totalPages || page >= maxPages) {
        break;
      }
    }

    if (!measurement || !Object.values(measurement.parameterTimestamps).some(Boolean)) {
      const hasOldUsableValues = measurement?.hasOldUsableValues;
      throw new DiasError(
        hasOldUsableValues
          ? 'DIAS observations have values, but only outside the configured parameter window'
          : 'DIAS response contains no usable ionospheric values in the configured window',
        {
          code: hasOldUsableValues
            ? 'DIAS_PARAMETERS_TOO_OLD'
            : 'DIAS_NO_USABLE_VALUES',
        }
      );
    }
    delete measurement.hasOldUsableValues;

    const responseTimeMs = Date.now() - startedAt;
    logger.info('DIAS measurement received', {
      provider: 'dias',
      station: requestedStation,
      url: lastRequestUrl,
      responseTimeMs,
      measuredAt: measurement.timestamp,
      ageMinutes: measurement.ageMinutes,
      foF2: measurement.foF2,
      muf: measurement.mufd,
      mufFactor: measurement.mufFactor,
      parameterTimestamps: measurement.parameterTimestamps,
      pagesFetched,
    });

    return measurement;
  } catch (error) {
    const responseTimeMs = Date.now() - startedAt;
    logger.error('DIAS request failed', {
      provider: 'dias',
      station: requestedStation,
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
  normalizeObservations,
  parseObservationTimestamp,
};