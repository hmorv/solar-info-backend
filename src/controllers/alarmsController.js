const { getConnection } = require('../config/mysql');

const ALLOWED_PARAMETERS = new Set([
  'solarflux',
  'aindex',
  'kindex',
  'xray',
  'sunspots',
  'heliumline',
  'protonflux',
  'electronflux',
  'aurora',
  'normalization',
  'latdegree',
  'solarwind',
  'magneticfield',
]);

const ALLOWED_CONDITIONS = new Set([
  'greater',
  'less',
]);

const XRAY_PATTERN = /^[ABCXM](?:\d+(?:\.\d+)?)$/i;

function normalizeParameter(parameter) {
  return String(parameter || '')
    .toLowerCase()
    .replace(/[-_ ]/g, '');
}

function isValidId(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 64
  );
}

function isValidParameter(parameter) {
  return ALLOWED_PARAMETERS.has(
    normalizeParameter(parameter)
  );
}

function isValidCondition(condition) {
  return ALLOWED_CONDITIONS.has(condition);
}

function isValidEnabled(enabled) {
  return typeof enabled === 'boolean';
}

function isValidNumericValue(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return false;
  }

  return Number.isFinite(Number(value));
}

function isValidXrayValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  return XRAY_PATTERN.test(
    String(value).trim()
  );
}

function isValidAlarmValue(parameter, value) {
  if (normalizeParameter(parameter) === 'xray') {
    return isValidXrayValue(value);
  }

  return isValidNumericValue(value);
}

function normalizeAlarmValue(parameter, value) {
  if (normalizeParameter(parameter) === 'xray') {
    return String(value)
      .trim()
      .toUpperCase();
  }

  return String(Number(value));
}

async function createAlarm(req, res, next) {
  const {
    id,
    installationId,
    parameter,
    condition,
    value,
    enabled = true,
  } = req.body;

  if (
    !id ||
    !installationId ||
    !parameter ||
    !condition ||
    value === undefined
  ) {
    return res.status(400).json({
      error:
        'id, installationId, parameter, condition and value are required',
    });
  }

  if (!isValidId(id)) {
    return res.status(400).json({
      error: 'Invalid alarm id',
    });
  }

  if (!isValidId(installationId)) {
    return res.status(400).json({
      error: 'Invalid installationId',
    });
  }

  if (!isValidParameter(parameter)) {
    return res.status(400).json({
      error: 'Unsupported alarm parameter',
    });
  }

  if (!isValidCondition(condition)) {
    return res.status(400).json({
      error: 'condition must be greater or less',
    });
  }

  if (!isValidAlarmValue(parameter, value)) {
    return res.status(400).json({
      error:
        normalizeParameter(parameter) === 'xray'
          ? 'Invalid X-Ray value'
          : 'Alarm value must be numeric',
    });
  }

  if (!isValidEnabled(enabled)) {
    return res.status(400).json({
      error: 'enabled must be a boolean',
    });
  }

  const normalizedValue =
    normalizeAlarmValue(parameter, value);

  let connection;

  try {
    connection = await getConnection();

    await connection.execute(
      `
        INSERT INTO alarms (
          id,
          installation_id,
          parameter,
          condition_type,
          threshold_value,
          enabled
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        installationId,
        parameter,
        condition,
        normalizedValue,
        enabled ? 1 : 0,
      ]
    );

    return res.status(201).json({
      id,
      installationId,
      parameter,
      condition,
      value: normalizedValue,
      enabled,
    });
  } catch (error) {
    next(error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

async function getAlarmsByInstallation(req, res, next) {
  const { installationId } = req.params;

  if (!isValidId(installationId)) {
    return res.status(400).json({
      error: 'Invalid installationId',
    });
  }

  let connection;

  try {
    connection = await getConnection();

    const [rows] = await connection.execute(
      `
        SELECT
          id,
          installation_id,
          parameter,
          condition_type,
          threshold_value,
          enabled,
          last_state,
          last_triggered_at,
          created_at,
          updated_at
        FROM alarms
        WHERE installation_id = ?
        ORDER BY created_at ASC
      `,
      [installationId]
    );

    const alarms = rows.map((row) => ({
      id: row.id,
      installationId: row.installation_id,
      parameter: row.parameter,
      condition: row.condition_type,
      value: row.threshold_value,
      enabled: Boolean(row.enabled),
      lastState: Boolean(row.last_state),
      lastTriggeredAt: row.last_triggered_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return res.json(alarms);
  } catch (error) {
    next(error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

async function updateAlarm(req, res, next) {
  const { id } = req.params;

  const {
    parameter,
    condition,
    value,
    enabled,
  } = req.body;

  if (!isValidId(id)) {
    return res.status(400).json({
      error: 'Invalid alarm id',
    });
  }

  if (
    condition !== undefined &&
    !isValidCondition(condition)
  ) {
    return res.status(400).json({
      error: 'condition must be greater or less',
    });
  }

  if (
    enabled !== undefined &&
    !isValidEnabled(enabled)
  ) {
    return res.status(400).json({
      error: 'enabled must be a boolean',
    });
  }

  if (
    parameter !== undefined &&
    !isValidParameter(parameter)
  ) {
    return res.status(400).json({
      error: 'Unsupported alarm parameter',
    });
  }

  let connection;

  try {
    connection = await getConnection();

    let effectiveParameter = parameter;

    /*
     * If value is updated without parameter,
     * use the current parameter to validate it.
     */
    if (
      value !== undefined &&
      parameter === undefined
    ) {
      const [rows] = await connection.execute(
        `
          SELECT parameter
          FROM alarms
          WHERE id = ?
          LIMIT 1
        `,
        [id]
      );

      if (!rows.length) {
        return res.status(404).json({
          error: 'Alarm not found',
        });
      }

      effectiveParameter = rows[0].parameter;
    }

    if (
      value !== undefined &&
      !isValidAlarmValue(
        effectiveParameter,
        value
      )
    ) {
      return res.status(400).json({
        error:
          normalizeParameter(effectiveParameter) === 'xray'
            ? 'Invalid X-Ray value'
            : 'Alarm value must be numeric',
      });
    }

    /*
     * If only the parameter changes, make sure
     * the existing threshold is valid for it.
     */
    if (
      parameter !== undefined &&
      value === undefined
    ) {
      const [rows] = await connection.execute(
        `
          SELECT threshold_value
          FROM alarms
          WHERE id = ?
          LIMIT 1
        `,
        [id]
      );

      if (!rows.length) {
        return res.status(404).json({
          error: 'Alarm not found',
        });
      }

      if (
        !isValidAlarmValue(
          parameter,
          rows[0].threshold_value
        )
      ) {
        return res.status(400).json({
          error:
            'Existing alarm value is not valid for the new parameter',
        });
      }
    }

    const fields = [];
    const values = [];

    let shouldResetState = false;

    if (parameter !== undefined) {
      fields.push('parameter = ?');

      // Preserve the parameter name sent by the frontend.
      values.push(parameter);

      shouldResetState = true;
    }

    if (condition !== undefined) {
      fields.push('condition_type = ?');
      values.push(condition);

      shouldResetState = true;
    }

    if (value !== undefined) {
      fields.push('threshold_value = ?');

      values.push(
        normalizeAlarmValue(
          effectiveParameter,
          value
        )
      );

      shouldResetState = true;
    }

    if (enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(enabled ? 1 : 0);

      /*
       * Re-enabling an alarm rearms it so that
       * an already-active condition can trigger.
       */
      if (enabled) {
        shouldResetState = true;
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({
        error: 'No fields to update',
      });
    }

    if (shouldResetState) {
      fields.push('last_state = ?');
      values.push(0);
    }

    const [result] = await connection.execute(
      `
        UPDATE alarms
        SET ${fields.join(', ')}
        WHERE id = ?
      `,
      [...values, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'Alarm not found',
      });
    }

    return res.json({
      id,
      updated: true,
    });
  } catch (error) {
    next(error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

async function deleteAlarm(req, res, next) {
  const { id } = req.params;

  if (!isValidId(id)) {
    return res.status(400).json({
      error: 'Invalid alarm id',
    });
  }

  let connection;

  try {
    connection = await getConnection();

    const [result] = await connection.execute(
      `
        DELETE FROM alarms
        WHERE id = ?
      `,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'Alarm not found',
      });
    }

    return res.status(204).send();
  } catch (error) {
    next(error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

module.exports = {
  createAlarm,
  getAlarmsByInstallation,
  updateAlarm,
  deleteAlarm,
};