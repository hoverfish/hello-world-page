// Maprika Clone Application - V2.16 (Start Button Click Fix and Flow Refinement)

// Global variables to hold the map instance and tracking markers
let mapInstance = null;
let osmLayer = null; 

// Base Map GPS Markers (Real CRS)
let userMarker = null; 
let accuracyCircle = null; 
const realMarkerIcon = L.divIcon({className: 'gps-marker-icon', html: '📍'});
const gpsDotIcon = L.divIcon({className: 'gps-dot-icon', html: '', iconSize: [10, 10]}); 


// New Globals to store independent view states
let baseMapViewState = { center: [40.7, -74.0], zoom: 13 }; 
let imageMapViewState = { center: [0, 0], zoom: 0 };       

// Global state variables for Calibration
let currentMapView = 'base'; // 'base' or 'image'
let calibrationPoints = {
    currentStep: 1,      
    P_pixel: [],         
    P_real: [],          
    activeMarker: null,  
    mapImage: null,      
    imageDimensions: {},
    H_matrix: null,       
    H_inv: null,          
    gpsPixelMarker: null,  
    accuracyPixelCircle: null,
    avgScaleFactor: 0 
};
let gpsWatchId = null;     


// --- PERSISTENCE FUNCTIONS ---

function saveCalibrationSettings() {
    try {
        const settings = {
            P_real: calibrationPoints.P_real,
            P_pixel: calibrationPoints.P_pixel
        };
        localStorage.setItem('maprikaCalibrationSettings', JSON.stringify(settings));
        
        // Ensure the button is visible after saving
        document.getElementById('clearSettingsButton').style.display = 'inline';

    } catch (e) {
        console.error("Could not save settings to localStorage:", e);
    }
}

function loadCalibrationSettings() {
    try {
        const settingsString = localStorage.getItem('maprikaCalibrationSettings');
        if (settingsString) {
            const settings = JSON.parse(settingsString);
            if (settings.P_real && settings.P_real.length === 4 && settings.P_pixel && settings.P_pixel.length === 4) {
                
                // Convert plain objects back to L.LatLng objects
                // Note: L.latLng expects (lat, lng). P_pixel is stored as {x: Lng, y: Lat}
                calibrationPoints.P_real = settings.P_real.map(p => L.latLng(p.lat, p.lng));
                calibrationPoints.P_pixel = settings.P_pixel.map(p => ({x: p.lng, y: p.lat}));
                
                // Set up the status message and clear button container
                document.getElementById('status-message').innerHTML = '✅ **Saved calibration found!** Running projection... <span id="clearSettingsContainer"></span>';
                document.getElementById('clearSettingsContainer').innerHTML = '<button id="clearSettingsButton" class="small-button">Clear Settings</button>';
                document.getElementById('clearSettingsButton').addEventListener('click', clearCalibrationSettings);

                return true; 
            }
        }
        document.getElementById('status-message').innerHTML = 'Click \'**Start Calibration**\' to begin.';
        return false;
    } catch (e) {
        console.error("Could not load settings from localStorage:", e);
        return false;
    }
}

function clearCalibrationSettings() {
    localStorage.removeItem('maprikaCalibrationSettings');
    
    // Use location.reload() for a clean reset
    location.reload(); 
}


// --- GEOMETRY UTILITY FUNCTIONS ---
// (Unchanged from V2.15)
function calculateHomographyMatrix(P_pixel, P_real) {
    const A = [];
    const B = [];
    for (let i = 0; i < 4; i++) {
        const x_p = P_pixel[i].x;
        const y_p = P_pixel[i].y;
        const x_r = P_real[i].lng;
        const y_r = P_real[i].lat;

        A.push([x_p, y_p, 1, 0, 0, 0, -x_r * x_p, -x_r * y_p]);
        B.push(x_r);
        A.push([0, 0, 0, x_p, y_p, 1, -y_r * x_p, -y_r * y_p]);
        B.push(y_r);
    }
    const h_params = numeric.solve(A, B);
    const H = [
        [h_params[0], h_params[1], h_params[2]],
        [h_params[3], h_params[4], h_params[5]],
        [h_params[6], h_params[7], 1]
    ];
    return H;
}

function calculateAverageScaleFactor(P_pixel, P_real) {
    if (P_pixel.length < 4 || P_real.length < 4) return 0;
    
    let totalScaleFactor = 0;
    let count = 0;

    for (let i = 0; i < P_pixel.length; i++) {
        for (let j = i + 1; j < P_pixel.length; j++) {
            const dx_px = P_pixel[i].x - P_pixel[j].x;
            const dy_px = P_pixel[i].y - P_pixel[j].y;
            const dist_px = Math.sqrt(dx_px * dx_px + dy_px * dy_px);

            const p1_real = L.latLng(P_real[i].lat, P_real[i].lng);
            const p2_real = L.latLng(P_real[j].lat, P_real[j].lng);
            const dist_m = p1_real.distanceTo(p2_real);

            if (dist_px > 0) {
                totalScaleFactor += dist_m / dist_px;
                count++;
            }
        }
    }
    
    return count > 0 ? totalScaleFactor / count : 0; 
}

function projectGpsToPixel(H_inv, lon, lat) {
    if (!H_inv) return null;

    const p = [lon, lat, 1];
    const p_prime = numeric.dot(H_inv, p);
    const w = p_prime[2];
    
    if (Math.abs(w) < 1e-6) return null; 
    
    const x_pixel = p_prime[0] / w;
    const y_pixel = p_prime[1] / w;
    
    return {x: x_pixel, y: y_pixel};
}


// --- LIVE DISPLAY & GPS FUNCTIONS ---
// (Unchanged from V2.15)
function updateLiveDisplay() {
    if (!mapInstance) return; 

    document.getElementById('zoomDisplay').textContent = mapInstance.getZoom();

    const center = mapInstance.getCenter();
    const mapType = (mapInstance.options.crs === L.CRS.EPSG3857) ? 'Lat/Lon' : 'Pixel (Y/X)';
    
    let coordText;
    if (mapInstance.options.crs === L.CRS.EPSG3857) {
        coordText = `Lat: ${center.lat.toFixed(6)}, Lon: ${center.lng.toFixed(6)}`;
    } else {
        coordText = `Y: ${center.lat.toFixed(0)}, X: ${center.lng.toFixed(0)}`;
    }
    document.getElementById('coordDisplay').textContent = `Center (${mapType}): ${coordText}`;
    
    updateControlPointInfo();
}

function updateControlPointInfo() {
    if (!mapInstance) return; 
    
    let info = [];
    for (let i = 0; i < calibrationPoints.P_real.length; i++) {
        const pR = calibrationPoints.P_real[i];
        const pP = calibrationPoints.P_pixel[i];
        
        let pR_text = pR ? `(Lon: ${pR.lng.toFixed(4)}, Lat: ${pR.lat.toFixed(4)})` : 'N/A';
        let pP_text = pP ? `(X: ${pP.x.toFixed(0)}, Y: ${pP.y.toFixed(0)})` : 'N/A';
        
        info.push(`P${i + 1}: Real ${pR_text} / Pixel ${pP_text}`);
    }
    
    let currentStepText = '';
    if (calibrationPoints.currentStep <= 4) {
        currentStepText = `P${calibrationPoints.currentStep}: Collecting ${currentMapView === 'base' ? 'Real' : 'Pixel'}`;
    } else if (calibrationPoints.H_inv) {
        currentStepText = `✅ Calibration Complete! Scale: ${calibrationPoints.avgScaleFactor.toFixed(3)} M/px`;
    }
    
    document.getElementById('controlPointInfo').innerHTML = 
        [currentStepText, ...info].join('<br>');
}

function centerMapOnGps() {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }
    
    if (currentMapView !== 'base') {
        alert("Please switch to the Base Map to use GPS centering.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const currentLatLng = [position.coords.latitude, position.coords.longitude];
            mapInstance.setView(currentLatLng, mapInstance.getZoom());
        },
        (error) => {
            console.error("Geolocation Error:", error);
            alert("Could not retrieve current GPS location.");
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
}

function saveCurrentViewState() {
    if (!mapInstance) return;

    if (mapInstance.options.crs === L.CRS.EPSG3857) {
        const center = mapInstance.getCenter();
        if (center.lat > -90 && center.lat < 90) {
            baseMapViewState.center = center;
            baseMapViewState.zoom = mapInstance.getZoom();
        }
    } else if (mapInstance.options.crs === L.CRS.Simple) {
        imageMapViewState.center = mapInstance.getCenter();
        imageMapViewState.zoom = mapInstance.getZoom();
    }
}


// --- MAP VIEW TOGGLING LOGIC ---
// (Unchanged from V2.15)
function updateToggleButtons() {
    const baseBtn = document.getElementById('toggleBaseMap');
    const imgBtn = document.getElementById('toggleImageMap');
    const display = document.getElementById('activeMapDisplay');

    // 1. Clear Map of ALL layers EXCEPT active marker
    mapInstance.eachLayer(layer => {
        // Keep the active calibration marker, and the GPS markers IF they are not null
        if (layer !== calibrationPoints.activeMarker && 
            layer !== userMarker && layer !== accuracyCircle &&
            layer !== calibrationPoints.gpsPixelMarker && layer !== calibrationPoints.accuracyPixelCircle) { 
            mapInstance.removeLayer(layer);
        }
    });
    
    const gpsButton = document.getElementById('centerGpsButton');
    
    if (currentMapView === 'base') {
        baseBtn.classList.add('active-toggle');
        imgBtn.classList.remove('active-toggle');
        display.textContent = 'Active View: Base Map (Click to set Lat/Lon)';
        
        if (osmLayer) mapInstance.addLayer(osmLayer);
        if (gpsButton) gpsButton.disabled = false;
        
        // Show real GPS items on BaseMap
        if (userMarker) {
            mapInstance.addLayer(userMarker);
            mapInstance.addLayer(accuracyCircle);
            userMarker.bringToFront();
        }
        // Hide projected GPS items
        if (calibrationPoints.gpsPixelMarker) mapInstance.removeLayer(calibrationPoints.gpsPixelMarker);
        if (calibrationPoints.accuracyPixelCircle) mapInstance.removeLayer(calibrationPoints.accuracyPixelCircle);


    } else { // 'image' view
        baseBtn.classList.remove('active-toggle');
        imgBtn.classList.add('active-toggle');
        display.textContent = 'Active View: Image Map (Click to set Pixel X/Y)';
        
        if (calibrationPoints.mapImage) mapInstance.addLayer(calibrationPoints.mapImage);
        if (gpsButton) gpsButton.disabled = true;
        
        // Hide real GPS items
        if (userMarker) mapInstance.removeLayer(userMarker);
        if (accuracyCircle) mapInstance.removeLayer(accuracyCircle);
        
        // Show projected GPS items (if tracking is active)
        if (calibrationPoints.gpsPixelMarker) mapInstance.addLayer(calibrationPoints.gpsPixelMarker);
        if (calibrationPoints.accuracyPixelCircle) mapInstance.addLayer(calibrationPoints.accuracyPixelCircle);
        if (calibrationPoints.gpsPixelMarker) calibrationPoints.gpsPixelMarker.bringToFront();
    }
    
    if (calibrationPoints.activeMarker) {
         calibrationPoints.activeMarker.addTo(mapInstance).bringToFront();
    }
    
    mapInstance.invalidateSize(); 
}

function toggleToBaseMap() {
    if (currentMapView === 'base') return; 
    
    saveCurrentViewState();

    mapInstance.options.crs = L.CRS.EPSG3857;
    currentMapView = 'base';
    updateToggleButtons();

    mapInstance.setView(baseMapViewState.center, baseMapViewState.zoom);
    updateLiveDisplay();
}

function toggleToImageMap() {
    if (currentMapView === 'image') return;
    
    saveCurrentViewState();
    
    mapInstance.options.crs = L.CRS.Simple;
    
    if (calibrationPoints.mapImage) {
        const {width, height} = calibrationPoints.imageDimensions;
        const bounds = [[0, 0], [height, width]];
        
        calibrationPoints.mapImage.setBounds(bounds);
        
        if (imageMapViewState.zoom === 0) {
             mapInstance.fitBounds(bounds); 
        } else {
             mapInstance.setView(imageMapViewState.center, imageMapViewState.zoom);
        }
    }

    currentMapView = 'image';
    updateToggleButtons();
    updateLiveDisplay();
}


// --- CALIBRATION PHASE FUNCTIONS ---
// (Unchanged from V2.15)
function handleMapClick(e) {
    const step = calibrationPoints.currentStep;
    
    if (calibrationPoints.activeMarker) return;
    mapInstance.off('click', handleMapClick); 

    const iconHtml = `<div class="pinpoint-marker"><label>P${step}</label></div>`;
    
    const newMarker = L.marker(e.latlng, {
        draggable: true,
        title: `P${step}`,
        icon: L.divIcon({className: 'pinpoint-marker', html: iconHtml})
    }).addTo(mapInstance);

    calibrationPoints.activeMarker = newMarker;
    
    // --- LIVE PLACEMENT UPDATE ---
    newMarker.on('drag', function(event) {
        const latlng = event.target.getLatLng();
        let statusText;
        if (currentMapView === 'base') {
            statusText = `P${step} Current: Lat: ${latlng.lat.toFixed(6)}, Lon: ${latlng.lng.toFixed(6)}`;
        } else {
            statusText = `P${step} Current: Y: ${latlng.lat.toFixed(0)}, X: ${latlng.lng.toFixed(0)}`;
        }
        document.getElementById('status-message').innerHTML = statusText;
    });

    newMarker.on('dragend', function() {
        document.getElementById('status-message').innerHTML = `P${step} position updated. Click **Confirm Point** to finalize.`;
    });
    
    document.getElementById('status-message').innerHTML = `P${step} set on the **${currentMapView === 'base' ? 'Base Map' : 'Image Map'}**. Drag the marker to adjust, then click **Confirm Point**.`;
    document.getElementById('confirmPointButton').style.display = 'inline';
    
    newMarker.bringToFront(); 
}

function confirmCurrentPoint() {
    const step = calibrationPoints.currentStep;
    const marker = calibrationPoints.activeMarker;
    if (!marker) return;

    if (currentMapView === 'base') {
        const finalLatLng = marker.getLatLng();
        calibrationPoints.P_real.push(finalLatLng);
        
        mapInstance.removeLayer(marker); 
        calibrationPoints.activeMarker = null;
        
        saveCurrentViewState();

        toggleToImageMap(); 
        document.getElementById('status-message').innerHTML = `**P${step} Real-World** confirmed. Click on the **Image Map** to set the corresponding pixel point.`;
        
        mapInstance.on('click', handleMapClick); 
        
    } else { // currentMapView === 'image'
        const finalLatLng = marker.getLatLng(); 
        
        const x_px = finalLatLng.lng;
        const y_px = finalLatLng.lat;
        
        calibrationPoints.P_pixel.push({x: x_px, y: y_px});
        
        mapInstance.removeLayer(marker); 
        calibrationPoints.activeMarker = null;
        document.getElementById('confirmPointButton').style.display = 'none';

        saveCurrentViewState();

        calibrationPoints.currentStep++;
        
        if (calibrationPoints.currentStep <= 4) {
            toggleToBaseMap(); 
            document.getElementById('status-message').innerHTML = `**P${step} Pixel** confirmed. Click on the **Base Map** to set **P${calibrationPoints.currentStep} Real-World** point.`;
            mapInstance.on('click', handleMapClick); 
        } else {
            document.getElementById('status-message').innerHTML = 'Calibration complete! Calculating projection...';
            runFinalProjection(); 
        }
    }
    
    updateControlPointInfo(); 
}

function runFinalProjection() {
    // 1. Calculate the Homography Matrix (Pixel -> Real)
    const H = calculateHomographyMatrix(calibrationPoints.P_pixel, calibrationPoints.P_real);
    calibrationPoints.H_matrix = H;

    // 2. Calculate the Inverse Homography Matrix (Real -> Pixel)
    const H_inv = numeric.inv(H); 
    calibrationPoints.H_inv = H_inv;
    
    // 3. Calculate Average Scale Factor (Meters/Pixel)
    calibrationPoints.avgScaleFactor = calculateAverageScaleFactor(
        calibrationPoints.P_pixel, 
        calibrationPoints.P_real
    );
    
    // 4. Save settings for next session
    saveCalibrationSettings();
    
    document.getElementById('status-message').innerHTML = `✅ **Calibration Complete!** Scale: ${calibrationPoints.avgScaleFactor.toFixed(3)} M/px. <span id="clearSettingsContainer"><button id="clearSettingsButton" class="small-button">Clear Settings</button></span>`;
    document.getElementById('clearSettingsButton').addEventListener('click', clearCalibrationSettings);
    
    document.getElementById('confirmPointButton').style.display = 'none';
    
    // Remove the temporary map click listener used for calibration
    mapInstance.off('click', handleMapClick); 
    
    if (currentMapView === 'image' && calibrationPoints.mapImage) {
        const {width, height} = calibrationPoints.imageDimensions;
        calibrationPoints.mapImage.setBounds([[0, 0], [height, width]]);
    }
}

/**
 * Runs the projection using loaded calibration settings, skipping interactive steps.
 */
function runLoadedProjection() {
    // 1. Calculate the Homography Matrix (Pixel -> Real)
    const H = calculateHomographyMatrix(calibrationPoints.P_pixel, calibrationPoints.P_real);
    calibrationPoints.H_matrix = H;

    // 2. Calculate the Inverse Homography Matrix (Real -> Pixel)
    const H_inv = numeric.inv(H); 
    calibrationPoints.H_inv = H_inv;
    
    // 3. Calculate Average Scale Factor (Meters/Pixel)
    calibrationPoints.avgScaleFactor = calculateAverageScaleFactor(
        calibrationPoints.P_pixel, 
        calibrationPoints.P_real
    );

    // FIX: Re-enable buttons which might have been disabled
    document.getElementById('startCalibrationButton').disabled = false; 

    // Enable toggle buttons immediately
    document.getElementById('toggleBaseMap').disabled = false;
    document.getElementById('toggleImageMap').disabled = false;
    document.getElementById('centerGpsButton').disabled = false; 

    // Update status to reflect loaded state
    document.getElementById('status-message').innerHTML = `✅ **Calibration Loaded!** Scale: ${calibrationPoints.avgScaleFactor.toFixed(3)} M/px. <span id="clearSettingsContainer"><button id="clearSettingsButton" class="small-button">Clear Settings</button></span>`;
    document.getElementById('clearSettingsButton').addEventListener('click', clearCalibrationSettings);
}


// --- CONTINUOUS GPS TRACKING (Unified BaseMap & ImageMap) ---
// (Unchanged from V2.15)
function startGpsTracking() {
    if (!navigator.geolocation) {
        console.error("Geolocation is not supported by your browser.");
        return;
    }

    if (gpsWatchId) {
        navigator.geolocation.clearWatch(gpsWatchId);
    }
    
    gpsWatchId = navigator.geolocation.watchPosition(
        (position) => {
            const lon = position.coords.longitude;
            const lat = position.coords.latitude;
            const accuracy_real = position.coords.accuracy; 
            const currentLatLng = L.latLng(lat, lon);

            // --- 1. UPDATE BASE MAP (Real CRS) MARKERS ---
            if (!userMarker) {
                userMarker = L.marker(currentLatLng, { icon: realMarkerIcon }).addTo(mapInstance);
                accuracyCircle = L.circle(currentLatLng, { radius: accuracy_real, color: '#3080ff', fillColor: '#3080ff', fillOpacity: 0.2, weight: 1 }).addTo(mapInstance);
            } else {
                userMarker.setLatLng(currentLatLng).bringToFront();
                accuracyCircle.setLatLng(currentLatLng).setRadius(accuracy_real);
            }

            // --- 2. UPDATE IMAGE MAP (Simple CRS) MARKERS ---
            if (calibrationPoints.H_inv) {
                const pixelPoint = projectGpsToPixel(calibrationPoints.H_inv, lon, lat);
                if (pixelPoint) {
                    const pixelLatLng = L.latLng(pixelPoint.y, pixelPoint.x);
                    
                    let accuracy_pixel;
                    if (calibrationPoints.avgScaleFactor > 0) {
                        accuracy_pixel = accuracy_real / calibrationPoints.avgScaleFactor;
                    } else {
                        accuracy_pixel = 50; 
                    }

                    if (!calibrationPoints.gpsPixelMarker) {
                        calibrationPoints.gpsPixelMarker = L.marker(pixelLatLng, { icon: gpsDotIcon });
                        calibrationPoints.accuracyPixelCircle = L.circle(pixelLatLng, { 
                            radius: accuracy_pixel, 
                            color: '#3080ff', 
                            fillColor: '#3080ff', 
                            fillOpacity: 0.2, 
                            weight: 1 
                        });
                    } else {
                        calibrationPoints.gpsPixelMarker.setLatLng(pixelLatLng);
                        calibrationPoints.accuracyPixelCircle.setLatLng(pixelLatLng).setRadius(accuracy_pixel); 
                    }
                }
            }
            updateToggleButtons(); 
        },
        (error) => {
            console.error("Geolocation Tracking Error:", error);
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
}


// --- MAIN EXECUTION AND SETUP PHASE ---

function initializeMapAndListeners(mapUrl, isFreshStart = false) { // Added isFreshStart flag
    if (!mapInstance) {
        mapInstance = L.map('map', {
            minZoom: -4, 
            maxZoom: 20, 
        }).setView(baseMapViewState.center, baseMapViewState.zoom);
        
        osmLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012',
            maxZoom: 20 
        });
        mapInstance.addLayer(osmLayer);
        
        mapInstance.on('moveend', saveCurrentViewState);
        mapInstance.on('zoomend', saveCurrentViewState);
        mapInstance.on('moveend', updateLiveDisplay);
        mapInstance.on('zoomend', updateLiveDisplay);

        // Initial setup for buttons (only needs to happen once)
        document.getElementById('centerGpsButton').addEventListener('click', centerMapOnGps);
        document.getElementById('confirmPointButton').addEventListener('click', confirmCurrentPoint);
        document.getElementById('toggleBaseMap').addEventListener('click', toggleToBaseMap);
        document.getElementById('toggleImageMap').addEventListener('click', toggleToImageMap);
    } else {
        mapInstance.options.crs = L.CRS.EPSG3857; 
        mapInstance.options.maxZoom = 20; 
        mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
        if (osmLayer) mapInstance.addLayer(osmLayer);
    }
    
    // Clear all calibration state EXCEPT GPS markers, which are continuously tracked
    calibrationPoints = { 
        currentStep: 1, P_pixel: [], P_real: [], activeMarker: null, mapImage: null, imageDimensions: {},
        H_matrix: null, H_inv: null, 
        gpsPixelMarker: calibrationPoints.gpsPixelMarker, 
        accuracyPixelCircle: calibrationPoints.accuracyPixelCircle, 
        avgScaleFactor: 0 
    };

    document.getElementById('confirmPointButton').style.display = 'none';

    // Start continuous GPS tracking (Ensures markers are initialized and updating)
    startGpsTracking(); 
    
    // Load settings only if it's not a fresh start click
    const hasLoadedSettings = !isFreshStart && loadCalibrationSettings();

    document.getElementById('status-message').innerHTML = 'Loading image...';
    
    const image = new Image();
    
    image.onerror = function() {
        document.getElementById('status-message').innerHTML = 'Image loading failed.';
        alert("❌ Error: Could not load the image from the provided URL. Please check the link and ensure the image is publicly accessible (JPG/PNG).");
    };
    
    image.onload = function() {
        const width = this.width;
        const height = this.height;

        calibrationPoints.imageDimensions = {width, height};

        const tempBounds = L.latLngBounds([10, -180], [80, 180]); 
        
        calibrationPoints.mapImage = L.imageOverlay(mapUrl, tempBounds, {
            opacity: 1.0, 
            attribution: 'Calibration Image Overlay',
            interactive: false 
        });
        
        currentMapView = 'base'; 
        
        // Enable toggle and center buttons
        document.getElementById('toggleBaseMap').disabled = false;
        document.getElementById('toggleImageMap').disabled = false;
        document.getElementById('centerGpsButton').disabled = false; 

        if (hasLoadedSettings) {
             runLoadedProjection();
        } else {
             // START INTERACTIVE CALIBRATION FLOW
             document.getElementById('status-message').innerHTML = `Image loaded (${width}x${height}). Click on the map to set **P1 (Real-World)** point.`;
             mapInstance.on('click', handleMapClick); 
        }

        updateToggleButtons(); 
        updateLiveDisplay(); 
    };
    
    image.src = mapUrl;
}

// -----------------------------------------------------------------
// --- FINAL EVENT ATTACHMENTS (DOM Ready Fix) ---
// -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', (event) => {
    const startBtn = document.getElementById('startCalibrationButton');
    const mapUrlField = document.getElementById('mapUrl');
    
    if (mapUrlField.value.trim()) {
        // Initial automatic load if a URL is already in the field (e.g., from index.html default)
        initializeMapAndListeners(mapUrlField.value.trim(), false);
    } else {
         // Load saved settings display even if map isn't initialized yet
         loadCalibrationSettings();
    }
    
    if (startBtn) {
        startBtn.addEventListener('click', function() {
            const currentMapUrl = mapUrlField.value.trim();
            if (!currentMapUrl) {
                alert("🚨 Error: Please enter a Map Image URL before starting calibration.");
                return; 
            }
            // Force a fresh start, ignoring any saved settings in this session
            initializeMapAndListeners(currentMapUrl, true);
        });
    }
});