// Maprika Clone Application - V2.19 (Finalized Debugging Structure)

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
        document.getElementById('clearSettingsButton').style.display = 'inline';
    } catch (e) {
        console.error("ERROR (Persistence): Could not save settings to localStorage:", e);
    }
}

function loadCalibrationSettings() {
    try {
        const settingsString = localStorage.getItem('maprikaCalibrationSettings');
        if (settingsString) {
            const settings = JSON.parse(settingsString);
            if (settings.P_real && settings.P_real.length === 4 && settings.P_pixel && settings.P_pixel.length === 4) {
                
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
        console.error("ERROR (Persistence): Could not load settings from localStorage:", e);
        return false;
    }
}

function clearCalibrationSettings() {
    localStorage.removeItem('maprikaCalibrationSettings');
    location.reload(); 
}


// --- GEOMETRY UTILITY FUNCTIONS ---
// (Requires 'numeric' library)
function calculateHomographyMatrix(P_pixel, P_real) {
    if (typeof numeric === 'undefined' || typeof numeric.solve === 'undefined') {
        throw new Error("Numeric library is not loaded or missing 'solve' function.");
    }
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


// --- LIVE DISPLAY & GPS FUNCTIONS / MAP VIEW TOGGLING LOGIC / CALIBRATION PHASE FUNCTIONS ---
// (All unchanged from V2.18 for brevity, only core logic is included below)

function updateLiveDisplay() {
    if (!mapInstance) return; 
    document.getElementById('zoomDisplay').textContent = mapInstance.getZoom();
    const center = mapInstance.getCenter();
    const mapType = (mapInstance.options.crs === L.CRS.EPSG3857) ? 'Lat/Lon' : 'Pixel (Y/X)';
    let coordText = (mapInstance.options.crs === L.CRS.EPSG3857) ? `Lat: ${center.lat.toFixed(6)}, Lon: ${center.lng.toFixed(6)}` : `Y: ${center.lat.toFixed(0)}, X: ${center.lng.toFixed(0)}`;
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
    document.getElementById('controlPointInfo').innerHTML = [currentStepText, ...info].join('<br>');
}

function centerMapOnGps() {
    if (!navigator.geolocation || currentMapView !== 'base') {
        alert(currentMapView === 'base' ? "Geolocation is not supported." : "Please switch to the Base Map to use GPS centering.");
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const currentLatLng = [position.coords.latitude, position.coords.longitude];
            mapInstance.setView(currentLatLng, mapInstance.getZoom());
        },
        (error) => {
            console.error("ERROR (GPS): Could not retrieve current GPS location for centering.", error);
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

function updateToggleButtons() {
    const baseBtn = document.getElementById('toggleBaseMap');
    const imgBtn = document.getElementById('toggleImageMap');
    const display = document.getElementById('activeMapDisplay');
    mapInstance.eachLayer(layer => {
        if (layer !== calibrationPoints.activeMarker && layer !== userMarker && layer !== accuracyCircle &&
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
        if (userMarker) { mapInstance.addLayer(userMarker); mapInstance.addLayer(accuracyCircle); userMarker.bringToFront(); }
        if (calibrationPoints.gpsPixelMarker) mapInstance.removeLayer(calibrationPoints.gpsPixelMarker);
        if (calibrationPoints.accuracyPixelCircle) mapInstance.removeLayer(calibrationPoints.accuracyPixelCircle);
    } else { // 'image' view
        baseBtn.classList.remove('active-toggle');
        imgBtn.classList.add('active-toggle');
        display.textContent = 'Active View: Image Map (Click to set Pixel X/Y)';
        if (calibrationPoints.mapImage) mapInstance.addLayer(calibrationPoints.mapImage);
        if (gpsButton) gpsButton.disabled = true;
        if (userMarker) mapInstance.removeLayer(userMarker);
        if (accuracyCircle) mapInstance.removeLayer(accuracyCircle);
        if (calibrationPoints.gpsPixelMarker) mapInstance.addLayer(calibrationPoints.gpsPixelMarker);
        if (calibrationPoints.accuracyPixelCircle) mapInstance.addLayer(calibrationPoints.accuracyPixelCircle);
        if (calibrationPoints.gpsPixelMarker) calibrationPoints.gpsPixelMarker.bringToFront();
    }
    if (calibrationPoints.activeMarker) { calibrationPoints.activeMarker.addTo(mapInstance).bringToFront(); }
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
    
    newMarker.on('drag', function(event) {
        const latlng = event.target.getLatLng();
        let statusText = (currentMapView === 'base') 
            ? `P${step} Current: Lat: ${latlng.lat.toFixed(6)}, Lon: ${latlng.lng.toFixed(6)}`
            : `P${step} Current: Y: ${latlng.lat.toFixed(0)}, X: ${latlng.lng.toFixed(0)}`;
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
    try {
        const step = calibrationPoints.currentStep;
        const marker = calibrationPoints.activeMarker;
        if (!marker) return;

        if (currentMapView === 'base') {
            calibrationPoints.P_real.push(marker.getLatLng());
            mapInstance.removeLayer(marker); 
            calibrationPoints.activeMarker = null;
            saveCurrentViewState();
            toggleToImageMap(); 
            document.getElementById('status-message').innerHTML = `**P${step} Real-World** confirmed. Click on the **Image Map** to set the corresponding pixel point.`;
            mapInstance.on('click', handleMapClick); 
        } else { // currentMapView === 'image'
            const finalLatLng = marker.getLatLng(); 
            calibrationPoints.P_pixel.push({x: finalLatLng.lng, y: finalLatLng.lat});
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
    } catch (e) {
        console.error("ERROR (Calibration): Failed during point confirmation.", e);
        document.getElementById('status-message').innerHTML = "🚨 **ERROR during calibration.** Check console.";
    }
}

function runFinalProjection() {
    try {
        const H = calculateHomographyMatrix(calibrationPoints.P_pixel, calibrationPoints.P_real);
        calibrationPoints.H_matrix = H;
        const H_inv = numeric.inv(H); 
        calibrationPoints.H_inv = H_inv;
        calibrationPoints.avgScaleFactor = calculateAverageScaleFactor(calibrationPoints.P_pixel, calibrationPoints.P_real);
        saveCalibrationSettings();
        document.getElementById('status-message').innerHTML = `✅ **Calibration Complete!** Scale: ${calibrationPoints.avgScaleFactor.toFixed(3)} M/px. <span id="clearSettingsContainer"><button id="clearSettingsButton" class="small-button">Clear Settings</button></span>`;
        document.getElementById('clearSettingsButton').addEventListener('click', clearCalibrationSettings);
        document.getElementById('confirmPointButton').style.display = 'none';
        mapInstance.off('click', handleMapClick); 
        if (currentMapView === 'image' && calibrationPoints.mapImage) {
            const {width, height} = calibrationPoints.imageDimensions;
            calibrationPoints.mapImage.setBounds([[0, 0], [height, width]]);
        }
    } catch (e) {
        console.error("ERROR (Projection): Failed during final projection calculation.", e);
        document.getElementById('status-message').innerHTML = "🚨 **ERROR during projection calculation.** Check console.";
    }
}

function runLoadedProjection() {
    try {
        const H = calculateHomographyMatrix(calibrationPoints.P_pixel, calibrationPoints.P_real);
        calibrationPoints.H_matrix = H;
        const H_inv = numeric.inv(H); 
        calibrationPoints.H_inv = H_inv;
        calibrationPoints.avgScaleFactor = calculateAverageScaleFactor(calibrationPoints.P_pixel, calibrationPoints.P_real);

        document.getElementById('toggleBaseMap').disabled = false;
        document.getElementById('toggleImageMap').disabled = false;
        document.getElementById('centerGpsButton').disabled = false; 

        document.getElementById('status-message').innerHTML = `✅ **Calibration Loaded!** Scale: ${calibrationPoints.avgScaleFactor.toFixed(3)} M/px. <span id="clearSettingsContainer"><button id="clearSettingsButton" class="small-button">Clear Settings</button></span>`;
        document.getElementById('clearSettingsButton').addEventListener('click', clearCalibrationSettings);
    } catch (e) {
        console.error("ERROR (Projection): Failed during loaded projection calculation.", e);
        document.getElementById('status-message').innerHTML = "🚨 **ERROR during loaded projection.** Check console.";
    }
}

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
            // ... (GPS update logic) ...
            if (!userMarker) {
                userMarker = L.marker(currentLatLng, { icon: realMarkerIcon }).addTo(mapInstance);
                accuracyCircle = L.circle(currentLatLng, { radius: accuracy_real, color: '#3080ff', fillColor: '#3080ff', fillOpacity: 0.2, weight: 1 }).addTo(mapInstance);
            } else {
                userMarker.setLatLng(currentLatLng).bringToFront();
                accuracyCircle.setLatLng(currentLatLng).setRadius(accuracy_real);
            }
            if (calibrationPoints.H_inv) {
                const pixelPoint = projectGpsToPixel(calibrationPoints.H_inv, lon, lat);
                if (pixelPoint) {
                    const pixelLatLng = L.latLng(pixelPoint.y, pixelPoint.x);
                    let accuracy_pixel = (calibrationPoints.avgScaleFactor > 0) ? accuracy_real / calibrationPoints.avgScaleFactor : 50;
                    if (!calibrationPoints.gpsPixelMarker) {
                        calibrationPoints.gpsPixelMarker = L.marker(pixelLatLng, { icon: gpsDotIcon });
                        calibrationPoints.accuracyPixelCircle = L.circle(pixelLatLng, { 
                            radius: accuracy_pixel, color: '#3080ff', fillColor: '#3080ff', fillOpacity: 0.2, weight: 1 
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
            console.error("ERROR (GPS Tracking): Failed to watch position.", error);
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
}


// --- MAIN EXECUTION AND SETUP PHASE ---

function initializeMapAndListeners(mapUrl) {
    try {
        // 1. Check for Leaflet availability
        if (typeof L === 'undefined') {
            throw new Error("Leaflet library (L) is not defined. Ensure leaflet.js is loaded first.");
        }
        
        // 2. Map Initialization/Reset
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

            // Attach event listeners to buttons (only once)
            document.getElementById('centerGpsButton').addEventListener('click', centerMapOnGps);
            document.getElementById('confirmPointButton').addEventListener('click', confirmCurrentPoint);
            document.getElementById('toggleBaseMap').addEventListener('click', toggleToBaseMap);
            document.getElementById('toggleImageMap').addEventListener('click', toggleToImageMap);

        } else {
            // Map Reset
            mapInstance.options.crs = L.CRS.EPSG3857; 
            mapInstance.eachLayer(layer => {
                if (layer !== osmLayer && layer !== userMarker && layer !== accuracyCircle) {
                    mapInstance.removeLayer(layer);
                }
            });
            if (!mapInstance.hasLayer(osmLayer)) mapInstance.addLayer(osmLayer);
        }
        
        // 3. Reset Calibration State
        calibrationPoints = { 
            currentStep: 1, P_pixel: [], P_real: [], activeMarker: null, mapImage: null, imageDimensions: {},
            H_matrix: null, H_inv: null, 
            gpsPixelMarker: calibrationPoints.gpsPixelMarker, 
            accuracyPixelCircle: calibrationPoints.accuracyPixelCircle, 
            avgScaleFactor: 0 
        };
        
        document.getElementById('confirmPointButton').style.display = 'none';

        // 4. Start/Restart continuous GPS tracking 
        startGpsTracking(); 
        
        // 5. Load Settings Check
        const hasLoadedSettings = loadCalibrationSettings();

        document.getElementById('status-message').innerHTML = 'Loading image...';
        
        // 6. Image Loading
        const image = new Image();
        image.onerror = function() {
            console.error("ERROR (Image Load): Image failed to load from URL:", mapUrl);
            document.getElementById('status-message').innerHTML = 'Image loading failed.';
            alert("❌ Error: Could not load the image from the provided URL. Check the URL and file access.");
        };
        
        image.onload = function() {
            try {
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
                
                document.getElementById('toggleBaseMap').disabled = false;
                document.getElementById('toggleImageMap').disabled = false;
                document.getElementById('centerGpsButton').disabled = false; 

                if (hasLoadedSettings) {
                    runLoadedProjection();
                } else {
                    document.getElementById('status-message').innerHTML = `Image loaded (${width}x${height}). Click on the map to set **P1 (Real-World)** point.`;
                    mapInstance.on('click', handleMapClick); 
                }

                updateToggleButtons(); 
                updateLiveDisplay(); 
            } catch (e) {
                console.error("ERROR (Image Onload): Error occurred during image map setup.", e);
                document.getElementById('status-message').innerHTML = "🚨 **CRITICAL ERROR** during map setup.";
            }
        };
        
        image.src = mapUrl;
    } catch (e) {
        console.error("CRITICAL ERROR: Failed to initialize map and listeners.", e);
        document.getElementById('status-message').innerHTML = "🚨 **CRITICAL ERROR: Map initialization failed.** Check console for details.";
    }
}

// -----------------------------------------------------------------
// --- FINAL EVENT ATTACHMENTS (DOM Ready) ---
// -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', (event) => {
    try {
        const startBtn = document.getElementById('startCalibrationButton');
        const mapUrlField = document.getElementById('mapUrl');
        
        // Initial status check before the map is even initialized
        loadCalibrationSettings();

        if (startBtn) {
            startBtn.addEventListener('click', function() {
                try {
                    const currentMapUrl = mapUrlField.value.trim();
                    if (!currentMapUrl) {
                        alert("🚨 Error: Please enter a Map Image URL before starting calibration.");
                        return; 
                    }
                    initializeMapAndListeners(currentMapUrl);
                } catch (e) {
                    console.error("ERROR (Start Button): Failed to process Start Calibration click.", e);
                    alert("🚨 An unexpected error occurred when starting calibration. Check console.");
                }
            });
        }
    } catch (e) {
        console.error("CRITICAL ERROR: Failed during DOM content load setup.", e);
    }
});