const express = require('express');

const {
  createAlarm,
  getAlarmsByInstallation,
  updateAlarm,
  deleteAlarm,
} = require('../controllers/alarmsController');

const router = express.Router();

router.post('/', createAlarm);
router.get('/:installationId', getAlarmsByInstallation);
router.patch('/:id', updateAlarm);
router.delete('/:id', deleteAlarm);

module.exports = router;