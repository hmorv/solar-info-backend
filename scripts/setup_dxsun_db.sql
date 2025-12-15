-- 1) Índices para acelerar consultas

ALTER TABLE solar_readings
  ADD INDEX idx_timestamp (`timestamp`);

ALTER TABLE vhf_conditions
  ADD INDEX idx_reading_id (reading_id);

ALTER TABLE band_conditions
  ADD INDEX idx_reading_id (reading_id);


-- 2) Tabla de archivo para mantener histórico completo de solar_readings

CREATE TABLE IF NOT EXISTS solar_readings_archive LIKE solar_readings;


-- 3) Limpiar eventos anteriores (por si reejecutas)

DROP EVENT IF EXISTS ev_archive_solar_readings_insert;
DROP EVENT IF EXISTS ev_archive_solar_readings_delete;
DROP EVENT IF EXISTS ev_archive_solar_readings_optimize;
DROP EVENT IF EXISTS ev_purge_vhf_conditions;
DROP EVENT IF EXISTS ev_purge_band_conditions;


-- 4) Crear eventos nuevos

DELIMITER $$

-- Mover a archivo todo lo que tenga más de 12 meses
CREATE EVENT ev_archive_solar_readings_insert
ON SCHEDULE EVERY 1 MONTH
DO
  INSERT INTO solar_readings_archive
  SELECT *
  FROM solar_readings
  WHERE `timestamp` < NOW() - INTERVAL 12 MONTH$$


-- Borrar de la tabla principal esos registros antiguos
CREATE EVENT ev_archive_solar_readings_delete
ON SCHEDULE EVERY 1 MONTH
DO
  DELETE FROM solar_readings
  WHERE `timestamp` < NOW() - INTERVAL 12 MONTH$$


-- Optimizar tabla principal
CREATE EVENT ev_archive_solar_readings_optimize
ON SCHEDULE EVERY 1 MONTH
DO
  OPTIMIZE TABLE solar_readings$$


-- Purgar vhf_conditions (>60 días, según timestamp del reading)
CREATE EVENT ev_purge_vhf_conditions
ON SCHEDULE EVERY 1 MONTH
DO
BEGIN
  DELETE vc
  FROM vhf_conditions vc
  JOIN solar_readings sr ON vc.reading_id = sr.id
  WHERE sr.`timestamp` < NOW() - INTERVAL 60 DAY;

  OPTIMIZE TABLE vhf_conditions;
END$$


-- Purgar band_conditions (>60 días, según timestamp del reading)
CREATE EVENT ev_purge_band_conditions
ON SCHEDULE EVERY 1 MONTH
DO
BEGIN
  DELETE bc
  FROM band_conditions bc
  JOIN solar_readings sr ON bc.reading_id = sr.id
  WHERE sr.`timestamp` < NOW() - INTERVAL 60 DAY;

  OPTIMIZE TABLE band_conditions;
END$$

DELIMITER ;
