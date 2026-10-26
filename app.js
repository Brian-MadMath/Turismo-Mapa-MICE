(() => {
  "use strict";

  const CONFIG = Object.freeze({
    /*
      The municipality layer is a static GeoJSON file, not a map API. For the
      production/Webflow version, host this same file with the project so both
      maps are completely independent from third-party delivery.
    */
    municipalitiesUrl:
      "https://raw.githubusercontent.com/MacWilliXD/INEGI-geojson/main/geojson_descargas/AGEM_02.geojson",
    roadsUrl: "./data/bc-federal-roads.geojson",
    contentUrl: "./data/bc-map-content.json",
    mobileBreakpoint: 760,
    minMapPadding: 24,
    maxMapPadding: 52,
  });

  const elements = {
    mapExperience: document.getElementById("mapExperience"),
    mapViewport: document.getElementById("mapViewport"),
    svg: document.getElementById("mexicoMap"),
    select: document.getElementById("destinationSelect"),
    loading: document.getElementById("mapLoading"),
    loadingText: document.getElementById("mapLoadingText"),
    status: document.getElementById("mapStatus"),
    popup: document.getElementById("destinationPopup"),
    popupClose: document.getElementById("popupClose"),
    popupImage: document.getElementById("popupImage"),
    popupEyebrow: document.getElementById("popupEyebrow"),
    popupTitle: document.getElementById("popupTitle"),
    popupCode: document.getElementById("popupCode"),
    popupAirport: document.getElementById("popupAirport"),
    popupDescription: document.getElementById("popupDescription"),
    popupHours: document.getElementById("popupHours"),
    popupCta: document.getElementById("popupCta"),
    popupCtaLabel: document.getElementById("popupCtaLabel"),
  };

  const app = {
    municipalities: null,
    roads: null,
    content: { municipalities: {}, roads: {} },
    itemByKey: new Map(),
    selectedKey: null,
    projection: null,
    path: null,
    layers: {},
    resizeObserver: null,
    resizeFrame: null,
  };

  initialize().catch(showFatalError);

  async function initialize() {
    assertRequiredDom();

    if (!window.d3) {
      throw new Error("D3 no pudo cargarse.");
    }

    createSvgLayers();
    bindInterfaceEvents();

    /*
      Geometry and editorial content remain separate. This mirrors the national
      map architecture and keeps a future Webflow CMS migration limited to a
      data adapter rather than a renderer rewrite.
    */
    const [municipalitiesData, roadsData, contentData] = await Promise.all([
      d3.json(CONFIG.municipalitiesUrl),
      d3.json(CONFIG.roadsUrl),
      d3.json(CONFIG.contentUrl),
    ]);

    app.municipalities = normalizeMunicipalities(municipalitiesData);
    app.roads = normalizeRoads(roadsData);
    app.content = normalizeContent(contentData);

    buildItemIndex();
    populateSelect();
    renderMap();
    observeViewport();
    hideLoading();
  }

  function assertRequiredDom() {
    const missing = Object.entries(elements)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length) {
      throw new Error(`Faltan nodos requeridos: ${missing.join(", ")}`);
    }
  }

  function normalizeMunicipalities(data) {
    if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      throw new TypeError("La geometría municipal debe ser un FeatureCollection.");
    }

    const features = data.features.filter((feature) => {
      return ["Polygon", "MultiPolygon"].includes(feature?.geometry?.type);
    });

    if (features.length !== 7) {
      console.warn(`Se esperaban 7 municipios de Baja California y se recibieron ${features.length}.`);
    }

    return { ...data, features };
  }

  function normalizeRoads(data) {
    if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      throw new TypeError("La red carretera debe ser un FeatureCollection.");
    }

    return {
      ...data,
      features: data.features.filter((feature) => {
        return ["LineString", "MultiLineString"].includes(feature?.geometry?.type);
      }),
    };
  }

  function normalizeContent(data) {
    return {
      municipalities: data?.municipalities || {},
      roads: data?.roads || {},
    };
  }

  function createSvgLayers() {
    const root = d3.select(elements.svg).append("g").attr("class", "map-root");

    app.layers = {
      municipalities: root.append("g").attr("class", "municipality-layer"),
      roads: root.append("g").attr("class", "road-layer"),
      labels: root.append("g").attr("class", "road-label-layer"),
    };
  }

  function buildItemIndex() {
    app.itemByKey.clear();

    for (const feature of app.municipalities.features) {
      const code = getMunicipalityCode(feature);
      app.itemByKey.set(`municipality:${code}`, {
        kind: "municipality",
        key: `municipality:${code}`,
        feature,
      });
    }

    for (const feature of app.roads.features) {
      const id = String(feature.properties?.id || "").trim();
      if (!id) continue;

      app.itemByKey.set(`road:${id}`, {
        kind: "road",
        key: `road:${id}`,
        feature,
      });
    }
  }

  function populateSelect() {
    const fragment = document.createDocumentFragment();
    fragment.append(new Option("Selecciona un municipio o carretera", ""));

    const municipalityGroup = document.createElement("optgroup");
    municipalityGroup.label = "Municipios";

    [...app.municipalities.features]
      .sort((a, b) => getMunicipalityName(a).localeCompare(getMunicipalityName(b), "es"))
      .forEach((feature) => {
        const code = getMunicipalityCode(feature);
        municipalityGroup.append(new Option(getMunicipalityName(feature), `municipality:${code}`));
      });

    const roadGroup = document.createElement("optgroup");
    roadGroup.label = "Carreteras federales";

    [...app.roads.features]
      .sort((a, b) => Number(a.properties?.index || 0) - Number(b.properties?.index || 0))
      .forEach((feature) => {
        const props = feature.properties || {};
        roadGroup.append(
          new Option(`${props.route} — ${props.name}`, `road:${props.id}`),
        );
      });

    fragment.append(municipalityGroup, roadGroup);
    elements.select.replaceChildren(fragment);
    elements.select.disabled = false;
  }

  function bindInterfaceEvents() {
    elements.select.addEventListener("change", () => {
      const key = elements.select.value;
      if (!key) {
        closeSelection();
        return;
      }
      selectItem(key, elements.select);
    });

    elements.popupClose.addEventListener("click", closeSelection);

    elements.popupCta.addEventListener("click", (event) => {
      if (elements.popupCta.getAttribute("aria-disabled") === "true") {
        event.preventDefault();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && app.selectedKey) closeSelection();
    });
  }

  function observeViewport() {
    if (!window.ResizeObserver) return;

    app.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(app.resizeFrame);
      app.resizeFrame = requestAnimationFrame(renderMap);
    });

    app.resizeObserver.observe(elements.mapViewport);
  }

  function renderMap() {
    const rect = elements.mapViewport.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || 960));
    const height = Math.max(520, Math.round(rect.height || 690));
    const padding = clamp(width * 0.045, CONFIG.minMapPadding, CONFIG.maxMapPadding);

    elements.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    app.projection = d3
      .geoMercator()
      .fitExtent(
        [[padding, padding], [width - padding, height - padding]],
        app.municipalities,
      );

    app.path = d3.geoPath(app.projection);

    renderMunicipalities();
    renderRoads();
    renderRoadLabels();
    updateSelectionStyles();

    if (app.selectedKey) {
      requestAnimationFrame(positionPopup);
    }
  }

  function renderMunicipalities() {
    app.layers.municipalities
      .selectAll("path")
      .data(app.municipalities.features, getMunicipalityCode)
      .join("path")
      .attr("class", "map-state map-municipality")
      .attr("d", app.path)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (feature) => `Municipio de ${getMunicipalityName(feature)}`)
      .on("click", (_, feature) => {
        selectItem(`municipality:${getMunicipalityCode(feature)}`);
      })
      .on("keydown", (event, feature) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectItem(`municipality:${getMunicipalityCode(feature)}`);
        }
      });
  }

  function renderRoads() {
    app.layers.roads
      .selectAll("path")
      .data(app.roads.features, (feature) => feature.properties?.id)
      .join("path")
      .attr("class", (feature) => {
        const type = feature.properties?.networkType || "free";
        return `map-route map-route--${type}`;
      })
      .attr("d", app.path)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (feature) => {
        const props = feature.properties || {};
        return `${props.route}. ${props.name}. ${props.networkLabel}.`;
      })
      .on("click", (event, feature) => {
        event.stopPropagation();
        selectItem(`road:${feature.properties.id}`);
      })
      .on("keydown", (event, feature) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectItem(`road:${feature.properties.id}`);
        }
      });
  }

  function renderRoadLabels() {
    /*
      One label per route number keeps the prototype legible. Segment names
      remain available through click/selector, while the map avoids duplicating
      MEX-001 or MEX-002 labels on every official segment.
    */
    const uniqueRoutes = new Map();

    for (const feature of app.roads.features) {
      const route = String(feature.properties?.route || "");
      if (!uniqueRoutes.has(route)) uniqueRoutes.set(route, feature);
    }

    app.layers.labels
      .selectAll("text")
      .data([...uniqueRoutes.values()], (feature) => feature.properties.route)
      .join("text")
      .attr("class", "map-road-label")
      .attr("x", (feature) => app.path.centroid(feature)[0])
      .attr("y", (feature) => app.path.centroid(feature)[1])
      .attr("text-anchor", "middle")
      .text((feature) => feature.properties.route);
  }

  function selectItem(key, trigger = null) {
    const item = app.itemByKey.get(key);
    if (!item) return;

    app.selectedKey = key;
    elements.select.value = key;
    updateSelectionStyles();
    renderPopup(item);

    const name = getItemName(item);
    elements.status.textContent = `${name} seleccionado.`;

    if (trigger && typeof trigger.focus === "function") {
      trigger.focus({ preventScroll: true });
    }
  }

  function updateSelectionStyles() {
    app.layers.municipalities
      .selectAll(".map-state")
      .classed("is-selected", (feature) => {
        return app.selectedKey === `municipality:${getMunicipalityCode(feature)}`;
      });

    app.layers.roads
      .selectAll(".map-route")
      .classed("is-selected", (feature) => {
        return app.selectedKey === `road:${feature.properties?.id}`;
      });
  }

  function renderPopup(item) {
    const model = item.kind === "municipality"
      ? buildMunicipalityPopup(item.feature)
      : buildRoadPopup(item.feature);

    elements.popupEyebrow.textContent = model.eyebrow;
    elements.popupTitle.textContent = model.title;
    elements.popupCode.textContent = model.code;
    elements.popupAirport.textContent = model.meta;
    elements.popupDescription.textContent = model.description;
    elements.popupHours.hidden = true;

    elements.popupImage.src = model.image;
    elements.popupImage.alt = model.imageAlt;

    elements.popupCtaLabel.textContent = model.ctaLabel;
    const ctaDisabled = !model.ctaUrl || model.ctaUrl === "#";
    elements.popupCta.href = ctaDisabled ? "#" : model.ctaUrl;
    elements.popupCta.setAttribute("aria-disabled", String(ctaDisabled));
    elements.popupCta.tabIndex = ctaDisabled ? -1 : 0;

    elements.popup.hidden = false;
    requestAnimationFrame(positionPopup);
  }

  function buildMunicipalityPopup(feature) {
    const code = getMunicipalityCode(feature);
    const name = getMunicipalityName(feature);
    const editorial = app.content.municipalities[code] || {};

    return {
      eyebrow: editorial.eyebrow || "Municipio",
      title: editorial.title || name,
      code,
      meta: "Baja California",
      description: editorial.description || `Contenido temporal para ${name}.`,
      image: editorial.image || buildPlaceholderImage(name),
      imageAlt: editorial.imageAlt || `Imagen temporal de ${name}`,
      ctaLabel: editorial.ctaLabel || "Conocer municipio",
      ctaUrl: editorial.ctaUrl || "#",
    };
  }

  function buildRoadPopup(feature) {
    const props = feature.properties || {};
    const editorial = app.content.roads[props.id] || {};

    return {
      eyebrow: editorial.eyebrow || "Carretera federal",
      title: editorial.title || props.name,
      code: props.route || "",
      meta: editorial.meta || props.networkLabel || "Red Federal",
      description:
        editorial.description ||
        "Contenido temporal de esta carretera. Sustituye este texto por la información final del tramo.",
      image: editorial.image || buildPlaceholderImage(props.route || props.name),
      imageAlt: editorial.imageAlt || `Imagen temporal de ${props.name}`,
      ctaLabel: editorial.ctaLabel || "Conocer carretera",
      ctaUrl: editorial.ctaUrl || "#",
    };
  }

  function positionPopup() {
    if (!app.selectedKey || elements.popup.hidden || isMobileLayout()) {
      elements.popup.style.left = "";
      elements.popup.style.top = "";
      return;
    }

    const item = app.itemByKey.get(app.selectedKey);
    if (!item) return;

    const [anchorX, anchorY] = app.path.centroid(item.feature);
    if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return;

    const viewportRect = elements.mapViewport.getBoundingClientRect();
    const experienceRect = elements.mapExperience.getBoundingClientRect();
    const popupWidth = elements.popup.offsetWidth || 360;
    const popupHeight = elements.popup.offsetHeight || 320;

    const baseX = viewportRect.left - experienceRect.left + anchorX;
    const baseY = viewportRect.top - experienceRect.top + anchorY;

    const preferRight = baseX < experienceRect.width * 0.62;
    let left = preferRight ? baseX + 20 : baseX - popupWidth - 20;
    let top = baseY - popupHeight * 0.45;

    left = clamp(left, 12, Math.max(12, experienceRect.width - popupWidth - 12));
    top = clamp(top, 12, Math.max(12, viewportRect.height - popupHeight - 12));

    elements.popup.style.left = `${left}px`;
    elements.popup.style.top = `${top}px`;
  }

  function closeSelection() {
    app.selectedKey = null;
    elements.select.value = "";
    elements.popup.hidden = true;
    elements.popup.style.left = "";
    elements.popup.style.top = "";
    elements.status.textContent = "Selección cerrada.";
    updateSelectionStyles();
  }

  function getMunicipalityCode(feature) {
    return String(feature?.properties?.cvegeo || feature?.properties?.CVEGEO || "").trim();
  }

  function getMunicipalityName(feature) {
    return String(
      feature?.properties?.nom_agem ||
      feature?.properties?.NOM_MUN ||
      feature?.properties?.name ||
      "Municipio",
    ).trim();
  }

  function getItemName(item) {
    if (item.kind === "municipality") return getMunicipalityName(item.feature);
    return String(item.feature.properties?.name || item.feature.properties?.route || "Carretera");
  }

  function buildPlaceholderImage(label) {
    return `https://placehold.co/800x450?text=${encodeURIComponent(label)}`;
  }

  function isMobileLayout() {
    return window.matchMedia(`(max-width: ${CONFIG.mobileBreakpoint}px)`).matches;
  }

  function hideLoading() {
    elements.loading.classList.add("is-hidden");
  }

  function showFatalError(error) {
    console.error(error);

    if (elements.loading && elements.loadingText) {
      elements.loading.classList.remove("is-hidden");
      elements.loading.classList.add("is-error");
      elements.loadingText.textContent = "No fue posible cargar el mapa.";
    }

    if (elements.select) {
      elements.select.disabled = true;
      elements.select.replaceChildren(new Option("Mapa no disponible", ""));
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
})();
