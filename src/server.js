require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const logger = require('./config/logger');

const solarRoutes = require('./routes/solar');
const ionosphereRoutes = require('./routes/ionosphere');

const app = express();

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

app.use(
  morgan(
    ':remote-addr - :remote-user [:date[iso]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"',
    {
      stream: {
        write: (message) => logger.info(message.trim()),
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