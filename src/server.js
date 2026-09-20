require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const logger = require('./config/logger');

const solarRoutes = require('./routes/solar');
const ionosphereRoutes = require('./routes/ionosphere');
const pushRoutes = require('./routes/push');
const alarmsRoutes = require('./routes/alarms');

const app = express();

function getTelemetryHeader(req, name) {
  const value = req.get(name);

  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, 128) : null;
}

function getInstallId(req) {
  const installId = getTelemetryHeader(req, 'X-DXSun-Install-ID');

  return installId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installId)
    ? installId
    : null;
}

app.set('trust proxy', true);
app.disable('x-powered-by');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet());
app.use(cors());
app.use(express.json());


app.use(
  morgan(
    (tokens, req, res) => JSON.stringify({
      remoteAddr: tokens['remote-addr'](req, res),
      remoteUser: tokens['remote-user'](req, res),
      date: tokens.date(req, res, 'iso'),
      method: tokens.method(req, res),
      url: tokens.url(req, res),
      httpVersion: tokens['http-version'](req, res),
      status: Number(tokens.status(req, res)),
      contentLength: tokens.res(req, res, 'content-length'),
      referrer: tokens.referrer(req, res),
      userAgent: tokens['user-agent'](req, res),
      version: getTelemetryHeader(req, 'X-DXSun-Version'),
      build: getTelemetryHeader(req, 'X-DXSun-Build'),
      platform: getTelemetryHeader(req, 'X-DXSun-Platform'),
      installId: getInstallId(req),
    }),
    {
      stream: {
        write: (message) => logger.info('HTTP request', JSON.parse(message)),
      },
    }
  )
);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api', limiter);

app.use('/api/solar', solarRoutes);
app.use('/api/ionosphere', ionosphereRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/alarms', alarmsRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  logger.error(err.stack || err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});


app.listen(PORT, HOST, () => {
  logger.info(`🌞 Servidor solar en http://${HOST}:${PORT}`);
});