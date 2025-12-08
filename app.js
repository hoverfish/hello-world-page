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

// --- LIVE DISPLAY & GPS FUNCTIONS (Unchanged) ---
function updateLiveDisplay() { /* ... */ }
function updateControlPointInfo() { /* ... */ }
function centerMapOnGps() { /* ... */ }
function saveCurrentViewState() { /* ... */ }


// --- MAP VIEW TOGGLING LOGIC (HARD RESET IMPLEMENTED) ---

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
    
    // 2. Control visibility and state of GPS marker and button
    const gpsButton = document.getElementById('centerGpsButton');
    
    if (currentMapView === 'base') {
        baseBtn.classList.add('active-toggle');
        imgBtn.classList.remove('active-toggle');
        display.textContent = 'Active View: Base Map (Click to set Lat/Lon)';
        
        // FIX: Add Base Map Layer
        if (osmLayer) mapInstance.addLayer(osmLayer);
        
        if (gpsButton) gpsButton.disabled = false;
        if (userMarker) {
            mapInstance.addLayer(userMarker);
            mapInstance.addLayer(accuracyCircle);
        }

    } else { // 'image' view
        baseBtn.classList.remove('active-toggle');
        imgBtn.classList.add('active-toggle');
        display.textContent = 'Active View: Image Map (Click to set Pixel X/Y)';
        
        // FIX: Add Image Map Layer
        if (calibrationPoints.mapImage) mapInstance.addLayer(calibrationPoints.mapImage);
        
        if (gpsButton) gpsButton.disabled = true;
        if (userMarker) {
            mapInstance.removeLayer(userMarker);
            mapInstance.removeLayer(accuracyCircle);
        }
    }
    
    // Ensure active marker is brought to the top (if one exists)
    if (calibrationPoints.activeMarker) {
         calibrationPoints.activeMarker.addTo(mapInstance).bringToFront();
    }
    
    mapInstance.invalidateSize(); 
}

function toggleToBaseMap() {
    if (currentMapView === 'base') return; 
    
    saveCurrentViewState();

    // HARD RESET: Change CRS and immediately update layers
    mapInstance.options.crs = L.CRS.EPSG3857;
    currentMapView = 'base';
    updateToggleButtons();

    mapInstance.setView(baseMapViewState.center, baseMapViewState.zoom);
    updateLiveDisplay();
}

function toggleToImageMap() {
    if (currentMapView === 'image') return;
    
    saveCurrentViewState();
    
    // HARD RESET: Change CRS and immediately update layers
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


// --- CALIBRATION PHASE FUNCTIONS (Unchanged) ---
function handleMapClick(e) { /* ... */ }
function confirmCurrentPoint() { /* ... */ }
function runFinalProjection() { /* ... */ } 


// --- MAIN EXECUTION AND SETUP PHASE (Atomic Initialization) ---

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

        // 5. ATOMIC BUTTON ENABLE/ATTACHMENT (CRITICAL FOR SAFARI STABILITY)
        
        // Enable buttons
        document.getElementById('toggleBaseMap').disabled = false;
        document.getElementById('toggleImageMap').disabled = false;
        document.getElementById('centerGpsButton').disabled = false; 
        
        // Attach listeners ONLY AFTER the map and buttons are verified enabled
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
// --- FINAL EVENT ATTACHMENTS (Only Start Button remains here) ---
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

// NOTE: All other button attachments were moved into the image.onload success block.