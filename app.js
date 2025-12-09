// Maprika Clone Application - V2.11 (Visual Clean-up and Accuracy Circle)

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
    accuracyPixelCircle: null // NEW: Accuracy circle for the projected GPS point
};
let gpsWatchId = null;     


// --- GEOMETRY UTILITY FUNCTIONS (Unchanged) ---

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


// --- LIVE DISPLAY & GPS FUNCTIONS (Mostly Unchanged) ---

function updateLiveDisplay() { /* ... */ }
function updateControlPointInfo() { /* ... */ }
function saveCurrentViewState() { /* ... */ }

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


// --- MAP VIEW TOGGLING LOGIC (Updated to manage projected marker and circle) ---

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

function toggleToBaseMap() { /* ... */ }
function toggleToImageMap() { /* ... */ }


// --- CALIBRATION PHASE FUNCTIONS (Unchanged) ---

function handleMapClick(e) { /* ... */ }
function confirmCurrentPoint() { /* ... */ }

function runFinalProjection() {
    const H = calculateHomographyMatrix(calibrationPoints.P_pixel, calibrationPoints.P_real);
    calibrationPoints.H_matrix = H;

    const H_inv = numeric.inv(H); 
    calibrationPoints.H_inv = H_inv;
    
    document.getElementById('status-message').innerHTML = '✅ **Calibration Complete!** Homography computed. Starting GPS tracking on Image Map.';
    
    startGpsTracking();
    
    document.getElementById('confirmPointButton').style.display = 'none';
}


// --- CONTINUOUS GPS TRACKING (Updated to use dot/circle icon) ---

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
    
    // NEW: Use a small dot icon
    const gpsDotIcon = L.divIcon({
        className: 'gps-dot-icon', 
        html: '', // Content is handled by CSS for the dot
        iconSize: [10, 10]
    }); 

    gpsWatchId = navigator.geolocation.watchPosition(
        (position) => {
            const lon = position.coords.longitude;
            const lat = position.coords.latitude;
            const accuracy_real = position.coords.accuracy; // in meters
            
            const pixelPoint = projectGpsToPixel(calibrationPoints.H_inv, lon, lat);

            if (!pixelPoint) return;

            // Convert Pixel (X, Y) to Leaflet Simple CRS LatLng: L.latLng(Y, X)
            const pixelLatLng = L.latLng(pixelPoint.y, pixelPoint.x);

            // --- ACCURACY CALCULATION ---
            // To get the pixel radius, we need to project a point 'accuracy_real' meters away
            // This is complex, so for simplicity in Leaflet Simple CRS, we will approximate 
            // by using the projection factor (pixels/meter) from the initial calibration points.
            
            // For now, let's keep the accuracy circle in the Simple CRS based on
            // an approximate scaling factor until a full warp calculation is needed.
            // In Simple CRS, radius is measured in the CRS unit (pixels). 
            // We use a fixed approximation radius (e.g., 50 pixels) for visual feedback.
            
            const accuracy_pixel = 50; // Placeholder: 50 pixels for visual size

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

            // Bring dot and circle to front
            calibrationPoints.accuracyPixelCircle.bringToFront();
            calibrationPoints.gpsPixelMarker.bringToFront();

            // Visibility management (Ensures it appears instantly on Image Map)
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
        // ... (Map initialization block) ...
    } else {
        mapInstance.options.crs = L.CRS.EPSG3857; 
        mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
        if (osmLayer) mapInstance.addLayer(osmLayer);
    }
    
    // FIX for Stray Pin: Clear all existing tracking and calibration markers on start
    if (userMarker) mapInstance.removeLayer(userMarker);
    if (accuracyCircle) mapInstance.removeLayer(accuracyCircle);
    if (calibrationPoints.gpsPixelMarker) mapInstance.removeLayer(calibrationPoints.gpsPixelMarker);
    if (calibrationPoints.accuracyPixelCircle) mapInstance.removeLayer(calibrationPoints.accuracyPixelCircle);

    // Reset calibration state
    calibrationPoints = { 
        currentStep: 1, P_pixel: [], P_real: [], activeMarker: null, mapImage: null, imageDimensions: {},
        H_matrix: null, H_inv: null, gpsPixelMarker: null, accuracyPixelCircle: null 
    };
    if (gpsWatchId) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }

    document.getElementById('status-message').innerHTML = 'Loading image...';
    
    // ... (Image loading logic) ...

    image.onload = function() {
        const width = this.width;
        const height = this.height;
        // ... (Rest of image onload logic, including ATOMIC BUTTON ATTACHMENT) ...
    };
    
    image.src = mapUrl;
}

// -----------------------------------------------------------------
// --- FINAL EVENT ATTACHMENTS (Unchanged) ---
// -----------------------------------------------------------------
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