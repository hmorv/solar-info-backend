// Configuración de winston con rotación de logs
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const logPath = process.env.LOG_PATH || './solar-api-access.log';

const dailyRotateFileTransport = new transports.DailyRotateFile({
  filename: logPath.replace(/\.log$/, '') + '-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '60d',
  level: 'info',
});

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    }),
    dailyRotateFileTransport,
  ],
  exitOnError: false,
});

module.exports = logger;
