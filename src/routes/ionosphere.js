// Rutas para la API ionosférica
const express = require('express');
const router = express.Router();
const { query, validationResult } = require('express-validator');

const ionosphereController = require('../controllers/ionosphereController');

// GET /api/ionosphere/hf
// Parámetros: lat (latitud), lon (longitud)
router.get(
  '/hf',
  [
    query('lat').isFloat({ min: -90, max: 90 }).notEmpty().withMessage('lat must be between -90 and 90'),
    query('lon').isFloat({ min: -180, max: 360 }).notEmpty().withMessage('lon must be between -180 and 360'),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  ionosphereController.getHFData
);

module.exports = router;
