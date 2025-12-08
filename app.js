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


// --- FEATURE 1, 2, 4: LIVE DISPLAY AND GPS MARKER FUNCTIONS (CRITICAL FIXES HERE) ---

function updateLiveDisplay() {
    // --- CRITICAL NULL CHECK: Prevents crash if called before map is initialized ---
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
        coordText = `Y: ${center.lat.toFixed(0)}, X: ${center.lng.toFixed(0)}`;
    }
    document.getElementById('coordDisplay').textContent = `Center (${mapType}): ${coordText}`;
    
    updateControlPointInfo();
}

function updateControlPointInfo() {
    // Also requires mapInstance to avoid errors, although less likely to crash here
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

            mapInstance.setView(currentLatLng, mapInstance.getZoom() > 15 ? mapInstance.getZoom() : 15);

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

// --- MAP VIEW TOGGLING LOGIC (Unchanged) ---

function updateToggleButtons() {
    // ... (logic) ...
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
    mapInstance.setView(imageMapViewState.center, imageMapViewState.zoom);
    updateLiveDisplay(); 
}


// --- CALIBRATION PHASE FUNCTIONS (Unchanged) ---
function handleMapClick(e) { /* ... */ }
function confirmCurrentPoint() { /* ... */ }
function runFinalProjection() { /* ... */ } 


// --- MAIN EXECUTION AND SETUP PHASE ---

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
        mapInstance.options.crs = L.CRS.EPSG3857; 
        mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
        if (osmLayer) mapInstance.addLayer(osmLayer);
    }
    
    // Reset calibration state
    calibrationPoints = { 
        currentStep: 1, P_pixel: [], P_real: [], activeMarker: null, mapImage: null, imageDimensions: {}
    };
    document.getElementById('status-message').innerHTML = 'Loading image...';
    
    // 2. Load Image (to get dimensions)
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

        // 3. Create the image overlay 
        const tempBounds = L.latLngBounds([10, -180], [80, 180]); 
        
        calibrationPoints.mapImage = L.imageOverlay(mapUrl, tempBounds, {
            opacity: 1.0, 
            attribution: 'Calibration Image Overlay',
            interactive: false 
        });
        
        document.getElementById('status-message').innerHTML = `Image loaded (${width}x${height}). Click on the map to set **P1 (Real-World)** point.`;
        
        // 4. Start calibration sequence
        currentMapView = 'base'; 
        updateToggleButtons(); 
        mapInstance.on('click', handleMapClick); 
        document.getElementById('confirmPointButton').style.display = 'none';

        document.getElementById('toggleBaseMap').disabled = false;
        document.getElementById('toggleImageMap').disabled = false;
        document.getElementById('centerGpsButton').disabled = false; 

        updateLiveDisplay(); 
    };
    
    image.src = mapUrl;
}

// -----------------------------------------------------------------
// --- FINAL EVENT ATTACHMENTS (Ensures listeners are attached last) ---
// -----------------------------------------------------------------

document.getElementById('startCalibrationButton').addEventListener('click', function() {
    const mapUrl = document.getElementById('mapUrl').value.trim();

    if (!mapUrl) {
        alert("🚨 Error: Please enter a Map Image URL before starting calibration.");
        return; 
    }
    
    // The issue here is the `initializeMapAndListeners` function assumes it runs successfully.
    // The functions it calls need to be robust against running before all HTML elements are ready.
    initializeMapAndListeners(mapUrl);
});

// Adding null checks here just in case the element doesn't exist, though it should.
const centerBtn = document.getElementById('centerGpsButton');
if (centerBtn) centerBtn.addEventListener('click', centerMapOnGps);

const confirmBtn = document.getElementById('confirmPointButton');
if (confirmBtn) confirmBtn.addEventListener('click', confirmCurrentPoint);

const toggleBaseBtn = document.getElementById('toggleBaseMap');
if (toggleBaseBtn) toggleBaseBtn.addEventListener('click', toggleToBaseMap);

const toggleImageBtn = document.getElementById('toggleImageMap');
if (toggleImageBtn) toggleImageBtn.addEventListener('click', toggleToImageMap);