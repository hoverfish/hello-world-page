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
    P_pixel: [],         // Stores {x, y} pixel coordinates
    P_real: [],          // Stores L.LatLng objects
    activeMarker: null,  // The draggable marker currently being adjusted
    mapImage: null,      // Reference to the L.imageOverlay
    imageDimensions: {}  // Stores {width, height}
};

// --- GEOMETRY UTILITY FUNCTIONS (No changes) ---

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

function projectPoint(H, x, y) {
    const p = [x, y, 1];
    const p_prime = numeric.dot(H, p);
    const w = p_prime[2];
    const x_prime = p_prime[0] / w;
    const y_prime = p_prime[1] / w;
    return [x_prime, y_prime];
}

// --- MAP VIEW TOGGLING LOGIC (The Decoupling Fix) ---

function updateToggleButtons() {
    const baseBtn = document.getElementById('toggleBaseMap');
    const imgBtn = document.getElementById('toggleImageMap');
    const display = document.getElementById('activeMapDisplay');
    
    // Clear the map of layers for strict control
    mapInstance.eachLayer(layer => {
        if (layer !== osmLayer && layer !== calibrationPoints.mapImage && 
            !(layer instanceof L.Marker || layer instanceof L.CircleMarker)) {
            mapInstance.removeLayer(layer);
        }
    });

    if (currentMapView === 'base') {
        baseBtn.classList.add('active-toggle');
        imgBtn.classList.remove('active-toggle');
        display.textContent = 'Active View: Base Map (Click to set Lat/Lon)';
        
        // Layer Control
        if (osmLayer) mapInstance.addLayer(osmLayer);
        if (calibrationPoints.mapImage && mapInstance.hasLayer(calibrationPoints.mapImage)) {
            mapInstance.removeLayer(calibrationPoints.mapImage);
        }

    } else { // 'image' view
        baseBtn.classList.remove('active-toggle');
        imgBtn.classList.add('active-toggle');
        display.textContent = 'Active View: Image Map (Click to set Pixel X/Y)';
        
        // Layer Control
        if (osmLayer && mapInstance.hasLayer(osmLayer)) {
            mapInstance.removeLayer(osmLayer);
        }
        if (calibrationPoints.mapImage) mapInstance.addLayer(calibrationPoints.mapImage);
    }
    
    // Re-add active marker on top (if one exists)
    if (calibrationPoints.activeMarker) {
        calibrationPoints.activeMarker.addTo(mapInstance).bringToFront();
    }
    
    mapInstance.invalidateSize(); 
}

function toggleToBaseMap() {
    if (currentMapView === 'base') return; 
    
    // 1. SAVE the Image Map's last view state
    imageMapViewState.center = mapInstance.getCenter();
    imageMapViewState.zoom = mapInstance.getZoom();

    // 2. SWITCH CRS and Layers
    mapInstance.options.crs = L.CRS.EPSG3857;
    currentMapView = 'base';
    updateToggleButtons();

    // 3. RESTORE the Base Map's last view state
    mapInstance.setView(baseMapViewState.center, baseMapViewState.zoom);
}

function toggleToImageMap() {
    if (currentMapView === 'image') return;
    
    // 1. SAVE the Base Map's last view state
    baseMapViewState.center = mapInstance.getCenter();
    baseMapViewState.zoom = mapInstance.getZoom();
    
    // 2. SWITCH CRS and Layers
    mapInstance.options.crs = L.CRS.Simple;
    
    // Must redefine bounds and set view for L.CRS.Simple (fixes distortion)
    if (calibrationPoints.mapImage) {
        const {width, height} = calibrationPoints.imageDimensions;
        const bounds = [[0, 0], [height, width]];
        
        // SetBounds needs to be called to anchor the image correctly in the new CRS
        calibrationPoints.mapImage.setBounds(bounds);
        
        // Use fitBounds on initial switch to ensure the entire image is seen
        if (imageMapViewState.zoom === 0) {
             mapInstance.fitBounds(bounds); 
        } else {
             // Restore the Image Map's last view state for independent movement
             mapInstance.setView(imageMapViewState.center, imageMapViewState.zoom);
        }
    }

    currentMapView = 'image';
    updateToggleButtons();
}

// --- GPS TRACKING AND OPERATION PHASE (Unchanged) ---

function startGpsTracking(H_inv, mapUrl, meterToPixelScale) {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }
    
    // Clear the map controls and set final status
    document.getElementById('status-message').innerHTML = 'Tracking started. View controls disabled.';
    document.getElementById('toggleBaseMap').style.display = 'none';
    document.getElementById('toggleImageMap').style.display = 'none';
    document.getElementById('activeMapDisplay').style.display = 'none';

    // 1. REVERT to L.CRS.Simple for the final Image-Centric Display
    mapInstance.options.crs = L.