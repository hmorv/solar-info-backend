// Inicialización de la conexión a la base de datos MySQL
const mysql = require('mysql2/promise');
const dbConfig = require('./db');

async function getConnection() {
  return await mysql.createConnection(dbConfig);
}

module.exports = { getConnection };
