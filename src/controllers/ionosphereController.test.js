const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');
const diasServiceStations = require('../config/diasStations');

const controllerPath = require.resolve('./ionosphereController');

function makeDiasPayload(ageMinutes = 1, station = 'EB040') {
  const timestamp = new Date(Date.now() - ageMinutes * 60000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '');

  return {
    items: [{
      dataset: { ursi_code: station, timestamp },
      scaled: { foF2: 6.75, foEs: 2.55, mufD: 24.59, mD: 3.76, hF2: 250 },
    }],
    total: 1,
    page: 1,
    size: 1,
    pages: 1,
  };
}

function makeGiroResponse() {
  const timestamp = new Date(Date.now() - 60000).toISOString();
  return `${timestamp} 7 6.75 0 2.55 0 24.59 0 3.76 0 250 0`;
}

function createController(provider, seedCache, preferredProvider, overrides = {}) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dxsun-ionosphere-'));
  const originalEnvironment = {
    IONOSPHERE_PROVIDER: process.env.IONOSPHERE_PROVIDER,
    IONOSPHERE_PREFERRED_PROVIDER: process.env.IONOSPHERE_PREFERRED_PROVIDER,
    GIRO_CACHE_FILE: process.env.GIRO_CACHE_FILE,
    DIAS_CACHE_FILE: process.env.DIAS_CACHE_FILE,
    IONOSPHERE_AUTO_MAX_DISTANCE_KM: process.env.IONOSPHERE_AUTO_MAX_DISTANCE_KM,
    IONOSPHERE_MAX_OBSERVATION_AGE_MINUTES: process.env.IONOSPHERE_MAX_OBSERVATION_AGE_MINUTES,
    IONOSPHERE_AUTO_MAX_ATTEMPTS: process.env.IONOSPHERE_AUTO_MAX_ATTEMPTS,
  };

  if (provider === undefined) {
    delete process.env.IONOSPHERE_PROVIDER;
  } else {
    process.env.IONOSPHERE_PROVIDER = provider;
  }
  if (preferredProvider === undefined) {
    delete process.env.IONOSPHERE_PREFERRED_PROVIDER;
  } else {
    process.env.IONOSPHERE_PREFERRED_PROVIDER = preferredProvider;
  }
  process.env.GIRO_CACHE_FILE = path.join(tempDirectory, 'giro-cache.json');
  process.env.DIAS_CACHE_FILE = path.join(tempDirectory, 'dias-cache.json');
  process.env.IONOSPHERE_AUTO_MAX_DISTANCE_KM = String(overrides.maxDistanceKm ?? 500);
  process.env.IONOSPHERE_MAX_OBSERVATION_AGE_MINUTES = String(overrides.maxAgeMinutes ?? 30);
  process.env.IONOSPHERE_AUTO_MAX_ATTEMPTS = String(overrides.maxAttempts ?? 3);

  if (seedCache) {
    seedCache({
      giroCacheFile: process.env.GIRO_CACHE_FILE,
      diasCacheFile: process.env.DIAS_CACHE_FILE,
    });
  }

  delete require.cache[controllerPath];

  return {
    controller: require('./ionosphereController'),
    tempDirectory,
    restore() {
      delete require.cache[controllerPath];
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    },
  };
}

async function invoke(controller, query) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  await controller.getHFData({ query }, response);
  return response;
}

test('IONOSPHERE_PROVIDER=dias calls DIAS and keeps the existing response contract', async () => {
  const state = createController('dias');
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    return { status: 200, data: makeDiasPayload() };
  };

  try {
    const response = await invoke(state.controller, { station: 'EB040' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.source, 'dias');
    assert.equal(response.body.cached, false);
    assert.deepEqual(response.body.station, {
      ursiCode: 'EB040',
      name: 'ROQUETES',
      distanceKm: null,
    });
    for (const key of [
      'measuredAt', 'foF2', 'muf', 'mufFactor', 'hF2', 'foEs',
      'confidence', 'ageMinutes', 'freshness', 'cached',
    ]) {
      assert.ok(Object.hasOwn(response.body, key), `missing ${key}`);
    }
    assert.equal(response.body.confidence, null);
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /electron\.space\.noa\.gr\/ionostream/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('hybrid is the default mode and prefers DIAS for supported stations', async () => {
  const state = createController(undefined);
  const originalGet = axios.get;
  let requestedUrl;
  axios.get = async (url) => {
    requestedUrl = url;
    return { status: 200, data: makeDiasPayload() };
  };

  try {
    const response = await invoke(state.controller, { station: 'EB040' });
    assert.equal(response.body.source, 'dias');
    assert.match(requestedUrl, /electron\.space\.noa\.gr\/ionostream/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('hybrid honors GIRO as the preferred provider for DIAS-compatible stations', async () => {
  const state = createController('hybrid', undefined, 'giro');
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { station: 'EB040' });
    assert.equal(response.body.source, 'giro');
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /lgdc\.uml\.edu/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('IONOSPHERE_PROVIDER=giro calls GIRO only and retains its confidence value', async () => {
  const state = createController('giro');
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { station: 'EB040' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.source, 'giro');
    assert.equal(response.body.confidence, 7);
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /lgdc\.uml\.edu\/fastchar/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('hybrid falls back from DIAS to GIRO for the same selected station', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  const requests = [];
  axios.get = async (url, config) => {
    requests.push({ url, config });
    if (url.includes('electron.space.noa.gr')) {
      return { status: 200, data: { items: [] } };
    }
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { station: 'EB040' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.source, 'giro');
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /electron\.space\.noa\.gr/);
    assert.match(requests[1].url, /lgdc\.uml\.edu/);
    assert.equal(requests[0].config.params.get('stations'), 'EB040');
    assert.equal(requests[1].config.params.ursiCode, 'EB040');
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('hybrid routes stations outside DIAS directly to GIRO', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { station: 'AH223' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.station.ursiCode, 'AH223');
    assert.equal(response.body.source, 'giro');
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /lgdc\.uml\.edu/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('automatic hybrid selection uses a recent DIAS station about 200 km away', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  const requestedStations = [];
  axios.get = async (url, config) => {
    const code = config.params.get('stations');
    requestedStations.push(code);
    return { status: 200, data: makeDiasPayload(2, code) };
  };

  try {
    const response = await invoke(state.controller, { lat: '43.6', lon: '12.5' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.source, 'dias');
    assert.equal(response.body.selectionMode, 'auto');
    assert.equal(response.body.station.ursiCode, 'RO041');
    assert.ok(response.body.station.distanceKm >= 180);
    assert.ok(response.body.station.distanceKm <= 500);
    assert.deepEqual(requestedStations, ['RO041']);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('automatic DIAS selection skips an empty nearest station and uses the next recent one', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  const requestedStations = [];
  axios.get = async (url, config) => {
    const code = config.params.get('stations');
    requestedStations.push(code);
    return code === 'DB049'
      ? { status: 200, data: { items: [] } }
      : { status: 200, data: makeDiasPayload(4, code) };
  };

  try {
    const response = await invoke(state.controller, { lat: '50.1', lon: '9' });
    assert.equal(response.body.source, 'dias');
    assert.equal(response.body.selectionMode, 'auto');
    assert.equal(response.body.station.ursiCode, 'PQ052');
    assert.deepEqual(requestedStations, ['DB049', 'PQ052']);
    assert.ok(response.body.station.distanceKm <= 500);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('automatic hybrid falls back to nearest GIRO when all nearby DIAS stations have no observations', async () => {
  const state = createController('hybrid', undefined, undefined, { maxAttempts: 10 });
  const originalGet = axios.get;
  const requests = [];
  axios.get = async (url, config) => {
    requests.push({ url, config });
    if (url.includes('electron.space.noa.gr')) {
      return { status: 200, data: { items: [] } };
    }
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { lat: '43.6', lon: '12.5' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.source, 'giro');
    assert.equal(response.body.selectionMode, 'auto');
    assert.equal(response.body.station.ursiCode, 'RO041');
    assert.equal(requests.at(-1).config.params.ursiCode, 'RO041');
    assert.ok(requests.filter(({ url }) => url.includes('electron.space.noa.gr')).length >= 1);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('automatic hybrid returns a controlled error when GIRO fails after DIAS exhaustion', async () => {
  const state = createController('hybrid', undefined, undefined, { maxAttempts: 10 });
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    if (url.includes('electron.space.noa.gr')) {
      return { status: 200, data: { items: [] } };
    }
    throw new Error('GIRO unavailable');
  };

  try {
    const response = await invoke(state.controller, { lat: '43.6', lon: '12.5' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.error, 'Ionosphere providers temporarily unavailable');
    assert.match(requestedUrls.at(-1), /lgdc\.uml\.edu/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('automatic hybrid does not query distant DIAS stations and uses the nearest GIRO station', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { lat: '40.7', lon: '-74' });
    assert.equal(response.body.source, 'giro');
    assert.equal(response.body.selectionMode, 'auto');
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /lgdc\.uml\.edu/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('manual DIAS selection is not constrained by the automatic distance radius', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  let requestedStation;
  axios.get = async (url, config) => {
    requestedStation = config.params.get('stations');
    return { status: 200, data: makeDiasPayload(2, requestedStation) };
  };

  try {
    const response = await invoke(state.controller, {
      station: 'EB040',
      lat: '-33',
      lon: '151',
    });
    assert.equal(response.body.source, 'dias');
    assert.equal(response.body.selectionMode, 'manual');
    assert.equal(response.body.station.ursiCode, 'EB040');
    assert.equal(requestedStation, 'EB040');
    assert.ok(response.body.station.distanceKm > 500);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('manual GIRO-only station stays selected in hybrid mode', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { station: 'AH223' });
    assert.equal(response.body.source, 'giro');
    assert.equal(response.body.selectionMode, 'manual');
    assert.equal(response.body.station.ursiCode, 'AH223');
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /lgdc\.uml\.edu/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('automatic exclusive DIAS returns a controlled error when no station is within radius', async () => {
  const state = createController('dias');
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async () => {
    requestCount++;
    throw new Error('no DIAS requests should be made');
  };

  try {
    const response = await invoke(state.controller, { lat: '40.7', lon: '-74' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.provider, 'dias');
    assert.equal(response.body.candidatesInRange, 0);
    assert.equal(requestCount, 0);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('exclusive DIAS automatically selects the closest recent station in range', async () => {
  const state = createController('dias');
  const originalGet = axios.get;
  let requestedStation;
  axios.get = async (url, config) => {
    requestedStation = config.params.get('stations');
    return { status: 200, data: makeDiasPayload(2, requestedStation) };
  };

  try {
    const response = await invoke(state.controller, { lat: '43.6', lon: '12.5' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.source, 'dias');
    assert.equal(response.body.selectionMode, 'auto');
    assert.equal(response.body.station.ursiCode, 'RO041');
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('exclusive GIRO automatic selection keeps the original nearest-station path', async () => {
  const state = createController('giro');
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { lat: '40.7', lon: '-74' });
    assert.equal(response.body.source, 'giro');
    assert.equal(response.body.selectionMode, 'auto');
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0], /lgdc\.uml\.edu/);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('automatic selection serves a valid recent DIAS cache entry without a provider request', async () => {
  const state = createController('hybrid', ({ diasCacheFile }) => {
    const cachedAt = new Date().toISOString();
    fs.writeFileSync(diasCacheFile, JSON.stringify({
      version: 1,
      stations: {
        RO041: {
          cachedAt,
          data: {
            source: 'dias',
            station: { ursiCode: 'RO041', name: 'ROME', distanceKm: null },
            measuredAt: new Date(Date.now() - 5 * 60000).toISOString(),
            foF2: 6.5,
            muf: 24,
            mufFactor: 3.5,
            hF2: 250,
            foEs: 2.2,
            confidence: null,
            ageMinutes: 5,
            freshness: 'fresh',
          },
        },
      },
    }));
  });
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async () => {
    requestCount++;
    throw new Error('fresh cache should satisfy selection');
  };

  try {
    const response = await invoke(state.controller, { lat: '43.6', lon: '12.5' });
    assert.equal(response.body.source, 'dias');
    assert.equal(response.body.selectionMode, 'auto');
    assert.equal(response.body.station.ursiCode, 'RO041');
    assert.equal(response.body.cached, true);
    assert.ok(response.body.ageMinutes <= 30);
    assert.equal(requestCount, 0);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('automatic selection does not treat a cached DIAS observation over 30 minutes as operational', async () => {
  const state = createController('hybrid', ({ diasCacheFile }) => {
    const cachedAt = new Date().toISOString();
    fs.writeFileSync(diasCacheFile, JSON.stringify({
      version: 1,
      stations: {
        RO041: {
          cachedAt,
          data: {
            source: 'dias',
            station: { ursiCode: 'RO041', name: 'ROME', distanceKm: null },
            measuredAt: new Date(Date.now() - 40 * 60000).toISOString(),
            foF2: 6.5,
            muf: 24,
            mufFactor: 3.5,
            hF2: 250,
            foEs: 2.2,
            confidence: null,
            ageMinutes: 40,
            freshness: 'fresh',
          },
        },
      },
    }));
  });
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    if (url.includes('electron.space.noa.gr')) {
      return { status: 200, data: makeDiasPayload(40, 'RO041') };
    }
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const response = await invoke(state.controller, { lat: '43.6', lon: '12.5' });
    assert.equal(response.body.source, 'giro');
    assert.equal(response.body.station.ursiCode, 'RO041');
    assert.equal(response.body.cached, false);
    assert.equal(requestedUrls.length, 2);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('concurrent automatic requests coalesce provider requests by station', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async (url, config) => {
    requestCount++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const code = config.params.get('stations');
    return { status: 200, data: makeDiasPayload(2, code) };
  };

  try {
    const responses = await Promise.all([
      invoke(state.controller, { lat: '43.6', lon: '12.5' }),
      invoke(state.controller, { lat: '43.6', lon: '12.5' }),
    ]);
    assert.equal(requestCount, 1);
    assert.ok(responses.every((response) => response.body.source === 'dias'));
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('provider caches remain isolated when the configured provider changes', async () => {
  const state = createController('dias');
  const originalGet = axios.get;
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);
    if (url.includes('electron.space.noa.gr')) {
      return { status: 200, data: makeDiasPayload() };
    }
    return { status: 200, data: makeGiroResponse() };
  };

  try {
    const diasResponse = await invoke(state.controller, { station: 'EB040' });
    process.env.IONOSPHERE_PROVIDER = 'giro';
    const giroResponse = await invoke(state.controller, { station: 'EB040' });
    process.env.IONOSPHERE_PROVIDER = 'dias';
    const diasCachedResponse = await invoke(state.controller, { station: 'EB040' });

    assert.equal(diasResponse.body.source, 'dias');
    assert.equal(giroResponse.body.source, 'giro');
    assert.equal(diasCachedResponse.body.source, 'dias');
    assert.equal(diasCachedResponse.body.cached, true);
    assert.equal(requestedUrls.length, 2);
    assert.ok(fs.existsSync(path.join(state.tempDirectory, 'giro-cache.json')));
    assert.ok(fs.existsSync(path.join(state.tempDirectory, 'dias-cache.json')));
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('legacy giro-cache.json entries remain GIRO-only and retain their format', async () => {
  const state = createController('giro', ({ giroCacheFile }) => {
    const cachedAt = new Date().toISOString();
    fs.writeFileSync(giroCacheFile, JSON.stringify({
      version: 1,
      updatedAt: cachedAt,
      stations: {
        EB040: {
          cachedAt,
          data: {
            station: { ursiCode: 'EB040', name: 'ROQUETES', distanceKm: null },
            measuredAt: cachedAt,
            foF2: 6.1,
            muf: 20,
            mufFactor: 3,
            hF2: 240,
            foEs: 2,
            confidence: 5,
            ageMinutes: 0,
            freshness: 'fresh',
          },
        },
      },
    }));
  });
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async () => {
    requestCount++;
    throw new Error('must serve the legacy cache');
  };

  try {
    const response = await invoke(state.controller, { station: 'EB040' });
    const persisted = JSON.parse(fs.readFileSync(
      path.join(state.tempDirectory, 'giro-cache.json'),
      'utf8'
    ));

    assert.equal(response.body.cached, true);
    assert.equal(response.body.source, 'giro');
    assert.equal(response.body.foF2, 6.1);
    assert.equal(requestCount, 0);
    assert.equal(persisted.version, 1);
    assert.equal(fs.existsSync(path.join(state.tempDirectory, 'dias-cache.json')), false);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('hybrid serves the newest provider-specific stale cache when both providers fail', async () => {
  const state = createController('hybrid', ({ giroCacheFile, diasCacheFile }) => {
    const cachedAt = new Date(Date.now() - 20 * 60000).toISOString();
    const createData = (ageMinutes, source) => ({
      source,
      station: { ursiCode: 'EB040', name: 'ROQUETES', distanceKm: null },
      measuredAt: new Date(Date.now() - ageMinutes * 60000).toISOString(),
      foF2: source === 'dias' ? 6.5 : 6.2,
      muf: 24,
      mufFactor: 3.5,
      hF2: null,
      foEs: 2.2,
      confidence: source === 'dias' ? null : 4,
      ageMinutes,
      freshness: 'old',
    });
    const writeCache = (file, source, ageMinutes) => fs.writeFileSync(file, JSON.stringify({
      version: 1,
      stations: {
        EB040: { cachedAt, data: createData(ageMinutes, source) },
      },
    }));

    writeCache(diasCacheFile, 'dias', 240);
    writeCache(giroCacheFile, 'giro', 300);
  });
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async () => {
    requestCount++;
    throw new Error('provider unavailable');
  };

  try {
    const response = await invoke(state.controller, { station: 'EB040' });
    assert.equal(requestCount, 2);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.source, 'dias');
    assert.equal(response.body.sourceStatus, 'unavailable');
    assert.equal(response.body.cached, true);
    assert.equal(response.body.foF2, 6.5);
    assert.equal(response.body.freshness, 'old');
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('exclusive DIAS rejects an unsupported manual station and never calls GIRO', async () => {
  const state = createController('dias');
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async () => {
    requestCount++;
    throw new Error('must not request');
  };

  try {
    const explicit = await invoke(state.controller, { station: 'AH223' });

    assert.equal(explicit.statusCode, 422);
    assert.equal(explicit.body.station, 'AH223');
    assert.deepEqual(explicit.body.supportedStations.sort(), [
      'AT138', 'DB049', 'EA036', 'EB040', 'JR055',
      'PQ052', 'RL052', 'RO041', 'SO148', 'TR170',
    ].sort());
    assert.equal(requestCount, 0);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('an automatic DIAS observation over 30 minutes triggers GIRO fallback', async () => {
  const state = createController('hybrid');
  const originalGet = axios.get;
  let requestCount = 0;
  try {
    axios.get = async (url) => {
      requestCount++;
      return url.includes('electron.space.noa.gr')
        ? { status: 200, data: makeDiasPayload(45, 'RO041') }
        : { status: 200, data: makeGiroResponse() };
    };
    const response = await invoke(state.controller, { lat: '43.6', lon: '12.5' });

    assert.equal(response.body.source, 'giro');
    assert.equal(response.body.selectionMode, 'auto');
    assert.equal(response.body.station.ursiCode, 'RO041');
    assert.equal(requestCount, 2);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});

test('station selector retains the complete catalog in every provider mode', () => {
  const state = createController('dias');
  const captureStations = (controller) => {
    const response = { json(value) { this.body = value; return this; } };
    controller.getStations({}, response);
    return response.body;
  };

  try {
    const diasStations = captureStations(state.controller);
    assert.ok(diasStations.length > 10);
    assert.ok(diasStations.some(({ ursi }) => !diasServiceStations.has(ursi)));
    assert.equal(new Set(diasStations.map(({ ursi }) => ursi)).size, diasStations.length);

    process.env.IONOSPHERE_PROVIDER = 'hybrid';
    delete require.cache[controllerPath];
    const hybridController = require('./ionosphereController');
    assert.equal(captureStations(hybridController).length, diasStations.length);
  } finally {
    state.restore();
  }
});

test('an unknown provider configuration is rejected without calling either provider', async () => {
  const state = createController('other');
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async () => {
    requestCount++;
    throw new Error('must not request');
  };

  try {
    const response = await invoke(state.controller, { station: 'EB040' });
    assert.equal(response.statusCode, 500);
    assert.match(response.body.error, /IONOSPHERE_PROVIDER/);
    assert.equal(requestCount, 0);
  } finally {
    axios.get = originalGet;
    state.restore();
  }
});
