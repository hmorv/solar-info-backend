CREATE DATABASE IF NOT EXISTS dxsun;
USE dxsun;

CREATE TABLE IF NOT EXISTS solar_readings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated VARCHAR(50),
  solar_flux FLOAT,
  a_index INT,
  k_index INT,
  k_index_nt VARCHAR(20),
  x_ray VARCHAR(10),
  sunspots INT,
  helium_line FLOAT,
  proton_flux FLOAT,
  electron_flux INT,
  aurora INT,
  normalization FLOAT,
  lat_degree FLOAT,
  solar_wind FLOAT,
  magnetic_field FLOAT,
  geomag_field VARCHAR(20),
  signal_noise VARCHAR(20),
  fof2 VARCHAR(20),
  muffactor VARCHAR(20),
  muf VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS band_conditions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reading_id INT,
  band_name VARCHAR(20),
  time_of_day VARCHAR(10),
  current_condition VARCHAR(20),
  FOREIGN KEY (reading_id) REFERENCES solar_readings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vhf_conditions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reading_id INT,
  phenomenon_name VARCHAR(30),
  location VARCHAR(30),
  current_condition VARCHAR(30),
  FOREIGN KEY (reading_id) REFERENCES solar_readings(id) ON DELETE CASCADE
);
