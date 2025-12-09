// Maprika Clone Application - V2.14 (Continuous BaseMap GPS Tracking & Zoom Level)

// Global variables to hold the map instance and tracking markers
let mapInstance = null;
let userMarker = null; // Marker for GPS on the Base Map (Real CRS)
let accuracyCircle = null; 
let osmLayer = null; 

// New Globals to store independent view states
let baseMapViewState = { center: [40.7, -74.0], zoom: 13 }; 
let imageMapViewState = { center: [0, 0], zoom: 0 };       

// Global state variables for Calibration
let currentMapView = 'base'; // 'base' or 'image'
let calibrationPoints = {
    currentStep: 1,      // 1 to 4
    P_pixel: [],         
    P_real: [],          
    activeMarker: null,  
    mapImage: null,      
    imageDimensions: {},
    H_matrix: null,       
    H_inv: null,          
    gpsPixelMarker: null,  
    accuracyPixelCircle: null,
    avgScaleFactor: 0 // Average scale in Meters per Pixel (M/px)
};
let gpsWatchId = null;     


// --- GEOMETRY UTILITY FUNCTIONS ---

function calculateHomographyMatrix(P_pixel, P_real) {
    const A = [];
    const B = [];
    for (let i = 0; i < 4; i++) {
        const x_p = P_pixel[i].x;
        const y_p = P_pixel[i].y;
        const x_r = P_real[i].lng;
        const y_r = P_real[i].lat;

        // Equations derived from the homography matrix for A*h = B
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

/**
 * Calculates the average scale factor (Meters per Pixel) based on 
 * distances between calibration points.
 */
function calculateAverageScaleFactor(P_pixel, P_real) {
    if (P_pixel.length < 4 || P_real.length < 4) return 0;
    
    let totalScaleFactor = 0;
    let count = 0;

    // Iterate through all unique pairs of points
    for (let i = 0; i < P_pixel.length; i++) {
        for (let j = i + 1; j < P_pixel.length; j++) {
            // 1. Calculate Pixel Distance (in pixels)
            const dx_px = P_pixel[i].x - P_pixel[j].x;
            const dy_px = P_pixel[i].y - P_pixel[j].y;
            const dist_px = Math.sqrt(dx_px * dx_px + dy_px * dy_px);

            // 2. Calculate Geographic Distance (in meters)
            const p1_real = L.latLng(P_real[i].lat, P_real[i].lng);
            const p2_real = L.latLng(P_real[j].lat, P_real[j].lng);
            const dist_m = p1_real.distanceTo(p2_real);

            if (dist_px > 0) {
                // Scale factor is Meters per Pixel (M/px)
                totalScaleFactor += dist_m / dist_px;
                count++;
            }
        }
    }
    
    return count > 0 ? totalScaleFactor / count : 0; // Avg Meters per Pixel
}

/**
 * Projects a geographic coordinate (Lon, Lat) to a pixel coordinate (X, Y) on the image.
 * Uses the Inverse Homography Matrix (H_inv).
 */
function projectGpsToPixel(H_inv, lon, lat) {
    if (!H_inv) return null;

    const p = [lon, lat, 1];
    const p_prime = numeric.dot(H_inv, p);
    const w = p_prime[2];
    
    if (Math.abs(w) < 1e-6) {
        console.error("Homography division by zero/near-zero.");
        return null; 
    }
    const x_pixel = p_prime[0] / w;
    const y_pixel = p_prime[1] / w;
    
    return {x: x_pixel, y: y_pixel};
}


// --- LIVE DISPLAY & GPS FUNCTIONS ---

function updateLiveDisplay() {
    if (!mapInstance) return; 
    // ... (unchanged) ...
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
    // ... (unchanged) ...
    let info = [];
    for (let i = 0; i < calibrationPoints.P_real.length; i++) {
        const pR = calibrationPoints.P_real[i];
        const pP = calibrationPoints.P_pixel[i];
        
        let pR_text = pR ? `(Lon: ${pR.lng.toFixed(4)}, Lat: ${pR.lat.toFixed(4)})` : 'N/A';
        let pP_text = pP ? `(X: ${pP.x.toFixed(0)}, Y: ${pP.y.toFixed(0)})` : 'N/A';
        
        info.push(`P${i + 1}: Real ${pR_text} / Pixel ${pP_text}`);
    }
    
    let currentStepText = `P${calibrationPoints.currentStep}: Collecting ${currentMapView === 'base' ? 'Real' : 'Pixel'}`;
    
    document.getElementById('controlPointInfo').innerHTML = 
        [currentStepText, ...info].join('<br>');
}

// REMOVED: function centerMapOnGps() - Its functionality is now handled by startGpsTracking
function centerMapOnGps() {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }
    
    if (currentMapView !== 'base') {
        alert("Please switch to the Base Map to use GPS centering.");
        return;
    }

    // Use getCurrentPosition just for one-time centering
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
    // ... (unchanged) ...
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

function updateToggleButtons() {
    const baseBtn = document.getElementById('toggleBaseMap');
    const imgBtn = document.getElementById('toggleImageMap');
    const display = document.getElementById('activeMapDisplay');

    // 1. Clear Map of ALL layers EXCEPT active marker and calibration points
    mapInstance.eachLayer(layer => {
        if (layer !== calibrationPoints.activeMarker && 
            !(layer instanceof L.Marker)) { 
            mapInstance.removeLayer(layer);
        }
    });
    
    const gpsButton = document.getElementById('centerGpsButton');
    
    if (currentMapView === 'base') {
        baseBtn.classList.add('active-toggle');
        imgBtn.classList.remove('active-toggle');
        display.textContent = 'Active View: Base Map (Click to set Lat/Lon)';
        
        // Base Map Layers: OSM, Real GPS Marker/Circle (Now added by startGpsTracking)
        if (osmLayer) mapInstance.addLayer(osmLayer);
        
        if (gpsButton) gpsButton.disabled = false;
        
        // Show real GPS items on BaseMap
        if (userMarker) {
            mapInstance.addLayer(userMarker);
            mapInstance.addLayer(accuracyCircle);
            userMarker.bringToFront();
        }
        // Remove projected GPS items from the map
        if (calibrationPoints.gpsPixelMarker) mapInstance.removeLayer(calibrationPoints.gpsPixelMarker);
        if (calibrationPoints.accuracyPixelCircle) mapInstance.removeLayer(calibrationPoints.accuracyPixelCircle);


    } else { // 'image' view
        baseBtn.classList.remove('active-toggle');
        imgBtn.classList.add('active-toggle');
        display.textContent = 'Active View: Image Map (Click to set Pixel X/Y)';
        
        // Image Map Layers: Image Overlay, Projected GPS Dot/Circle
        if (calibrationPoints.mapImage) mapInstance.addLayer(calibrationPoints.mapImage);
        
        if (gpsButton) gpsButton.disabled = true;
        
        // Remove real GPS items from the map
        if (userMarker) mapInstance.removeLayer(userMarker);
        if (accuracyCircle) mapInstance.removeLayer(accuracyCircle);
        
        // Add projected GPS items to the map (if tracking is active)
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
    // ... (unchanged) ...
    saveCurrentViewState();

    mapInstance.options.crs = L.CRS.EPSG3857;
    currentMapView = 'base';
    updateToggleButtons();

    mapInstance.setView(baseMapViewState.center, baseMapViewState.zoom);
    updateLiveDisplay();
}

function toggleToImageMap() {
    if (currentMapView === 'image') return;
    // ... (unchanged) ...
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

function handleMapClick(e) {
    // ... (unchanged) ...
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

    newMarker.on('dragend', function() {
        document.getElementById('status-message').innerHTML = `P${step} position updated. Click **Confirm Point** to finalize.`;
    });
    
    document.getElementById('status-message').innerHTML = `P${step} set on the **${currentMapView === 'base' ? 'Base Map' : 'Image Map'}**. Drag the marker to adjust, then click **Confirm Point**.`;
    document.getElementById('confirmPointButton').style.display = 'inline';
    
    newMarker.bringToFront(); 
}

function confirmCurrentPoint() {
    // ... (unchanged) ...
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
    
    document.getElementById('status-message').innerHTML = '✅ **Calibration Complete!** Homography computed. GPS tracking is active.';
    
    // GPS tracking is already active via startGpsTracking() called from initializeMapAndListeners, 
    // but we can ensure the latest H_inv is used.
    // If the tracking needs to be restarted for new matrix, uncomment below, but current watchPosition 
    // uses the latest H_inv on each position update anyway. We'll leave it as is.
    
    document.getElementById('confirmPointButton').style.display = 'none';
}


// --- CONTINUOUS GPS TRACKING (Updated for BaseMap tracking) ---

function startGpsTracking() {
    if (!navigator.geolocation) {
        console.error("Geolocation is not supported by your browser.");
        return;
    }

    if (gpsWatchId) {
        // Clear previous watch if it exists
        navigator.geolocation.clearWatch(gpsWatchId);
    }
    
    // Icon for Base Map (Real CRS)
    const realMarkerIcon = L.divIcon({className: 'gps-marker-icon', html: '📍'});
    
    // Icon for Image Map (Simple CRS)
    const gpsDotIcon = L.divIcon({
        className: 'gps-dot-icon', 
        html: '',
        iconSize: [10, 10]
    }); 

    gpsWatchId = navigator.geolocation.watchPosition(
        (position) => {
            const lon = position.coords.longitude;
            const lat = position.coords.latitude;
            const accuracy_real = position.coords.accuracy; // GPS accuracy in meters
            const currentLatLng = L.latLng(lat, lon);

            // --- 1. UPDATE BASE MAP (Real CRS) MARKERS ---
            if (!userMarker) {
                userMarker = L.marker(currentLatLng, { icon: realMarkerIcon }).addTo(mapInstance).bringToFront();
                accuracyCircle = L.circle(currentLatLng, { radius: accuracy_real, color: '#3080ff', fillColor: '#3080ff', fillOpacity: 0.2, weight: 1 }).addTo(mapInstance);
            } else {
                userMarker.setLatLng(currentLatLng).bringToFront();
                accuracyCircle.setLatLng(currentLatLng).setRadius(accuracy_real);
            }


            // --- 2. UPDATE IMAGE MAP (Simple CRS) MARKERS (Only if calibration is complete) ---
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
                        calibrationPoints.gpsPixelMarker = L.marker(pixelLatLng, { icon: gpsDotIcon }).addTo(mapInstance);
                        calibrationPoints.accuracyPixelCircle = L.circle(pixelLatLng, { 
                            radius: accuracy_pixel, 
                            color: '#3080ff', 
                            fillColor: '#3080ff', 
                            fillOpacity: 0.2, 
                            weight: 1 
                        }).addTo(mapInstance);

                    } else {
                        calibrationPoints.gpsPixelMarker.setLatLng(pixelLatLng);
                        calibrationPoints.accuracyPixelCircle.setLatLng(pixelLatLng).setRadius(accuracy_pixel); 
                    }

                    // Visibility will be handled by updateToggleButtons()
                }
            }
        },
        (error) => {
            console.error("Geolocation Tracking Error:", error);
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
}


// --- MAIN EXECUTION AND SETUP PHASE ---

function initializeMapAndListeners(mapUrl) {
    if (!mapInstance) {
        mapInstance = L.map('map', {
            minZoom: -4, 
            maxZoom: 20, // INCREASED MAX ZOOM TO 20
        }).setView(baseMapViewState.center, baseMapViewState.zoom);
        osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
        mapInstance.addLayer(osmLayer);
        
        mapInstance.on('moveend', saveCurrentViewState);
        mapInstance.on('zoomend', saveCurrentViewState);
        
        mapInstance.on('moveend', updateLiveDisplay);
        mapInstance.on('zoomend', updateLiveDisplay);
    } else {
        mapInstance.options.crs = L.CRS.EPSG3857; 
        mapInstance.options.maxZoom = 20; // Ensure max zoom is updated even if map exists
        mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
        if (osmLayer) mapInstance.addLayer(osmLayer);
    }
    
    // Clear all existing tracking and calibration markers on start
    if (userMarker) mapInstance.removeLayer(userMarker);
    if (accuracyCircle) mapInstance.removeLayer(accuracyCircle);
    if (calibrationPoints.gpsPixelMarker) mapInstance.removeLayer(calibrationPoints.gpsPixelMarker);
    if (calibrationPoints.accuracyPixelCircle) mapInstance.removeLayer(calibrationPoints.accuracyPixelCircle);

    // Reset calibration state
    calibrationPoints = { 
        currentStep: 1, P_pixel: [], P_real: [], activeMarker: null, mapImage: null, imageDimensions: {},
        H_matrix: null, H_inv: null, gpsPixelMarker: null, accuracyPixelCircle: null, avgScaleFactor: 0 
    };
    if (gpsWatchId) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }

    document.getElementById('status-message').innerHTML = 'Loading image...';
    
    const image = new Image();
    
    image.onerror = function() {
        document.getElementById('status-message').innerHTML = 'Image loading failed.';
        alert("❌ Error: Could not load the image from the provided URL. Please check the link and ensure the image is publicly accessible (JPG/PNG).");
        if (mapInstance) mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
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
        
        document.getElementById('status-message').innerHTML = `Image loaded (${width}x${height}). Starting GPS tracking. Click on the map to set **P1 (Real-World)** point.`;
        
        currentMapView = 'base'; 
        updateToggleButtons(); 
        mapInstance.on('click', handleMapClick); 
        document.getElementById('confirmPointButton').style.display = 'none';

        // START GPS TRACKING IMMEDIATELY
        startGpsTracking();

        // ATOMIC BUTTON ENABLE/ATTACHMENT
        document.getElementById('toggleBaseMap').disabled = false;
        document.getElementById('toggleImageMap').disabled = false;
        document.getElementById('centerGpsButton').disabled = false; 
        
        const centerBtn = document.getElementById('centerGpsButton');
        if (centerBtn) centerBtn.addEventListener('click', centerMapOnGps);

        const confirmBtn = document.getElementById('confirmPointButton');
        if (confirmBtn) confirmBtn.addEventListener('click', confirmCurrentPoint);

        const toggleBaseBtn = document.getElementById('toggleBaseMap');
        if (toggleBaseBtn) toggleBaseBtn.addEventListener('click', toggleToBaseMap);

        const toggleImageBtn = document.getElementById('toggleImageMap');
        if (toggleImageBtn) toggleImageBtn.addEventListener('click', toggleToImageMap);

        updateLiveDisplay(); 
    };
    
    image.src = mapUrl;
}

// -----------------------------------------------------------------
// --- FINAL EVENT ATTACHMENTS (DOM Ready Fix) ---
// -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', (event) => {
    const startBtn = document.getElementById('startCalibrationButton');
    
    if (startBtn) {
        startBtn.addEventListener('click', function() {
            const mapUrl = document.getElementById('mapUrl').value.trim();
            if (!mapUrl) {
                alert("🚨 Error: Please enter a Map Image URL before starting calibration.");
                return; 
            }
            initializeMapAndListeners(mapUrl);
        });
    }
});