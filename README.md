# solar-info-backend

## Proveedor ionosferico

El modo predeterminado es `IONOSPHERE_PROVIDER=hybrid`, con `IONOSPHERE_PREFERRED_PROVIDER=dias`. Los modos exclusivos son `dias` y `giro`. En modo hibrido se prefiere el proveedor configurado para estaciones DIAS; si falla, se intenta el otro proveedor para el mismo URSI. Las estaciones fuera de DIAS usan GIRO directamente. En modos exclusivos no se consulta el otro proveedor. Un valor desconocido hace que `/api/ionosphere/hf` responda con error de configuracion.

DIAS solo publica actualmente estas estaciones URSI: `AT138`, `DB049`, `EA036`, `EB040`, `JR055`, `PQ052`, `RL052`, `RO041`, `SO148` y `TR170`. El endpoint de estaciones mantiene siempre el catalogo completo de la APK; no se duplica ni filtra el selector por proveedor.

DIAS consulta por defecto una ventana UTC de tres horas (`DIAS_WINDOW_HOURS`) y utiliza un timeout de 10 segundos (`DIAS_TIMEOUT_MS`). Una observacion fuera de esa ventana se clasifica como antigua y, en modo hibrido, activa el intento con el otro proveedor. La API devuelve timestamps sin zona horaria (por ejemplo `2026-10-12T08:10:01`); el backend los interpreta como UTC y los expone normalizados con `Z`. Por equivalencia confirmada, `hF2` de DIAS se asigna al campo `hF2`; `hmF2` no se sustituye. DIAS no ofrece el estado de confianza de GIRO, por lo que `confidence` es `null` para DIAS.

En modo `hybrid`, la seleccion automatica evalua por distancia las estaciones DIAS del catalogo dentro de `IONOSPHERE_AUTO_MAX_DISTANCE_KM` (500 km por defecto), hasta `IONOSPHERE_AUTO_MAX_ATTEMPTS` candidatas, y exige observaciones de hasta `IONOSPHERE_MAX_OBSERVATION_AGE_MINUTES` (30 min). Si no encuentra una observacion valida, usa la estacion mas cercana del catalogo completo via GIRO. En modo exclusivo `dias` aplica el mismo radio y frescura, pero devuelve un error controlado si no encuentra datos; en modo exclusivo `giro` conserva la seleccion mas cercana original. El radio es un criterio operativo configurable, no una garantia de representatividad ionosferica.

Las cachés en memoria y persistidas estan separadas por proveedor. El archivo preexistente `data/giro-cache.json` sigue perteneciendo a GIRO, incluidos registros antiguos sin campo de proveedor. DIAS usa `data/dias-cache.json` (configurable con `DIAS_CACHE_FILE`); los datos persistidos conservan la antiguedad real desde `measuredAt`, no desde su descarga.

Para forzar exclusivamente DIAS o GIRO, configura `IONOSPHERE_PROVIDER=dias` o `IONOSPHERE_PROVIDER=giro` y reinicia el backend. Las pruebas se ejecutan con `npm test` y no requieren acceso a GIRO/DIAS.