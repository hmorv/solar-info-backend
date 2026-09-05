const express = require('express');
const { registerDevice } = require('../controllers/pushController');

const router = express.Router();

router.post('/devices', registerDevice);

module.exports = router;