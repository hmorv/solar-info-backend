// Configuración de la base de datos MySQL
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'dxsun',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'dxsun',
};

module.exports = dbConfig;
