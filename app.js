(() => {
    "use strict";

    const CONFIG = Object.freeze({
        mobileBreakpoint: 720,
        minMapPadding: 18,
        maxMapPadding: 42,
        routeDurationMs: 720,
    });

    /*
      TIJ is application configuration, not CMS content.
      Every route originates here, so storing it once avoids creating
      a fake "destination" CMS item just to provide the map origin.
    */
    const ORIGIN = Object.freeze({
        code: "TIJ",
        city: "Tijuana",
        airport: "Aeropuerto Internacional de Tijuana",
        coordinates: [-116.969976, 32.541043],
        stateCode: "MX-BCN",
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
        states: null,
        origin: null,
        destinations: [],
        destinationByCode: new Map(),
        selectedCode: null,
        projection: null,
        path: null,
        layers: {},
        resizeObserver: null,
        resizeFrame: null,
        lastTrigger: null,
        reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    };

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            () => initialize().catch(showFatalError),
            { once: true },
        );
    } else {
        initialize().catch(showFatalError);
    }

    async function initialize() {
        assertRequiredDom();

        if (!window.d3) {
            throw new Error("D3 no pudo cargarse. Revisa la conexión o usa una copia local de d3.min.js.");
        }

        createSvgLayers();
        bindInterfaceEvents();

        /*
          Geometría y contenido viajan por separado. Cambiar un CMS, actualizar una
          ruta o sustituir el GeoJSON no obliga a modificar el renderizador SVG.
        */
        const statesData = readStatesFromInlineGeoJSON();

        app.states = normalizeStates(statesData);
        app.origin = normalizeAirport(ORIGIN, "origen");

        /*
          Webflow has already rendered the CMS Collection List into the DOM.
          We convert those elements into the same internal object structure
          previously supplied by destinations.json.

          Everything after this point remains CMS-agnostic.
        */
        app.destinations = normalizeDestinations(readDestinationsFromCMS());

        app.destinationByCode = new Map(
            app.destinations.map((destination) => [destination.code, destination]),
        );

        populateDestinationSelect();
        renderMap({animateRoute: false});
        observeViewport();
        hideLoading();
    }

    function assertRequiredDom() {
        const missing = Object.entries(elements)
            .filter(([, node]) => !node)
            .map(([name]) => name);

        if (missing.length) {
            throw new Error(`Faltan nodos requeridos en index.html: ${missing.join(", ")}`);
        }
    }

    function readStatesFromInlineGeoJSON() {
        const source = document.getElementById("mexicoStatesData");

        if (!source) {
            throw new Error("No se encontró #mexicoStatesData.");
        }

        try {
            return JSON.parse(source.textContent);
        } catch (error) {
            throw new Error(`GeoJSON inválido: ${error.message}`);
        }
    }

    function normalizeStates(data) {
        if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
            throw new TypeError("El archivo de estados debe ser un GeoJSON FeatureCollection.");
        }

        const features = data.features.filter((feature) => {
            const type = feature?.geometry?.type;
            return type === "Polygon" || type === "MultiPolygon";
        });

        if (features.length !== 32) {
            console.warn(`Se esperaban 32 estados y se recibieron ${features.length}.`);
        }

        return {...data, features};
    }

    function readDestinationsFromCMS() {
        const elements = [
            ...document.querySelectorAll(".map-destination-data"),
        ];

        if (!elements.length) {
            throw new Error(
                "No se encontraron destinos renderizados por Webflow CMS.",
            );
        }

        return elements.map((element) => {
            const image = element.querySelector(".map-destination-image");

            const city = element.dataset.city?.trim() || "";
            const hoursRaw = element.dataset.hours?.trim() || "";
            const hours = hoursRaw === "" ? null : Number(hoursRaw);

            return {
                id: element.dataset.slug?.trim() || "",
                code: element.dataset.code?.trim() || "",
                city,

                /*
                  The CMS stores latitude and longitude separately, but the map's
                  internal contract remains GeoJSON-compatible [longitude, latitude].
                */
                coordinates: [
                    Number(element.dataset.lng),
                    Number(element.dataset.lat),
                ],

                stateCode: element.dataset.state?.trim() || "",

                /*
                  The Webflow Collection List already controls which CMS items are
                  rendered, so every item reaching this adapter is an active destination.
                */
                active: true,

                /*
                  Stored now even though the current popup has no UI element for it.
                  This keeps the CMS value available without deciding its presentation
                  inside the data adapter.
                */
                hours: Number.isFinite(hours) ? hours : null,

                /*
                  Your current CMS does not contain an airport-name field.
                  Leaving this empty is preferable to inventing one.
                */
                airport: "",

                popup: {
                    eyebrow: "Vuelo directo desde Tijuana",
                    title: city,
                    description: element.dataset.description?.trim() || "",

                    image:
                        image?.currentSrc
                        || image?.src
                        || null,

                    imageAlt:
                        image?.alt?.trim()
                        || `Imagen de ${city}`,

                    ctaLabel: "Conocer destino",
                    ctaUrl: element.dataset.url?.trim() || "#",
                },
            };
        });
    }

    function normalizeDestinations(destinations) {
      if (!Array.isArray(destinations)) {
        throw new TypeError("Los destinos deben proporcionarse como un arreglo.");
      }

        const seenCodes = new Set();

        return destinations
            .filter((destination) => destination?.active !== false)
            .map((destination) => normalizeAirport(destination, "destino"))
            .filter((destination) => {
                if (seenCodes.has(destination.code)) {
                    console.warn(`Código IATA duplicado omitido: ${destination.code}`);
                    return false;
                }

                seenCodes.add(destination.code);
                return true;
            });
    }

    function normalizeAirport(airport, kind) {
        if (!airport || typeof airport !== "object") {
            throw new TypeError(`El ${kind} no es un objeto válido.`);
        }

        const code = String(airport.code || "").trim().toUpperCase();
        const coordinates = Array.isArray(airport.coordinates)
            ? airport.coordinates.map(Number)
            : [];

        if (!/^[A-Z0-9]{3}$/.test(code)) {
            throw new TypeError(`Código IATA inválido en ${kind}: ${airport.code}`);
        }

        if (!isValidLonLat(coordinates)) {
            throw new TypeError(
                `Coordenadas inválidas para ${code}. GeoJSON y D3 usan [longitud, latitud].`,
            );
        }

        return {
            ...airport,
            code,
            city: String(airport.city || code),
            airport: String(airport.airport || ""),
            coordinates,
            stateCode: String(airport.stateCode || "").toUpperCase(),
            popup: {
                eyebrow: "Vuelo directo desde Tijuana",
                title: String(airport.city || code),
                description: "Contenido temporal del destino.",
                image: null,
                imageAlt: `Imagen temporal de ${airport.city || code}`,
                ctaLabel: "Conocer destino",
                ctaUrl: "#",
                ...(airport.popup || {}),
            },
        };
    }

    function isValidLonLat(coordinates) {
        if (coordinates.length !== 2) return false;

        const [longitude, latitude] = coordinates;
        return (
            Number.isFinite(longitude)
            && Number.isFinite(latitude)
            && longitude >= -180
            && longitude <= 180
            && latitude >= -90
            && latitude <= 90
        );
    }

    function createSvgLayers() {
        const svg = d3.select(elements.svg);

        // Conserva title/desc del SVG y reemplaza solamente las capas de dibujo.
        svg.selectAll("g[data-map-layer]").remove();

        const root = svg
            .append("g")
            .attr("data-map-layer", "root")
            .attr("class", "map-root");

        app.layers.states = root
            .append("g")
            .attr("data-map-layer", "states")
            .attr("class", "states-layer");

        app.layers.routes = root
            .append("g")
            .attr("data-map-layer", "routes")
            .attr("class", "routes-layer");

        app.layers.markers = root
            .append("g")
            .attr("data-map-layer", "markers")
            .attr("class", "markers-layer");

        app.layers.origin = root
            .append("g")
            .attr("data-map-layer", "origin")
            .attr("class", "origin-layer");
    }

    function bindInterfaceEvents() {
        elements.select.addEventListener("change", (event) => {
            const code = event.target.value;

            if (!code) {
                closeSelection({restoreFocus: false});
                return;
            }

            app.lastTrigger = elements.select;
            selectDestination(code, {animateRoute: true});
        });

        elements.popupClose.addEventListener("click", () => {
            closeSelection({restoreFocus: true});
        });

        elements.popupImage.addEventListener("load", () => {
            window.requestAnimationFrame(positionPopup);
        });

        elements.popupCta.addEventListener("click", (event) => {
            if (elements.popupCta.getAttribute("aria-disabled") === "true") {
                event.preventDefault();
            }
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && app.selectedCode) {
                closeSelection({restoreFocus: true});
            }
        });

        d3.select(elements.svg).on("click", (event) => {
            if (event.target === elements.svg) {
                closeSelection({restoreFocus: false});
            }
        });
    }

    function populateDestinationSelect() {
        const collator = new Intl.Collator("es", {sensitivity: "base"});
        const sorted = [...app.destinations].sort((a, b) => collator.compare(a.city, b.city));

        elements.select.replaceChildren();

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Selecciona un destino";
        elements.select.append(placeholder);

        sorted.forEach((destination) => {
            const option = document.createElement("option");
            option.value = destination.code;
            option.textContent = `${destination.city} (${destination.code})`;
            elements.select.append(option);
        });

        elements.select.disabled = false;
    }

    function observeViewport() {
        if (!("ResizeObserver" in window)) {
            window.addEventListener("resize", scheduleRender);
            return;
        }

        app.resizeObserver = new ResizeObserver(scheduleRender);
        app.resizeObserver.observe(elements.mapViewport);
    }

    function scheduleRender() {
        window.cancelAnimationFrame(app.resizeFrame);
        app.resizeFrame = window.requestAnimationFrame(() => {
            renderMap({animateRoute: false});
        });
    }

    function renderMap({animateRoute = false} = {}) {
        if (!app.states || !app.origin) return;

        const rect = elements.mapViewport.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));

        d3.select(elements.svg)
            .attr("viewBox", `0 0 ${width} ${height}`)
            .attr("width", width)
            .attr("height", height);

        const padding = clamp(
            Math.min(width, height) * 0.045,
            CONFIG.minMapPadding,
            CONFIG.maxMapPadding,
        );

        /*
          fitExtent es el único control de cámara. No se registra d3.zoom ni pan:
          el usuario siempre ve el país completo y nunca puede navegar fuera de él.
        */
        app.projection = d3
            .geoMercator()
            .fitExtent(
                [[padding, padding], [width - padding, height - padding]],
                app.states,
            );

        app.path = d3.geoPath(app.projection);

        renderStates();
        renderDestinationMarkers();
        renderOriginMarker();
        renderRoute({animate: animateRoute});
        updateSelectionStyles();
        positionPopup();
    }

    function renderStates() {
        const statesWithDestinations = new Set(
            app.destinations.map((destination) => destination.stateCode),
        );

        const paths = app.layers.states
            .selectAll("path.map-state")
            .data(app.states.features, (feature, index) => getStateCode(feature) || index)
            .join(
                (enter) => enter
                    .append("path")
                    .attr("class", "map-state")
                    .on("click", (event) => {
                        event.stopPropagation();
                        closeSelection({restoreFocus: false});
                    }),
                (update) => update,
                (exit) => exit.remove(),
            )
            .attr("d", app.path)
            .attr("data-state-code", getStateCode)
            .attr("aria-label", getStateName)
            .classed("has-destination", (feature) => {
                return statesWithDestinations.has(getStateCode(feature));
            })
            .classed("is-origin-state", (feature) => {
                return getStateCode(feature) === app.origin.stateCode;
            });

        paths.each(function addAccessibleTitle(feature) {
            d3.select(this)
                .selectAll("title")
                .data([feature])
                .join("title")
                .text(getStateName);
        });
    }

    function renderDestinationMarkers() {
        const markers = app.layers.markers
            .selectAll("g.destination-marker")
            .data(app.destinations, (destination) => destination.code)
            .join(
                (enter) => {
                    const marker = enter
                        .append("g")
                        .attr("class", "destination-marker")
                        .attr("role", "button")
                        .attr("tabindex", 0)
                        .on("click", function onMarkerClick(event, destination) {
                            event.stopPropagation();
                            app.lastTrigger = this;
                            selectDestination(destination.code, {animateRoute: true});
                        })
                        .on("keydown", function onMarkerKeydown(event, destination) {
                            if (event.key !== "Enter" && event.key !== " ") return;

                            event.preventDefault();
                            event.stopPropagation();
                            app.lastTrigger = this;
                            selectDestination(destination.code, {animateRoute: true});
                        });

                    marker
                        .append("circle")
                        .attr("class", "marker-hit-area")
                        .attr("r", 20);

                    marker
                        .append("circle")
                        .attr("class", "marker-ring")
                        .attr("r", 7);

                    marker
                        .append("circle")
                        .attr("class", "marker-dot")
                        .attr("r", 3.1);

                    const label = marker
                        .append("g")
                        .attr("class", "marker-label")
                        .attr("aria-hidden", "true");

                    label
                        .append("rect")
                        .attr("x", -19)
                        .attr("y", -31)
                        .attr("width", 38)
                        .attr("height", 18)
                        .attr("rx", 9);

                    label
                        .append("text")
                        .attr("y", -18.5);

                    return marker;
                },
                (update) => update,
                (exit) => exit.remove(),
            )
            .attr("transform", (destination) => {
                const [x, y] = app.projection(destination.coordinates);
                return `translate(${x},${y})`;
            })
            .attr("aria-label", (destination) => {
                return destination.airport
                    ? `${destination.city}, ${destination.code}. ${destination.airport}`
                    : `${destination.city}, ${destination.code}`;
            })
            .attr("aria-pressed", (destination) => {
                return destination.code === app.selectedCode ? "true" : "false";
            });

        markers.select(".marker-label text").text((destination) => destination.code);
    }

    function renderOriginMarker() {
        const marker = app.layers.origin
            .selectAll("g.origin-marker")
            .data([app.origin])
            .join((enter) => {
                const origin = enter
                    .append("g")
                    .attr("class", "origin-marker")
                    .attr("aria-hidden", "true");

                origin
                    .append("circle")
                    .attr("class", "origin-pulse")
                    .attr("r", 10);

                origin
                    .append("circle")
                    .attr("class", "origin-ring")
                    .attr("r", 7.5);

                origin
                    .append("circle")
                    .attr("class", "origin-dot")
                    .attr("r", 3.5);

                const label = origin.append("g").attr("class", "origin-label");

                label
                    .append("rect")
                    .attr("x", -20)
                    .attr("y", 13)
                    .attr("width", 40)
                    .attr("height", 19)
                    .attr("rx", 9.5);

                label
                    .append("text")
                    .attr("y", 26)
                    .text(app.origin.code);

                return origin;
            });

        marker.attr("transform", () => {
            const [x, y] = app.projection(app.origin.coordinates);
            return `translate(${x},${y})`;
        });
    }

    function renderRoute({animate = false} = {}) {
        const destination = getSelectedDestination();
        const routeData = destination ? [destination] : [];

        const routeGroups = app.layers.routes
            .selectAll("g.active-route")
            .data(routeData, (item) => item.code)
            .join(
                (enter) => {
                    const group = enter.append("g").attr("class", "active-route");
                    group.append("path").attr("class", "route-shadow");
                    group.append("path").attr("class", "route-line");
                    return group;
                },
                (update) => update,
                (exit) => exit.remove(),
            );

        routeGroups.each(function updateRoute(destinationItem) {
            const routeFeature = {
                type: "Feature",
                geometry: {
                    type: "LineString",
                    coordinates: [app.origin.coordinates, destinationItem.coordinates],
                },
            };

            const group = d3.select(this);
            const pathValue = app.path(routeFeature);

            group.select(".route-shadow").attr("d", pathValue);

            const line = group
                .select(".route-line")
                .interrupt()
                .attr("d", pathValue)
                .attr("stroke-dasharray", null)
                .attr("stroke-dashoffset", null);

            if (!animate || app.reduceMotion) return;

            const node = line.node();
            const length = node?.getTotalLength?.() || 0;

            if (!length) return;

            line
                .attr("stroke-dasharray", `${length} ${length}`)
                .attr("stroke-dashoffset", length)
                .transition()
                .duration(CONFIG.routeDurationMs)
                .ease(d3.easeCubicOut)
                .attr("stroke-dashoffset", 0)
                .on("end", function clearDashPattern() {
                    d3.select(this)
                        .attr("stroke-dasharray", null)
                        .attr("stroke-dashoffset", null);
                });
        });
    }

    function selectDestination(code, {animateRoute = true} = {}) {
        const destination = app.destinationByCode.get(code);
        if (!destination) return;

        app.selectedCode = code;
        elements.select.value = code;

        updateSelectionStyles();
        renderRoute({animate: animateRoute});
        renderPopup(destination);

        elements.status.textContent = `${destination.city}, ${destination.code}, seleccionado. Se muestra la ruta desde Tijuana.`;
    }

    function updateSelectionStyles() {
        const destination = getSelectedDestination();
        const selectedStateCode = destination?.stateCode || "";

        app.layers.states
            .selectAll(".map-state")
            .classed("is-selected", (feature) => {
                return Boolean(selectedStateCode) && getStateCode(feature) === selectedStateCode;
            });

        app.layers.markers
            .selectAll(".destination-marker")
            .classed("is-selected", (item) => item.code === app.selectedCode)
            .attr("aria-pressed", (item) => {
                return item.code === app.selectedCode ? "true" : "false";
            });
    }

    function closeSelection({restoreFocus = false} = {}) {
        if (!app.selectedCode) return;

        app.selectedCode = null;
        elements.select.value = "";
        elements.popup.hidden = true;
        clearPopupPosition();

        updateSelectionStyles();
        renderRoute({animate: false});
        elements.status.textContent = "Selección de destino cerrada.";

        if (restoreFocus && app.lastTrigger?.isConnected) {
            app.lastTrigger.focus({preventScroll: true});
        }
    }

    function renderPopup(destination) {
        const popup = destination.popup;

        /*
          El JSON usa campos estructurados y se inserta con textContent. Si un CMS
          entrega HTML enriquecido, sanitízalo antes de incorporarlo al componente.
        */
        elements.popupEyebrow.textContent = popup.eyebrow || "Vuelo directo desde Tijuana";
        elements.popupTitle.textContent = popup.title || destination.city;
        elements.popupCode.textContent = destination.code;
        elements.popupAirport.hidden = !destination.airport;
        elements.popupAirport.textContent = destination.airport;
        elements.popupDescription.textContent = popup.description || "";

        elements.popupHours.textContent = Number.isFinite(destination.hours)
            ? `Duración aproximada: ${formatApproximateHours(destination.hours)}`
            : "";

        elements.popupHours.hidden = !Number.isFinite(destination.hours);

        elements.popupImage.alt = popup.imageAlt || `Imagen de ${destination.city}`;
        elements.popupImage.src = popup.image || buildPlaceholderImage(destination);
        elements.popupCtaLabel.textContent = popup.ctaLabel || "Conocer destino";

        const ctaUrl = String(popup.ctaUrl || "#").trim();
        const ctaDisabled = !ctaUrl || ctaUrl === "#";
        elements.popupCta.href = ctaDisabled ? "#" : ctaUrl;
        elements.popupCta.setAttribute("aria-disabled", String(ctaDisabled));
        elements.popupCta.tabIndex = ctaDisabled ? -1 : 0;

        elements.popup.hidden = false;
        window.requestAnimationFrame(positionPopup);
    }

    function positionPopup() {
        const destination = getSelectedDestination();

        if (!destination || elements.popup.hidden || !app.projection) return;

        if (isMobileLayout()) {
            clearPopupPosition();
            return;
        }

        const point = app.projection(destination.coordinates);
        if (!point) return;

        const viewportRect = elements.mapViewport.getBoundingClientRect();
        const experienceRect = elements.mapExperience.getBoundingClientRect();
        const popupRect = elements.popup.getBoundingClientRect();

        const viewportLeft = viewportRect.left - experienceRect.left;
        const viewportTop = viewportRect.top - experienceRect.top;
        const pointX = viewportLeft + point[0];
        const pointY = viewportTop + point[1];
        const margin = 10;
        const gap = 20;

        const minLeft = viewportLeft + margin;
        const maxLeft = viewportLeft + viewportRect.width - popupRect.width - margin;
        const minTop = viewportTop + margin;
        const maxTop = viewportTop + viewportRect.height - popupRect.height - margin;

        const rightCandidate = pointX + gap;
        const leftCandidate = pointX - popupRect.width - gap;
        const fitsRight = rightCandidate <= maxLeft;
        const fitsLeft = leftCandidate >= minLeft;

        let side = "right";
        let left = rightCandidate;

        if (!fitsRight && fitsLeft) {
            side = "left";
            left = leftCandidate;
        } else if (!fitsRight && !fitsLeft) {
            const roomRight = viewportLeft + viewportRect.width - pointX;
            const roomLeft = pointX - viewportLeft;
            side = roomRight >= roomLeft ? "right" : "left";
            left = side === "right" ? rightCandidate : leftCandidate;
        }

        left = clamp(left, minLeft, Math.max(minLeft, maxLeft));
        const top = clamp(
            pointY - popupRect.height / 2,
            minTop,
            Math.max(minTop, maxTop),
        );

        const arrowY = clamp(pointY - top, 24, popupRect.height - 24);

        elements.popup.classList.toggle("opens-right", side === "right");
        elements.popup.classList.toggle("opens-left", side === "left");
        elements.popup.style.left = `${left}px`;
        elements.popup.style.top = `${top}px`;
        elements.popup.style.setProperty("--popup-arrow-y", `${arrowY}px`);
    }

    function clearPopupPosition() {
        elements.popup.classList.remove("opens-right", "opens-left");
        elements.popup.style.removeProperty("left");
        elements.popup.style.removeProperty("top");
        elements.popup.style.removeProperty("--popup-arrow-y");
    }

    function getSelectedDestination() {
        return app.selectedCode
            ? app.destinationByCode.get(app.selectedCode) || null
            : null;
    }

    function getStateCode(feature) {
        const properties = feature?.properties || {};

        /*
          El adaptador reconoce el esquema local y nombres frecuentes de otras
          fuentes. Esto permite sustituir el GeoJSON sin dispersar condicionales.
        */
        return String(
            properties.code
            || properties.shapeISO
            || properties.iso_3166_2
            || properties.ISO_1
            || properties.adm1_code
            || "",
        ).toUpperCase();
    }

    function getStateName(feature) {
        const properties = feature?.properties || {};
        return String(
            properties.name
            || properties.shapeName
            || properties.NAME_1
            || properties.nom_agee
            || "Estado",
        );
    }

    function formatApproximateHours(hours) {
        const totalMinutes = Math.round(hours * 60);
        const wholeHours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (!minutes) {
            return `${wholeHours} h`;
        }

        return `${wholeHours} h ${minutes} min`;
    }

    function buildPlaceholderImage(destination) {
        const label = `${destination.code} · ${destination.city}`
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");

        const svg = `
          <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
            <rect width="640" height="360" fill="#e9edf2"/>
            <text x="320" y="180" dominant-baseline="middle" text-anchor="middle"
              fill="#172033" font-family="Arial, sans-serif" font-size="28" font-weight="700">${label}</text>
          </svg>`;

        return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }

    function isMobileLayout() {
        return window.matchMedia(`(max-width: ${CONFIG.mobileBreakpoint}px)`).matches;
    }

    function hideLoading() {
        elements.loading.classList.add("is-hidden");
    }

    function showFatalError(error) {
        console.error(error);

        const fileProtocolHint = window.location.protocol === "file:"
            ? " Inicia un servidor local; fetch no puede leer JSON de forma fiable desde file://."
            : "";

        if (elements.loading && elements.loadingText) {
            elements.loading.classList.remove("is-hidden");
            elements.loading.classList.add("is-error");
            elements.loadingText.textContent = `No fue posible cargar el mapa.${fileProtocolHint}`;
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
