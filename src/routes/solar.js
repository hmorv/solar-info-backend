// Rutas para la API solar
const express = require('express');
const router = express.Router();
const { query, validationResult } = require('express-validator');

const solarController = require('../controllers/solarController');

router.get('/last', solarController.getLast);

// Validación básica para /history
router.get(
  '/history',
  [
    query('param').isString().trim().notEmpty(),
    query('range').optional().isIn(['3d', '7d', '1d', '24h']),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  solarController.getHistory
);
// Temporal: sin validación hasta instalar express-validator
router.get('/history', solarController.getHistory);

module.exports = router;
