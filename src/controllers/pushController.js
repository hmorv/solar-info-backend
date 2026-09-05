const { getConnection } = require('../config/mysql');

const ALLOWED_PLATFORMS = new Set([
  'android',
  'ios',
]);

const ALLOWED_LANGUAGES = new Set([
  'en',
  'es',
  'ca',
  'de',
  'eu',
  'gl',
  'it',
  'pt',
  'ru',
]);

function isValidInstallationId(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 64
  );
}

function isValidPushToken(value) {
  return (
    value === null ||
    (
      typeof value === 'string' &&
      value.trim().length > 0
    )
  );
}

function isValidPlatform(value) {
  return (
    value === null ||
    ALLOWED_PLATFORMS.has(value)
  );
}

function isValidLanguage(value) {
  return (
    value === undefined ||
    (
      typeof value === 'string' &&
      ALLOWED_LANGUAGES.has(
        value.toLowerCase()
      )
    )
  );
}

function isValidNotificationsEnabled(value) {
  return typeof value === 'boolean';
}

async function registerDevice(req, res, next) {
  const {
    installationId,
    pushToken = null,
    platform = null,
    language,
    notificationsEnabled,
  } = req.body;

  if (!isValidInstallationId(installationId)) {
    return res.status(400).json({
      error: 'Invalid installationId',
    });
  }

  if (!isValidPushToken(pushToken)) {
    return res.status(400).json({
      error: 'Invalid pushToken',
    });
  }

  if (!isValidPlatform(platform)) {
    return res.status(400).json({
      error: 'platform must be android or ios',
    });
  }

  if (!isValidLanguage(language)) {
    return res.status(400).json({
      error: 'Unsupported language',
    });
  }

  if (
    notificationsEnabled !== undefined &&
    !isValidNotificationsEnabled(
      notificationsEnabled
    )
  ) {
    return res.status(400).json({
      error:
        'notificationsEnabled must be a boolean',
    });
  }

  let connection;

  try {
    connection = await getConnection();

    /*
     * For a new installation, default notifications_enabled
     * to false unless the client explicitly says otherwise.
     */
    const initialNotificationsEnabled =
      notificationsEnabled === true ? 1 : 0;

    /*
     * For a new installation, default language to English
     * if the client has not provided one.
     */
    const initialLanguage =
      language?.toLowerCase() || 'en';

    await connection.execute(
      `
        INSERT INTO push_devices (
          installation_id,
          push_token,
          platform,
          language,
          notifications_enabled,
          last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          push_token = COALESCE(
            VALUES(push_token),
            push_token
          ),
          platform = COALESCE(
            VALUES(platform),
            platform
          ),
          language = CASE
            WHEN ? IS NULL
              THEN language
            ELSE ?
          END,
          notifications_enabled = CASE
            WHEN ? IS NULL
              THEN notifications_enabled
            ELSE ?
          END,
          last_seen_at = NOW()
      `,
      [
        installationId,
        pushToken,
        platform,
        initialLanguage,
        initialNotificationsEnabled,

        language === undefined
          ? null
          : initialLanguage,
        initialLanguage,

        notificationsEnabled === undefined
          ? null
          : notificationsEnabled ? 1 : 0,
        notificationsEnabled === true ? 1 : 0,
      ]
    );

    return res.status(200).json({
      installationId,
      platform,
      language:
        language?.toLowerCase() ?? null,
      notificationsEnabled:
        notificationsEnabled ?? null,
      registered: true,
    });
  } catch (error) {
    next(error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

module.exports = {
  registerDevice,
};