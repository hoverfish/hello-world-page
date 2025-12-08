// Global variables to hold the map instance and tracking markers
let mapInstance = null;
let userMarker = null; 
let accuracyCircle = null; 
let osmLayer = null; 

// New Globals to store independent view states
let baseMapViewState = { center: [40.7, -74.0], zoom: 13 }; // Default geographic
let imageMapViewState = { center: [0, 0], zoom: 0 };       // Default pixel center

// Global state variables for Calibration
let currentMapView = 'base'; // 'base' or 'image'
let calibrationPoints = {
    currentStep: 1,      // 1 to 4
    P_pixel: [],         
    P_real: [],          
    activeMarker: null,  
    mapImage: null,      
    imageDimensions: {}  
};

// --- GEOMETRY UTILITY FUNCTIONS (Unchanged) ---
function calculateHomographyMatrix(P_pixel, P_real) { /* ... */ }
function projectPoint(H, x, y) { /* ... */ }


// --- FEATURE 1, 2, 4: LIVE DISPLAY AND GPS MARKER FUNCTIONS ---

function updateLiveDisplay() {
    if (!mapInstance) return;

    // Feature 1: Zoom Level Display
    document.getElementById('zoomDisplay').textContent = mapInstance.getZoom();

    // Feature 2: Center Coordinates Display
    const center = mapInstance.getCenter();
    const mapType = (mapInstance.options.crs === L.CRS.EPSG3857) ? 'Lat/Lon' : 'Pixel (Y/X)';
    
    let coordText;
    if (mapInstance.options.crs === L.CRS.EPSG3857) {
        coordText = `Lat: ${center.lat.toFixed(6)}, Lon: ${center.lng.toFixed(6)}`;
    } else {
        // For simple CRS, Lat/Lng is effectively Y/X
        coordText = `Y: ${center.lat.toFixed(0)}, X: ${center.lng.toFixed(0)}`;
    }
    document.getElementById('coordDisplay').textContent = `Center (${mapType}): ${coordText}`;
    
    // Update Control Point Information
    updateControlPointInfo();
}

function updateControlPointInfo() {
    let info = [];
    for (let i = 0; i < calibrationPoints.P_real.length; i++) {
        const pR = calibrationPoints.P_real[i];
        const pP = calibrationPoints.P_pixel[i];
        
        let pR_text = pR ? `(Lon: ${pR.lng.toFixed(4)}, Lat: ${pR.lat.toFixed(4)})` : 'N/A';
        let pP_text = pP ? `(X: ${pP.x.toFixed(0)}, Y: ${pP.y.toFixed(0)})` : 'N/A';
        
        info.push(`P${i + 1}: Real ${pR_text} / Pixel ${pP_text}`);
    }
    
    // Display info for the current step being collected
    let currentStepText = `P${calibrationPoints.currentStep}: Collecting ${currentMapView === 'base' ? 'Real' : 'Pixel'}`;
    
    document.getElementById('controlPointInfo').innerHTML = 
        [currentStepText, ...info].join('<br>');
}


// Feature 3 & 4 Implementation: Center on GPS and Live Marker
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

            // Update Map View
            mapInstance.setView(currentLatLng, mapInstance.getZoom() > 15 ? mapInstance.getZoom() : 15);

            // Feature 4: Update Live GPS Marker and Accuracy Circle
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


// --- VIEW STATE MANAGEMENT (Unchanged) ---
function saveCurrentViewState() { /* ... */ }

// --- MAP VIEW TOGGLING LOGIC (Added GPS Button Toggle) ---

function updateToggleButtons() {
    // ... (rest of the updateToggleButtons logic) ...

    // Control visibility and state of GPS button
    const gpsButton = document.getElementById('centerGpsButton');
    if (currentMapView === 'base') {
        gpsButton.disabled = false;
        if (userMarker) {
            mapInstance.addLayer(userMarker);
            mapInstance.addLayer(accuracyCircle);
        }
    } else {
        gpsButton.disabled = true;
        if (userMarker) {
            mapInstance.removeLayer(userMarker);
            mapInstance.removeLayer(accuracyCircle);
        }
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
    updateLiveDisplay(); // Update display on toggle
}

function toggleToImageMap() {
    if (currentMapView === 'image') return;
    
    saveCurrentViewState();
    
    mapInstance.options.crs = L.CRS.Simple;
    
    if (calibrationPoints.mapImage) {
        // ... (rest of image map setup) ...
    }

    currentMapView = 'image';
    updateToggleButtons();
    mapInstance.setView(imageMapViewState.center, imageMapViewState.zoom);
    updateLiveDisplay(); // Update display on toggle
}


// --- CALIBRATION PHASE FUNCTIONS (Update Live Display in Confirm) ---

function confirmCurrentPoint() {
    // ... (existing logic for confirming points) ...
    
    if (currentMapView === 'base') {
        // ... (save P_real logic) ...
        toggleToImageMap(); 
        document.getElementById('status-message').innerHTML = `...`;
        mapInstance.on('click', handleMapClick); 
        
    } else { // currentMapView === 'image'
        // ... (save P_pixel logic) ...
        
        calibrationPoints.currentStep++;
        
        if (calibrationPoints.currentStep <= 4) {
            toggleToBaseMap(); 
            document.getElementById('status-message').innerHTML = `...`;
            mapInstance.on('click', handleMapClick); 
        } else {
            // ... (final projection) ...
        }
    }
    
    updateControlPointInfo(); // Update info after every confirmation
}


// --- MAIN EXECUTION AND SETUP PHASE (Adding Live Display Listeners) ---

function initializeMapAndListeners(mapUrl) {
    // 1. Initialize map and layers
    if (!mapInstance) {
        mapInstance = L.map('map', {
            minZoom: -4, 
            maxZoom: 18,
        }).setView(baseMapViewState.center, baseMapViewState.zoom);
        osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
        mapInstance.addLayer(osmLayer);
        
        mapInstance.on('moveend', saveCurrentViewState);
        mapInstance.on('zoomend', saveCurrentViewState);
        
        // FEATURE 1 & 2: Attach live display listeners
        mapInstance.on('moveend', updateLiveDisplay);
        mapInstance.on('zoomend', updateLiveDisplay);
    } else {
        // ... (existing cleanup logic) ...
    }
    
    // Reset calibration state
    // ...
    
    // 2. Load Image (to get dimensions)
    // ... (image onload/onerror logic) ...
    
    image.onload = function() {
        // ... (existing onload logic) ...
        
        // 4. Start calibration sequence
        currentMapView = 'base'; 
        updateToggleButtons(); 
        mapInstance.on('click', handleMapClick);
        document.getElementById('confirmPointButton').style.display = 'none';

        document.getElementById('toggleBaseMap').disabled