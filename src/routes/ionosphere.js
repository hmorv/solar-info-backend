// Rutas para la API ionosférica
const express = require('express');
const router = express.Router();
const { query, validationResult } = require('express-validator');

const ionosphereController = require('../controllers/ionosphereController');

router.get('/stations', ionosphereController.getStations);

// GET /api/ionosphere/hf
router.get(
  '/hf',
  [
    query('station')
      .optional()
      .isString()
      .trim()
      .notEmpty()
      .withMessage('station must be a valid station id'),
    query('lat')
      .optional()
      .isFloat({ min: -90, max: 90 })
      .withMessage('lat must be between -90 and 90'),
    query('lon')
      .optional()
      .isFloat({ min: -180, max: 360 })
      .withMessage('lon must be between -180 and 360'),
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