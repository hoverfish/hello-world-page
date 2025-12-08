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


// --- VIEW STATE MANAGEMENT ---

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

// --- MAP VIEW TOGGLING LOGIC (Marker Cleanup Refinement) ---

function updateToggleButtons() {
    const baseBtn = document.getElementById('toggleBaseMap');
    const imgBtn = document.getElementById('toggleImageMap');
    const display = document.getElementById('activeMapDisplay');
    
    // Clear the map of extra layers for strict control
    mapInstance.eachLayer(layer => {
        // Only remove layers that are NOT the base or image layer, and NOT a marker
        if (layer !== osmLayer && layer !== calibrationPoints.mapImage && 
            !(layer instanceof L.Marker)) { 
            mapInstance.removeLayer(layer);
        }
    });
    
    // NOTE: Active marker management is now handled ONLY by handleMapClick/confirmCurrentPoint
    //       It is not implicitly re-added here to avoid synchronization glitches.

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

// --- CALIBRATION PHASE FUNCTIONS (Strict Marker Management) ---

function handleMapClick(e) {
    const step = calibrationPoints.currentStep;
    
    // CRITICAL: Ensure no marker is active before creating a new one
    if (calibrationPoints.activeMarker) return;
    mapInstance.off('click', handleMapClick); 

    // Create the draggable marker 
    const iconHtml = `<div class="pinpoint-marker"><label>P${step}</label></div>`;
    
    // Marker is created using the LatLng of the click, which corresponds to the current CRS
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
    
    // Ensure the new marker is on top
    newMarker.bringToFront(); 
}

function confirmCurrentPoint() {
    const step = calibrationPoints.currentStep;
    const marker = calibrationPoints.activeMarker;
    if (!marker) return;

    if (currentMapView === 'base') {
        // Store REAL-WORLD (LatLng) coordinate
        const finalLatLng = marker.getLatLng();
        calibrationPoints.P_real.push(finalLatLng);
        
        // CRITICAL: Remove and nullify the marker immediately
        mapInstance.removeLayer(marker); 
        calibrationPoints.activeMarker = null;
        
        saveCurrentViewState();

        toggleToImageMap(); // Switch to the Image Map view
        document.getElementById('status-message').innerHTML = `**P${step} Real-World** confirmed. Click on the **Image Map** to set the corresponding pixel point.`;
        
        // Re-enable click listener for the next point placement
        mapInstance.on('click', handleMapClick); 
        
    } else { // currentMapView === 'image'
        // Calculate and store the PIXEL coordinate
        const finalLatLng = marker.getLatLng(); 
        
        const mapBounds = calibrationPoints.mapImage.getBounds();
        const pixelPoint = mapInstance.latLngToContainerPoint(finalLatLng);
        
        const imageTopLeftPixel = mapInstance.latLngToContainerPoint(mapBounds.getNorthWest());
        
        const x_px = pixelPoint.x - imageTopLeftPixel.x;
        const y_px = pixelPoint.y - imageTopLeftPixel.y;
        
        calibrationPoints.P_pixel.push({x: x_px, y: y_px});
        
        // CRITICAL: Remove and nullify the marker immediately
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
            // runFinalProjection(); 
        }
    }
}


// --- MAIN EXECUTION AND SETUP PHASE ---

function initializeMapAndListeners(mapUrl) {
    // 1. Initialize map and layers
    if (!mapInstance) {
        mapInstance = L.map('map', {
            // --- ZOOM FIX APPLIED HERE ---
            minZoom: -4, 
            maxZoom: 18,
            // ----------------------------
        }).setView(baseMapViewState.center, baseMapViewState.zoom);
        osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
        mapInstance.addLayer(osmLayer);
        
        mapInstance.on('moveend', saveCurrentViewState);
        mapInstance.on('zoomend', saveCurrentViewState);
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
            interactive: false // Ensures touch events pass through (iPhone fix)
        });
        
        document.getElementById('status-message').innerHTML = `Image loaded (${width}x${height}). Click on the map to set **P1 (Real-World)** point.`;
        
        // 4. Start calibration sequence
        currentMapView = 'base'; 
        updateToggleButtons(); 
        mapInstance.on('click', handleMapClick); // Enable initial click
        document.getElementById('confirmPointButton').style.display = 'none';

        document.getElementById('toggleBaseMap').disabled = false;
        document.getElementById('toggleImageMap').disabled = false;
    };
    
    image.src = mapUrl;
}