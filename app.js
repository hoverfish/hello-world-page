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
// ... (omitted for brevity) ...
function calculateHomographyMatrix(P_pixel, P_real) { /* ... */ }
function projectPoint(H, x, y) { /* ... */ }


// --- VIEW STATE MANAGEMENT ---

function saveCurrentViewState() {
    if (!mapInstance) return;

    // Check which CRS is currently active to determine which state to save
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
    
    // Clear the map of extra layers for strict control
    mapInstance.eachLayer(layer => {
        if (layer !== osmLayer && layer !== calibrationPoints.mapImage && 
            !(layer instanceof L.Marker)) { 
            mapInstance.removeLayer(layer);
        }
    });

    if (currentMapView === 'base') {
        baseBtn.classList.add('active-toggle');
        imgBtn.classList.remove('active-toggle');
        display.textContent = 'Active View: Base Map (Click to set Lat/Lon)';
        
        if (osmLayer) mapInstance.addLayer(osmLayer);
        if (calibrationPoints.mapImage && mapInstance.hasLayer(calibrationPoints.mapImage)) {
            mapInstance.removeLayer(calibrationPoints.mapImage);
        }

    } else { // 'image' view
        baseBtn.classList.remove('active-toggle');
        imgBtn.classList.add('active-toggle');
        display.textContent = 'Active View: Image Map (Click to set Pixel X/Y)';
        
        if (osmLayer && mapInstance.hasLayer(osmLayer)) {
            mapInstance.removeLayer(osmLayer);
        }
        if (calibrationPoints.mapImage) mapInstance.addLayer(calibrationPoints.mapImage);
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
}

// --- GPS TRACKING AND OPERATION PHASE (Unchanged) ---
// ... (omitted for brevity) ...

// --- CALIBRATION PHASE FUNCTIONS (Unchanged) ---
// ... (omitted for brevity) ...
function handleMapClick(e) { /* ... */ }
function confirmCurrentPoint() { /* ... */ }
function runFinalProjection() { /* ... */ }


// -----------------------------------------------------------------
// --- MAIN EXECUTION AND SETUP PHASE (CRITICAL FIXES HERE) ---
// -----------------------------------------------------------------

// NEW FUNCTION: Centralized Map Initialization
function initializeMapAndListeners(mapUrl) {
    // 1. Initialize map and layers
    if (!mapInstance) {
        mapInstance = L.map('map').setView(baseMapViewState.center, baseMapViewState.zoom);
        osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
        mapInstance.addLayer(osmLayer);
        
        // CRITICAL FIX: Attach the continuous save listener immediately after map creation
        mapInstance.on('moveend', saveCurrentViewState);
        mapInstance.on('zoomend', saveCurrentViewState);
    } else {
        // Clean up and ensure we are starting on the geographic CRS
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

        // FIX FOR SAFARI: Explicitly enable the toggle buttons here
        document.getElementById('toggleBaseMap').disabled = false;
        document.getElementById('toggleImageMap').disabled = false;
    };
    
    image.src = mapUrl;
}

// MAIN ENTRY POINT FOR START BUTTON
document.getElementById('startCalibrationButton').addEventListener('click', function() {
    const mapUrl = document.getElementById('mapUrl').value.trim();

    if (!mapUrl) {
        alert("🚨 Error: Please enter a Map Image URL before starting calibration.");
        return; 
    }
    
    // Calls the centralized setup function
    initializeMapAndListeners(mapUrl);
});

// FINAL EVENT ATTACHMENTS (Must be at the bottom of the file)
document.getElementById('confirmPointButton').addEventListener('click', confirmCurrentPoint);
document.getElementById('toggleBaseMap').addEventListener('click', toggleToBaseMap);
document.getElementById('toggleImageMap').addEventListener('click', toggleToImageMap);