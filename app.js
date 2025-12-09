// Maprika Clone Application - V2.13 (Average Scale Factor for Accuracy)

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

    // Iterate through all unique pairs of points (P1-P2, P1-P3, P1-P4, P2-P3, P2-P4, P3-P4)
    for (let i = 0; i < P_pixel.length; i++) {
        for (let j = i + 1; j < P_pixel.length; j++) {
            // 1. Calculate Pixel Distance (in pixels)
            const dx_px = P_pixel[i].x - P_pixel[j].x;
            const dy_px = P_pixel[i].y - P_pixel[j].y;
            const dist_px = Math.sqrt(dx_px * dx_px + dy_px * dy_px);

            // 2. Calculate Geographic Distance (in meters)
            // L.latLng.distanceTo() calculates distance in meters using geodesic path.
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

    // Input vector for the matrix multiplication: [Lon, Lat, 1]
    const p = [lon, lat, 1];
    
    // Perform multiplication: H_inv * p
    const p_prime = numeric.dot(H_inv, p);
    
    // Normalize by the scaling factor (w)
    const w = p_prime[2];
    
    // Avoid division by zero/near zero
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
    
    let currentStepText = `P${calibrationPoints.currentStep}: Collecting ${currentMapView === 'base' ? 'Real' : 'Pixel'}`;
    
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
            const accuracy = position.coords.accuracy;

            // Use current map zoom level
            mapInstance.setView(currentLatLng, mapInstance.getZoom());

            const markerIcon = L.divIcon({className: 'gps-marker-icon', html: '📍'});
            
            if (!userMarker) {
                userMarker = L.marker(currentLatLng, { icon: markerIcon }).addTo(mapInstance).bringToFront();
                accuracyCircle = L.circle(currentLatLng, { radius: accuracy, color: '#3080ff', fillColor: '#3080ff', fillOpacity: 0.2, weight: 1 }).addTo(mapInstance);
            } else {
                userMarker.setLatLng(currentLatLng).bringToFront();
                accuracyCircle.setLatLng(currentLatLng).setRadius(accuracy);
            }
        },
        (error) => {
            console.error("Geolocation Error:", error);
            alert("Could not retrieve current GPS location. Ensure location services are enabled.");
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
        
        // Base Map Layers: OSM, Real GPS Marker/Circle
        if (osmLayer) mapInstance.addLayer(osmLayer);
        
        if (gpsButton) gpsButton.disabled = false;
        if (userMarker) {
            mapInstance.addLayer(userMarker);
            mapInstance.addLayer(accuracyCircle);
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
    
    document.getElementById('status-message').innerHTML = '✅ **Calibration Complete!** Homography computed. Starting GPS tracking on Image Map.';
    
    startGpsTracking();
    
    document.getElementById('confirmPointButton').style.display = 'none';
}


// --- CONTINUOUS GPS TRACKING ---

function startGpsTracking() {
    if (!navigator.geolocation) {
        console.error("Geolocation is not supported by your browser.");
        return;
    }

    if (!calibrationPoints.H_inv) {
         console.error("Cannot start tracking, H_inv matrix is missing.");
         return;
    }
    
    if (gpsWatchId) {
        navigator.geolocation.clearWatch(gpsWatchId);
    }
    
    // Use a small dot icon
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
            
            const pixelPoint = projectGpsToPixel(calibrationPoints.H_inv, lon, lat);

            if (!pixelPoint) return;

            const pixelLatLng = L.latLng(pixelPoint.y, pixelPoint.x);
            
            // --- ACCURACY CALCULATION ---
            let accuracy_pixel;
            if (calibrationPoints.avgScaleFactor > 0) {
                // Convert accuracy from meters to pixels using the average scale factor
                accuracy_pixel = accuracy_real / calibrationPoints.avgScaleFactor;
            } else {
                // Fallback to a fixed visual size if scale calculation failed
                accuracy_pixel = 50; 
                console.warn("Average scale factor is zero. Using default accuracy radius (50px).");
            }
            // ---------------------------------

            if (!calibrationPoints.gpsPixelMarker) {
                // Initialize marker (the dot)
                calibrationPoints.gpsPixelMarker = L.marker(pixelLatLng, { icon: gpsDotIcon }).addTo(mapInstance);
                
                // Initialize circle
                calibrationPoints.accuracyPixelCircle = L.circle(pixelLatLng, { 
                    radius: accuracy_pixel, 
                    color: '#3080ff', 
                    fillColor: '#3080ff', 
                    fillOpacity: 0.2, 
                    weight: 1 
                }).addTo(mapInstance);

            } else {
                // Update marker position
                calibrationPoints.gpsPixelMarker.setLatLng(pixelLatLng);
                // Update circle position and size
                calibrationPoints.accuracyPixelCircle.setLatLng(pixelLatLng).setRadius(accuracy_pixel); 
            }

            calibrationPoints.accuracyPixelCircle.bringToFront();
            calibrationPoints.gpsPixelMarker.bringToFront();

            if (currentMapView === 'image' && !mapInstance.hasLayer(calibrationPoints.gpsPixelMarker)) {
                mapInstance.addLayer(calibrationPoints.accuracyPixelCircle);
                mapInstance.addLayer(calibrationPoints.gpsPixelMarker);
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
            maxZoom: 18,
        }).setView(baseMapViewState.center, baseMapViewState.zoom);
        osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
        mapInstance.addLayer(osmLayer);
        
        mapInstance.on('moveend', saveCurrentViewState);
        mapInstance.on('zoomend', saveCurrentViewState);
        
        mapInstance.on('moveend', updateLiveDisplay);
        mapInstance.on('zoomend', updateLiveDisplay);
    } else {
        mapInstance.options.crs = L.CRS.EPSG3857; 
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
        
        document.getElementById('status-message').innerHTML = `Image loaded (${width}x${height}). Click on the map to set **P1 (Real-World)** point.`;
        
        currentMapView = 'base'; 
        updateToggleButtons(); 
        mapInstance.on('click', handleMapClick); 
        document.getElementById('confirmPointButton').style.display = 'none';

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
// --- FINAL EVENT ATTACHMENTS (DOM Ready Fix applied here) ---
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