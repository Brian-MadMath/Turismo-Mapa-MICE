# Baja California — Municipios + Carreteras Federales

Prototipo standalone con D3.js + SVG + GeoJSON, sin tiles, sin zoom y sin API key.

## Ejecutar

Desde esta carpeta:

```bash
python3 -m http.server 8000
```

Después abre `http://localhost:8000`.

No abras `index.html` directamente con `file://`, porque el navegador puede bloquear los `fetch()` de los archivos JSON/GeoJSON.

## Arquitectura

- `index.html`: misma estructura base y clases del mapa nacional para facilitar la futura unificación en Webflow.
- `app.js`: render, selección, popup y adaptadores de datos.
- `data/bc-federal-roads.geojson`: corredores federales simplificados para validar UI.
- `data/bc-map-content.json`: textos/imágenes temporales editables sin tocar el renderer.
- Municipios: `AGEM_02.geojson` 2025 se carga como GeoJSON estático desde un mirror comunitario derivado del Marco Geoestadístico de INEGI.

## Antes de producción

La geometría de carreteras incluida es deliberadamente simplificada. Sustitúyela por un recorte de Baja California de la Red Nacional de Caminos 2025 (RNC) y conserva las propiedades `id`, `route`, `name`, `networkType` y `networkLabel` para no cambiar el renderer.

Para hacer el proyecto 100% local, descarga `AGEM_02.geojson`, guárdalo en `data/bc-municipalities.geojson` y cambia una sola línea en `CONFIG.municipalitiesUrl`.
