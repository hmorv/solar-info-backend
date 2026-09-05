-- DXSun - Push alerts schema
--
-- Adds the tables required to associate a DXSun installation with its
-- push-notification token and to store the alarms evaluated by the backend.
--
-- Intended to be executed once against the existing `dxsun` database.
-- Safe to re-run while the tables already exist (CREATE TABLE IF NOT EXISTS).

USE `dxsun`;

-- -----------------------------------------------------------------------------
-- Push-enabled app installations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `push_devices` (
  `installation_id` CHAR(36) NOT NULL,
  `push_token` VARCHAR(512) DEFAULT NULL,
  `platform` VARCHAR(20) DEFAULT NULL,
  `language` VARCHAR(10) NOT NULL DEFAULT 'en',
  `notifications_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (`installation_id`),
  KEY `idx_push_devices_enabled` (`notifications_enabled`),
  KEY `idx_push_devices_language` (`language`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci;

-- -----------------------------------------------------------------------------
-- User-configured solar alarms
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `alarms` (
  `id` CHAR(36) NOT NULL,
  `installation_id` CHAR(36) NOT NULL,
  `parameter` VARCHAR(40) NOT NULL,
  `condition_type` VARCHAR(16) NOT NULL,
  `threshold_value` VARCHAR(32) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,

  -- Used to notify only when a condition changes from false to true.
  `last_state` TINYINT(1) NOT NULL DEFAULT 0,
  `last_triggered_at` DATETIME DEFAULT NULL,

  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  KEY `idx_alarms_installation` (`installation_id`),
  KEY `idx_alarms_evaluation` (`enabled`, `parameter`),

  CONSTRAINT `fk_alarms_push_device`
    FOREIGN KEY (`installation_id`)
    REFERENCES `push_devices` (`installation_id`)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_general_ci;