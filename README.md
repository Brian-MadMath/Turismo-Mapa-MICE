# Mexico Routes Working Copy

This package reconstructs the current Tijuana national-routes map from the material that is still recoverable in the chat.

## What is exact

- The minimum map HTML supplied in the current message.
- The current JavaScript renderer supplied in `Pasted text.txt`, with two small correctness changes:
  - an empty CMS airport name stays empty instead of becoming the invented text `Aeropuerto`;
  - placeholder images are generated locally as SVG data URLs instead of using `placehold.co`.
- The complete 32-state GeoJSON supplied in `js.file.patch`.
- The recoverable published CMS record for Acapulco (ACA): coordinates, state, description and approximate hours.

## What is reconstructed

The original complete Webflow CMS destination collection is no longer available as downloadable raw data in this conversation. The standalone copy therefore includes the recoverable Acapulco record as a hidden `.map-destination-data` element. Add additional records using the same attributes to exercise the unchanged CMS adapter.

## Run

Open `index.html` directly in a browser while online. It does not use fetch for the map data, so no local web server is required. The only external runtime dependency is D3 v7 from jsDelivr.

## Expected behavior

- 32 Mexico state outlines render.
- TIJ origin marker renders in Baja California.
- ACA destination marker renders in Guerrero.
- The dropdown contains Acapulco.
- Selecting ACA draws the route, highlights Guerrero and opens the popup.
- Closing the popup clears the route/selection.

`webflow-minimum-embed.html` contains only the map markup from the current message and can be used later when converting the standalone copy back to Webflow.
