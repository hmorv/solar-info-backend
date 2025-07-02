#!/bin/bash

LOGFILE="$1"

if [ -z "$LOGFILE" ]; then
  echo "Uso: $0 archivo_de_log.json"
  exit 1
fi

if [ ! -f "$LOGFILE" ]; then
  echo "Archivo no encontrado: $LOGFILE"
  exit 1
fi

# Extraer códigos de estado HTTP
echo "Analizando $LOGFILE..."
echo

# Extrae todos los códigos (número de 3 cifras tras una comilla)
# Ejemplo: "GET /ruta HTTP/1.1\" 200
grep -oE '" [0-9]{3} ' "$LOGFILE" | awk '{print $2}' | sort | uniq -c | sort -nr | while read count code; do
  if [ "$code" = "200" ]; then
    echo "✅ $count peticiones con estado 200"
  else
    echo "⚠️  $count peticiones con estado $code"
  fi
done
