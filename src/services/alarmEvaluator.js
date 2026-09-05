const { getConnection } = require('../config/mysql');
const logger = require('../config/logger');
const { sendAlarmNotification } = require('./pushService');

function normalizeParameter(parameter) {
  return String(parameter || '')
    .toLowerCase()
    .replace(/[-_ ]/g, '');
}

function getReadingValue(reading, parameter) {
  const key = normalizeParameter(parameter);

  const mapping = {
    solarflux: reading.solarFlux,
    aindex: reading.aIndex,
    kindex: reading.kIndex,
    xray: reading.xRay,
    sunspots: reading.sunspots,
    heliumline: reading.heliumLine,
    protonflux: reading.protonFlux,
    electronflux: reading.electronFlux,
    aurora: reading.aurora,
    normalization: reading.normalization,
    latdegree: reading.latDegree,
    solarwind: reading.solarWind,
    magneticfield: reading.magneticField,
  };

  return mapping[key];
}

function compareXray(
  currentValue,
  thresholdValue,
  condition
) {
  if (!['greater', 'less'].includes(condition)) {
    return false;
  }

  const xrayOrder = ['A', 'B', 'C', 'M', 'X'];

  const parseXray = (value) => {
    const match = String(value || '')
      .toUpperCase()
      .match(/^([ABCXM])(\d+(?:\.\d+)?)?$/);

    if (!match) {
      return null;
    }

    return {
      classIndex: xrayOrder.indexOf(match[1]),
      magnitude: parseFloat(match[2] || '0'),
    };
  };

  const current = parseXray(currentValue);
  const threshold = parseXray(thresholdValue);

  if (!current || !threshold) {
    return false;
  }

  let comparison =
    current.classIndex - threshold.classIndex;

  if (comparison === 0) {
    comparison =
      current.magnitude - threshold.magnitude;
  }

  return condition === 'greater'
    ? comparison >= 0
    : comparison <= 0;
}

function matchesAlarm(alarm, currentValue) {
  if (
    currentValue === null ||
    currentValue === undefined
  ) {
    return false;
  }

  if (
    !['greater', 'less'].includes(
      alarm.condition_type
    )
  ) {
    logger.warn(
      `Invalid condition type for alarm ${alarm.id}: ${alarm.condition_type}`
    );

    return false;
  }

  if (
    normalizeParameter(alarm.parameter) ===
    'xray'
  ) {
    return compareXray(
      currentValue,
      alarm.threshold_value,
      alarm.condition_type
    );
  }

  const current = Number(currentValue);
  const threshold =
    Number(alarm.threshold_value);

  if (
    Number.isNaN(current) ||
    Number.isNaN(threshold)
  ) {
    return false;
  }

  return alarm.condition_type === 'greater'
    ? current >= threshold
    : current <= threshold;
}

async function evaluateSolarAlarms(reading) {
  let connection;

  try {
    connection = await getConnection();

    const [alarms] =
      await connection.execute(`
        SELECT
          id,
          installation_id,
          parameter,
          condition_type,
          threshold_value,
          last_state
        FROM alarms
        WHERE enabled = 1
      `);

    for (const alarm of alarms) {
      const currentValue = getReadingValue(
        reading,
        alarm.parameter
      );

      const currentState = matchesAlarm(
        alarm,
        currentValue
      );

      const previousState =
        Boolean(alarm.last_state);

      /*
       * The condition is no longer met.
       *
       * Rearm the alarm if it had previously
       * been successfully notified.
       */
      if (!currentState) {
        if (previousState) {
          await connection.execute(
            `
              UPDATE alarms
              SET last_state = 0
              WHERE id = ?
            `,
            [alarm.id]
          );

          logger.info(
            `Alarm rearmed: ${alarm.parameter} ${alarm.condition_type} ${alarm.threshold_value}`
          );
        }

        continue;
      }

      /*
       * The condition is met, but this alarm
       * has already been successfully notified
       * during the current active condition.
       */
      if (previousState) {
        continue;
      }

      /*
       * The condition is met and has not yet
       * been successfully notified.
       */
      const pushResult =
        await sendAlarmNotification(
          alarm,
          currentValue
        );

      /*
       * Keep last_state = 0 whenever the push
       * has not been successfully delivered to
       * FCM.
       *
       * This allows the alarm to be retried on
       * a future collector cycle.
       *
       * Expected device states such as disabled
       * notifications or a missing token are not
       * logged here on every cycle.
       */
      if (pushResult.status !== 'sent') {
        if (pushResult.status === 'failed') {
          logger.warn(
            `Alarm ${alarm.id} remains pending after push failure`
          );
        }

        continue;
      }

      /*
       * Only mark the alarm as triggered after
       * FCM successfully accepts the notification.
       */
      await connection.execute(
        `
          UPDATE alarms
          SET
            last_state = 1,
            last_triggered_at = NOW()
          WHERE id = ?
        `,
        [alarm.id]
      );

      logger.info(
        `🔔 Alarm triggered and notified: ${alarm.parameter} ${alarm.condition_type} ${alarm.threshold_value} (current: ${currentValue})`
      );
    }
  } catch (error) {
    logger.error(
      `Alarm evaluation failed: ${error.message}`
    );
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

module.exports = {
  evaluateSolarAlarms,
};