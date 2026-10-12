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
    assert.equal(params.get('size'), '1');
    assert.equal(request.config.timeout, 10000);
    assert.equal(result.foF2, 6.75);
    assert.equal(result.mufd, 24.59);
    assert.equal(result.mufFactor, 3.76);
    assert.equal(result.hF2, 250);
    assert.equal(result.confidence, null);
  } finally {
    axios.get = originalGet;
  }
});

test('DIAS normalizes null and 9999 missing-value markers while preserving zero', () => {
  const result = diasService.normalizeResponse(
    payload({ scaled: { foF2: 9999, foEs: null, mufD: 0, mD: '9999', hF2: null } }),
    'EB040'
  );

  assert.equal(result.foF2, null);
  assert.equal(result.foEs, null);
  assert.equal(result.mufd, 0);
  assert.equal(result.mufFactor, null);
  assert.equal(result.hF2, null);
});

test('DIAS hF2 maps to the legacy response field after semantic confirmation', () => {
  const result = diasService.normalizeResponse(payload({ scaled: { hF2: 250 } }), 'EB040');
  assert.equal(result.hF2, 250);
});

test('DIAS rejects empty, malformed, mismatched, and unusable responses', () => {
  assert.throws(() => diasService.normalizeResponse({ items: [] }, 'EB040'), {
    name: 'DiasError',
    code: 'DIAS_NO_OBSERVATIONS',
  });
  assert.throws(() => diasService.normalizeResponse({}, 'EB040'), {
    name: 'DiasError',
    code: 'DIAS_INVALID_RESPONSE',
  });
  assert.throws(
    () => diasService.normalizeResponse(payload({ station: 'AT138' }), 'EB040'),
    /different station/
  );
  assert.throws(
    () => diasService.normalizeResponse(payload({ scaled: {
      foF2: null,
      foEs: 9999,
      mufD: null,
      mD: null,
      hF2: null,
    } }), 'EB040'),
    /no usable ionospheric values/
  );
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

test('DIAS calculates age and freshness from the observation timestamp', () => {
  const now = new Date('2026-10-12T12:00:00.000Z');
  const result = diasService.normalizeResponse(
    payload({ timestamp: '2026-10-12T08:15:00' }),
    'EB040',
    now
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
      code: 'DIAS_OBSERVATION_TOO_OLD',
    });
  } finally {
    axios.get = originalGet;
  }
});
