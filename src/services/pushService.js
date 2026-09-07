const { getMessaging } = require('../config/firebase');
const logger = require('../config/logger');

const PARAMETER_META = {
  solarflux: {
    unit: 'SFU',
  },

  aindex: {},

  kindex: {},

  xray: {
    type: 'xray',
  },

  sunspots: {},

  heliumline: {},

  protonflux: {},

  electronflux: {},

  aurora: {},

  normalization: {},

  latdegree: {
    unit: '°',
    compactUnit: true,
  },

  solarwind: {
    unit: 'km/s',
  },

  magneticfield: {
    unit: 'nT',
  },
};

const TRANSLATIONS = {
  en: {
    now: 'Now',
    parameters: {
      solarflux: 'Solar Flux',
      aindex: 'A-index',
      kindex: 'K-index',
      xray: 'X-Ray',
      sunspots: 'Sunspots',
      heliumline: 'Helium Line',
      protonflux: 'Proton Flux',
      electronflux: 'Electron Flux',
      aurora: 'Aurora',
      normalization: 'Normalization',
      latdegree: 'Latitude',
      solarwind: 'Solar Wind',
      magneticfield: 'Magnetic Field',
    },
  },

  es: {
    now: 'Actual',
    parameters: {
      solarflux: 'Flujo solar',
      aindex: 'Índice A',
      kindex: 'Índice K',
      xray: 'Rayos X',
      sunspots: 'Manchas solares',
      heliumline: 'Línea de helio',
      protonflux: 'Flujo de protones',
      electronflux: 'Flujo de electrones',
      aurora: 'Aurora',
      normalization: 'Normalización',
      latdegree: 'Latitud',
      solarwind: 'Viento solar',
      magneticfield: 'Campo magnético',
    },
  },

  ca: {
    now: 'Ara',
    parameters: {
      solarflux: 'Flux solar',
      aindex: 'Índex A',
      kindex: 'Índex K',
      xray: 'Raigs X',
      sunspots: 'Taques solars',
      heliumline: 'Línia d’heli',
      protonflux: 'Flux de protons',
      electronflux: 'Flux d’electrons',
      aurora: 'Aurora',
      normalization: 'Normalització',
      latdegree: 'Latitud',
      solarwind: 'Vent solar',
      magneticfield: 'Camp magnètic',
    },
  },

  de: {
    now: 'Aktuell',
    parameters: {
      solarflux: 'Solarer Flux',
      aindex: 'A-Index',
      kindex: 'K-Index',
      xray: 'Röntgenstrahlung',
      sunspots: 'Sonnenflecken',
      heliumline: 'Heliumlinie',
      protonflux: 'Protonenfluss',
      electronflux: 'Elektronenfluss',
      aurora: 'Aurora',
      normalization: 'Normalisierung',
      latdegree: 'Breitengrad',
      solarwind: 'Sonnenwind',
      magneticfield: 'Magnetfeld',
    },
  },

  eu: {
    now: 'Uneko balioa',
    parameters: {
      solarflux: 'Eguzki-fluxua',
      aindex: 'A indizea',
      kindex: 'K indizea',
      xray: 'X izpiak',
      sunspots: 'Eguzki-orbanak',
      heliumline: 'Helio-lerroa',
      protonflux: 'Protoi-fluxua',
      electronflux: 'Elektroi-fluxua',
      aurora: 'Aurora',
      normalization: 'Normalizazioa',
      latdegree: 'Latitudea',
      solarwind: 'Eguzki-haizea',
      magneticfield: 'Eremu magnetikoa',
    },
  },

  gl: {
    now: 'Actual',
    parameters: {
      solarflux: 'Fluxo solar',
      aindex: 'Índice A',
      kindex: 'Índice K',
      xray: 'Raios X',
      sunspots: 'Manchas solares',
      heliumline: 'Liña de helio',
      protonflux: 'Fluxo de protóns',
      electronflux: 'Fluxo de electróns',
      aurora: 'Aurora',
      normalization: 'Normalización',
      latdegree: 'Latitude',
      solarwind: 'Vento solar',
      magneticfield: 'Campo magnético',
    },
  },

  it: {
    now: 'Attuale',
    parameters: {
      solarflux: 'Flusso solare',
      aindex: 'Indice A',
      kindex: 'Indice K',
      xray: 'Raggi X',
      sunspots: 'Macchie solari',
      heliumline: 'Linea dell’elio',
      protonflux: 'Flusso di protoni',
      electronflux: 'Flusso di elettroni',
      aurora: 'Aurora',
      normalization: 'Normalizzazione',
      latdegree: 'Latitudine',
      solarwind: 'Vento solare',
      magneticfield: 'Campo magnetico',
    },
  },

  pt: {
    now: 'Atual',
    parameters: {
      solarflux: 'Fluxo solar',
      aindex: 'Índice A',
      kindex: 'Índice K',
      xray: 'Raios X',
      sunspots: 'Manchas solares',
      heliumline: 'Linha de hélio',
      protonflux: 'Fluxo de protões',
      electronflux: 'Fluxo de eletrões',
      aurora: 'Aurora',
      normalization: 'Normalização',
      latdegree: 'Latitude',
      solarwind: 'Vento solar',
      magneticfield: 'Campo magnético',
    },
  },

  ru: {
    now: 'Сейчас',
    parameters: {
      solarflux: 'Солнечный поток',
      aindex: 'A-индекс',
      kindex: 'K-индекс',
      xray: 'Рентгеновское излучение',
      sunspots: 'Солнечные пятна',
      heliumline: 'Линия гелия',
      protonflux: 'Поток протонов',
      electronflux: 'Поток электронов',
      aurora: 'Полярное сияние',
      normalization: 'Нормализация',
      latdegree: 'Широта',
      solarwind: 'Солнечный ветер',
      magneticfield: 'Магнитное поле',
    },
  },
};

const INVALID_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

async function sendAlarmNotification(
  alarm,
  currentValue,
  device
) {
  /*
   * Device information is loaded by alarmEvaluator
   * together with the alarm itself.
   *
   * pushService is deliberately database-agnostic:
   * its responsibility is only deciding whether a
   * push can be attempted and sending it through FCM.
   */
  if (!device?.exists) {
    return {
      status: 'no-device',
    };
  }

  if (!device.notificationsEnabled) {
    return {
      status: 'disabled',
    };
  }

  if (!device.pushToken) {
    return {
      status: 'no-token',
    };
  }

  const language =
    normalizeLanguage(device.language);

  const message = {
    token: device.pushToken,

    notification: {
      title: 'DXSun',
      body: buildAlarmMessage(
        alarm,
        currentValue,
        language
      ),
    },

    data: {
      type: 'solar-alarm',
      alarmId: String(alarm.id),
      parameter: String(alarm.parameter),
      condition: String(
        alarm.condition_type
      ),
      threshold: String(
        alarm.threshold_value
      ),
      currentValue: String(
        currentValue
      ),
      language,
    },

    android: {
      priority: 'high',
      ttl: 30 * 60 * 1000,

      notification: {
        channelId: 'dxsun_alerts',
      },
    },
  };

  try {
    const response =
      await getMessaging().send(message);

    logger.info(
      `Push sent for alarm ${alarm.id}: ${response}`
    );

    return {
      status: 'sent',
      messageId: response,
    };
  } catch (error) {
    if (isInvalidTokenError(error)) {
      /*
       * Do not access the database here.
       *
       * alarmEvaluator receives this status and is
       * responsible for clearing the invalid token
       * using the connection it already owns.
       */
      return {
        status: 'invalid-token',
      };
    }

    logger.error(
      `Push notification failed for alarm ${alarm.id}: ${error.message}`
    );

    return {
      status: 'failed',
      error,
    };
  }
}

function buildAlarmMessage(
  alarm,
  currentValue,
  language
) {
  const parameter =
    normalizeParameter(alarm.parameter);

  const translations =
    TRANSLATIONS[language] ||
    TRANSLATIONS.en;

  const label =
    translations.parameters[parameter] ||
    TRANSLATIONS.en.parameters[parameter] ||
    alarm.parameter;

  const operator =
    alarm.condition_type === 'greater'
      ? '≥'
      : '≤';

  const threshold =
    formatParameterValue(
      parameter,
      alarm.threshold_value
    );

  const current =
    formatParameterValue(
      parameter,
      currentValue
    );

  return `${label} ${operator} ${threshold} · ${translations.now}: ${current}`;
}

function formatParameterValue(
  parameter,
  value
) {
  const meta =
    PARAMETER_META[parameter] || {};

  if (meta.type === 'xray') {
    return formatXrayValue(value);
  }

  const formattedValue =
    formatNumericValue(value);

  if (!meta.unit) {
    return formattedValue;
  }

  if (meta.compactUnit) {
    return `${formattedValue}${meta.unit}`;
  }

  return `${formattedValue} ${meta.unit}`;
}

function formatNumericValue(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  /*
   * Avoid unnecessary trailing zeroes while
   * retaining enough precision for solar values.
   *
   * Examples:
   * 534.200 -> 534.2
   * 5.000   -> 5
   * 4.376   -> 4.38
   */
  return Number(
    numericValue.toFixed(2)
  ).toString();
}

function formatXrayValue(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function normalizeParameter(parameter) {
  return String(parameter || '')
    .toLowerCase()
    .replace(/[-_ ]/g, '');
}

function normalizeLanguage(language) {
  const normalized = String(language || 'en')
    .trim()
    .toLowerCase();

  if (TRANSLATIONS[normalized]) {
    return normalized;
  }

  return 'en';
}

function isInvalidTokenError(error) {
  return INVALID_TOKEN_ERRORS.has(
    error?.code
  );
}

module.exports = {
  sendAlarmNotification,
};