require('dotenv').config(); // Carga las variables de entorno
const express = require('express');
const morgan = require('morgan');
const helmet = require('helmet');

const logger = require('./config/logger');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 peticiones por minuto
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(helmet());

//  Log personalizado con IP real y timestamp ISO, usando winston
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

// Importar y usar las rutas de la API solar
const solarRoutes = require('./routes/solar');
app.use('/api/solar', solarRoutes);

// Importar y usar las rutas de la API ionosférica
const ionosphereRoutes = require('./routes/ionosphere');
app.use('/api/ionosphere', ionosphereRoutes);

app.listen(PORT, HOST, () => {
  logger.info(`🌞 Servidor solar en http://${HOST}:${PORT}`);
});
