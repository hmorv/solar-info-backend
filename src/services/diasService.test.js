const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const diasService = require('./diasService');

function naiveTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

function payload({ timestamp, station = 'EB040', scaled = {} } = {}) {
  return {
    items: [
      {
        dataset: {
          ursi_code: station,
          timestamp: timestamp || naiveTimestamp(new Date()),
        },
        scaled: {
          foF2: 6.75,
          foEs: 2.55,
          mufD: 24.59,
          mD: 3.76,
          hF2: 250,
          ...scaled,
        },
      },
    ],
    total: 1,
    page: 1,
    size: 1,
    pages: 1,
  };
}

function observation(timestamp, scaled, station = 'EB040') {
  return {
    dataset: { ursi_code: station, timestamp },
    scaled,
  };
}

function normalizeItems(items, now = new Date(), maxAgeMinutes = 30) {
  return diasService.normalizeObservations(items, 'EB040', now, maxAgeMinutes);
}

test('DIAS requests repeated characteristics using UTC dates and normalizes its response', async () => {
  const originalGet = axios.get;
  let request;
  axios.get = async (url, config) => {
    request = { url, config };
    return { status: 200, data: payload() };
  };

  try {
    const result = await diasService.fetchLatest('EB040');
    const params = request.config.params;

    assert.equal(request.url, diasService.DIAS_URL);
    assert.deepEqual(params.getAll('characteristics'), ['foF2', 'foEs', 'mufD', 'mD', 'hF2']);
    assert.match(params.get('start'), /Z$/);
    assert.match(params.get('end'), /Z$/);
    assert.equal(params.get('stations'), 'EB040');
    assert.equal(params.get('order_attrs'), 'timestamp');
    assert.equal(params.get('order_by'), 'desc');
    assert.equal(params.get('page'), '1');
    assert.equal(params.get('size'), '100');
    assert.equal(request.config.timeout, 10000);
    assert.equal(result.foF2, 6.75);
    assert.equal(result.mufd, 24.59);
    assert.equal(result.mufFactor, 3.76);
    assert.equal(result.hF2, 250);
    assert.equal(result.confidence, null);
    assert.equal(result.foEs, 2.55);
    assert.equal(result.parameterTimestamps.foEs, result.timestamp);
  } finally {
    axios.get = originalGet;
  }
});

test('DIAS normalizes null and 9999 missing-value markers while preserving zero', () => {
  const result = normalizeItems(
    payload({ scaled: { foF2: 9999, foEs: null, mufD: 0, mD: '9999', hF2: null } }).items
  );

  assert.equal(result.foF2, null);
  assert.equal(result.foEs, null);
  assert.equal(result.mufd, 0);
  assert.equal(result.mufFactor, null);
  assert.equal(result.hF2, null);
});

test('DIAS hF2 maps to the legacy response field after semantic confirmation', () => {
  const result = normalizeItems(payload({ scaled: { hF2: 250 } }).items);
  assert.equal(result.hF2, 250);
});

test('DIAS rejects empty, malformed, mismatched, and unusable responses', () => {
  assert.throws(() => normalizeItems([]), {
    name: 'DiasError',
    code: 'DIAS_NO_OBSERVATIONS',
  });
  assert.throws(
    () => normalizeItems(payload({ station: 'AT138' }).items),
    /different station/
  );
  assert.throws(
    () => normalizeItems(payload({ scaled: {
      foF2: null,
      foEs: 9999,
      mufD: null,
      mD: null,
      hF2: null,
    } }).items),
    /no usable ionospheric values/
  );
  assert.throws(
    () => normalizeItems([observation(naiveTimestamp(new Date()), {})]),
    /no usable ionospheric values/
  );
});

test('DIAS rejects a malformed HTTP 200 pager payload', async () => {
  const originalGet = axios.get;
  axios.get = async () => ({ status: 200, data: { unexpected: [] } });

  try {
    await assert.rejects(diasService.fetchLatest('EB040'), {
      name: 'DiasError',
      code: 'DIAS_INVALID_RESPONSE',
    });
  } finally {
    axios.get = originalGet;
  }
});

test('DIAS turns HTTP 500 and timeout failures into provider errors', async () => {
  const originalGet = axios.get;

  try {
    axios.get = async () => {
      const error = new Error('Request failed');
      error.response = { status: 500 };
      throw error;
    };
    await assert.rejects(diasService.fetchLatest('EB040'), { name: 'DiasError', status: 500 });

    axios.get = async () => {
      const error = new Error('timeout');
      error.code = 'ECONNABORTED';
      throw error;
    };
    await assert.rejects(diasService.fetchLatest('EB040'), {
      name: 'DiasError',
      code: 'ECONNABORTED',
    });
  } finally {
    axios.get = originalGet;
  }
});

test('DIAS rejects unsupported stations before making a request', async () => {
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async () => {
    requestCount++;
    throw new Error('must not request');
  };

  try {
    await assert.rejects(diasService.fetchLatest('AH223'), {
      name: 'DiasError',
      status: 422,
      code: 'DIAS_STATION_NOT_SUPPORTED',
    });
    assert.equal(requestCount, 0);
  } finally {
    axios.get = originalGet;
  }
});

test('DIAS calculates age and freshness from the newest observation timestamp', () => {
  const now = new Date('2026-10-12T12:00:00.000Z');
  const result = normalizeItems(
    payload({ timestamp: '2026-10-12T08:15:00' }).items,
    now,
    300
  );

  assert.equal(result.timestamp, '2026-10-12T08:15:00.000Z');
  assert.equal(result.ageMinutes, 225);
  assert.equal(result.freshness, 'old');
});

test('DIAS identifies observations older than its configured query window', async () => {
  const originalGet = axios.get;
  axios.get = async () => ({ status: 200, data: payload({
    timestamp: naiveTimestamp(new Date(Date.now() - 240 * 60000)),
  }) });

  try {
    await assert.rejects(diasService.fetchLatest('EB040'), {
      name: 'DiasError',
      code: 'DIAS_PARAMETERS_TOO_OLD',
    });
  } finally {
    axios.get = originalGet;
  }
});

test('DIAS recovers foEs from the latest valid observation before a 9999 marker', () => {
  const now = new Date('2026-10-12T09:30:00.000Z');
  const items = [
    observation('2026-10-12T09:25:01', { foEs: 9999 }),
    observation('2026-10-12T09:20:01', { foEs: null }),
    observation('2026-10-12T09:15:01', { foEs: 3.15 }),
  ];
  const result = normalizeItems(items, now);

  assert.equal(result.foEs, 3.15);
  assert.equal(result.parameterTimestamps.foEs, '2026-10-12T09:15:01.000Z');
  assert.equal(result.timestamp, '2026-10-12T09:25:01.000Z');
});

test('DIAS selects the newest value independently for each parameter', () => {
  const now = new Date('2026-10-12T09:30:00.000Z');
  const items = [
    observation('2026-10-12T09:25:01', {
      foF2: 7.1,
      foEs: 9999,
      mufD: 25,
      mD: null,
      hF2: 230,
    }),
    observation('2026-10-12T09:15:01', {
      foF2: 9999,
      foEs: 3.15,
      mufD: null,
      mD: 3.2,
      hF2: 250,
    }),
    observation('2026-10-12T09:05:01', {
      foF2: 6.5,
      foEs: 2.8,
      mufD: 23,
      mD: 3.1,
      hF2: 260,
    }),
  ];
  const result = normalizeItems(items, now);

  assert.deepEqual(
    [result.foF2, result.mufd, result.mufFactor, result.hF2, result.foEs],
    [7.1, 25, 3.2, 230, 3.15]
  );
  assert.deepEqual(result.parameterTimestamps, {
    foF2: '2026-10-12T09:25:01.000Z',
    muf: '2026-10-12T09:25:01.000Z',
    mufFactor: '2026-10-12T09:15:01.000Z',
    hF2: '2026-10-12T09:25:01.000Z',
    foEs: '2026-10-12T09:15:01.000Z',
  });
});

test('DIAS returns null for parameters with no valid value inside their individual age limit', () => {
  const now = new Date('2026-10-12T09:30:00.000Z');
  const result = normalizeItems([
    observation('2026-10-12T08:59:59', { foEs: 3.1, foF2: 6.5 }),
    observation('2026-10-12T09:25:01', { foEs: 9999, foF2: 7.1 }),
  ], now);

  assert.equal(result.foEs, null);
  assert.equal(result.parameterTimestamps.foEs, null);
  assert.equal(result.foF2, 7.1);
});

test('DIAS requests another page when recent rows do not contain every characteristic', async () => {
  const originalGet = axios.get;
  const originalMaxPages = process.env.DIAS_PARAMETER_MAX_PAGES;
  const requestedPages = [];
  const recoveredTimestamp = naiveTimestamp(new Date(Date.now() - 10 * 60000));
  process.env.DIAS_PARAMETER_MAX_PAGES = '2';
  axios.get = async (url, config) => {
    const page = config.params.get('page');
    requestedPages.push(page);
    return {
      status: 200,
      data: page === '1'
        ? {
            items: [observation(naiveTimestamp(new Date()), {
              foF2: 7,
              foEs: 9999,
              mufD: 25,
              mD: 3.2,
              hF2: 230,
            })],
            pages: 2,
          }
        : {
            items: [observation(recoveredTimestamp, {
              foEs: 3.15,
            })],
            pages: 2,
          },
    };
  };

  try {
    const result = await diasService.fetchLatest('EB040');
    assert.deepEqual(requestedPages, ['1', '2']);
    assert.equal(result.foEs, 3.15);
    assert.equal(
      result.parameterTimestamps.foEs,
      diasService.parseObservationTimestamp(recoveredTimestamp).toISOString()
    );
  } finally {
    axios.get = originalGet;
    if (originalMaxPages === undefined) delete process.env.DIAS_PARAMETER_MAX_PAGES;
    else process.env.DIAS_PARAMETER_MAX_PAGES = originalMaxPages;
  }
});

test('DIAS rejects invalid, ambiguous, and materially future timestamps', () => {
  assert.throws(() => diasService.parseObservationTimestamp('2026-10-12 09:15:01'), {
    code: 'DIAS_INVALID_TIMESTAMP',
  });
  assert.throws(() => diasService.parseObservationTimestamp('not-a-time'), {
    code: 'DIAS_INVALID_TIMESTAMP',
  });
  assert.throws(() => diasService.parseObservationTimestamp('2026-02-31T09:15:01Z'), {
    code: 'DIAS_INVALID_TIMESTAMP',
  });
  assert.equal(
    diasService.parseObservationTimestamp('2026-10-12T09:15:01').toISOString(),
    '2026-10-12T09:15:01.000Z'
  );
  assert.equal(
    diasService.parseObservationTimestamp('2026-10-12T11:15:01+02:00').toISOString(),
    '2026-10-12T09:15:01.000Z'
  );
  assert.throws(() => normalizeItems([
    observation('2026-10-12T10:00:01', { foEs: 3 }),
  ], new Date('2026-10-12T09:30:00Z')), {
    code: 'DIAS_FUTURE_OBSERVATION',
  });
});
