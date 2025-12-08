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

function projectPoint(H, x, y) {
    const p = [x, y, 1];
    const p_prime = numeric.dot(H, p);
    const w = p_prime[2];
    const x_prime = p_prime[0] / w;
    const y_prime = p_prime[1] / w;
    return [x_prime, y_prime];
}

// --- VIEW STATE MANAGEMENT (Synchronization Fix) ---

function saveCurrentViewState() {
    if (!mapInstance) return;

    // Check which CRS is currently active to determine which state to save
    if (mapInstance.options.crs === L.CRS.EPSG3857) {
        // Only save valid geographic coordinates
        const center = mapInstance.getCenter();
        if (center.lat > -90 && center.lat < 90) {
            baseMapViewState.center = center;
            baseMapViewState.zoom = mapInstance.getZoom();
        }
    } else if (mapInstance.options.crs === L.CRS.Simple) {
        // Save simple pixel coordinates
        imageMapViewState.center = mapInstance.getCenter();
        imageMapViewState.zoom = mapInstance.getZoom();
    }
}

// --- MAP VIEW TOGGLING LOGIC (The Decoupling Fix) ---

function updateToggleButtons() {
    const baseBtn = document.getElementById('toggleBaseMap');
    const imgBtn = document.getElementById('toggleImageMap');
    const display = document.getElementById('activeMapDisplay');
    
    // Clear the map of extra layers for strict control
    mapInstance.eachLayer(layer => {
        if (layer !== osmLayer && layer !== calibrationPoints.mapImage && 
            !(layer instanceof L.Marker)) { // Preserve markers while switching
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
    
    // Re-add active marker on top (if one exists)
    if (calibrationPoints.activeMarker) {
        calibrationPoints.activeMarker.addTo(mapInstance).bringToFront();
    }
    
    mapInstance.invalidateSize(); 
}

function toggleToBaseMap() {
    if (currentMapView === 'base') return; 
    
    // 1. SAVE the view state of the map we are LEAVING
    saveCurrentViewState();

    // 2. SWITCH CRS and Layers
    mapInstance.options.crs = L.CRS.EPSG3857;
    currentMapView = 'base';
    updateToggleButtons();

    // 3. RESTORE the Base Map's last view state
    mapInstance.setView(baseMapViewState.center, baseMapViewState.zoom);
}

function toggleToImageMap() {
    if (currentMapView === 'image') return;
    
    // 1. SAVE the view state of the map we are LEAVING
    saveCurrentViewState();
    
    // 2. SWITCH CRS and Layers
    mapInstance.options.crs = L.CRS.Simple;
    
    // Must redefine bounds and set view for L.CRS.Simple (fixes distortion)
    if (calibrationPoints.mapImage) {
        const {width, height} = calibrationPoints.imageDimensions;
        const bounds = [[0, 0], [height, width]];
        
        calibrationPoints.mapImage.setBounds(bounds);
        
        // Restore the Image Map's last view state
        if (imageMapViewState.zoom === 0) {
             mapInstance.fitBounds(bounds); // Fit bounds only on initial load
        } else {
             mapInstance.setView(imageMapViewState.center, imageMapViewState.zoom);
        }
    }

    currentMapView = 'image';
    updateToggleButtons();
}

// --- GPS TRACKING AND OPERATION PHASE (Unchanged for this fix) ---

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
    mapInstance.options.crs = L.CRS.Simple;
    
    // Clear ALL layers
    mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
    
    // 2. Display the Final Unwarped Image using PIXEL BOUNDS
    const {width, height} = calibrationPoints.imageDimensions;
    const bounds = [[0, 0], [height, width]]; // [Y, X] order
    L.imageOverlay(mapUrl, bounds, { attribution: 'Custom Image Overlay' }).addTo(mapInstance);
    mapInstance.fitBounds(bounds); 
    
    // 3. Start GPS watch
    const watchOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

    navigator.geolocation.watchPosition(
        (position) => {
            const currentLat = position.coords.latitude;
            const currentLon = position.coords.longitude;
            const accuracy = position.coords.accuracy;
            
            const [X_px, Y_px] = projectPoint(H_inv, currentLon, currentLat); 
            const newPixelPoint = [Y_px, X_px]; 
            const pixelRadius = accuracy * meterToPixelScale; 
            
            // Update Marker and Circle logic (omitted for brevity)
        },
        (error) => { console.error("Geolocation Error:", error); },
        watchOptions
    );
}


// --- CALIBRATION PHASE FUNCTIONS (Minor change to restore view on confirmation) ---

function handleMapClick(e) {
    const step = calibrationPoints.currentStep;
    
    if (calibrationPoints.activeMarker) return;
    mapInstance.off('click', handleMapClick); 

    // Create the draggable marker 
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
}

function confirmCurrentPoint() {
    const step = calibrationPoints.currentStep;
    const marker = calibrationPoints.activeMarker;
    if (!marker) return;

    if (currentMapView === 'base') {
        // Store REAL-WORLD (LatLng) coordinate
        const finalLatLng = marker.getLatLng();
        calibrationPoints.P_real.push(finalLatLng);
        
        mapInstance.removeLayer(marker); 
        calibrationPoints.activeMarker = null;
        
        // Save Base Map state right before switching
        saveCurrentViewState();

        toggleToImageMap(); // Switch to the Image Map view
        document.getElementById('status-message').innerHTML = `**P${step} Real-World** confirmed. Click on the **Image Map** to set the corresponding pixel point.`;
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
        
        // Cleanup marker and advance
        mapInstance.removeLayer(marker); 
        calibrationPoints.activeMarker = null;
        document.getElementById('confirmPointButton').style.display = 'none';

        // Save Image Map state right before switching
        saveCurrentViewState();

        calibrationPoints.currentStep++;
        
        if (calibrationPoints.currentStep <= 4) {
            // Continue to the next point, starting back on the Base Map
            toggleToBaseMap(); 
            document.getElementById('status-message').innerHTML = `**P${step} Pixel** confirmed. Click on the **Base Map** to set **P${calibrationPoints.currentStep} Real-World** point.`;
            mapInstance.on('click', handleMapClick); 
        } else {
            // All 4 points collected! Final step.
            document.getElementById('status-message').innerHTML = 'Calibration complete! Calculating projection...';
            runFinalProjection(); 
        }
    }
}

function runFinalProjection() {
    // Logic for calculating H, H_inv, and meterToPixelScale (omitted for brevity)
    // ...
    // startGpsTracking(H_inv, document.getElementById('mapUrl').value, meterToPixelScale);
}

// --- MAIN EXECUTION AND SETUP PHASE ---

document.getElementById('startCalibrationButton').addEventListener('click', function() {
    const mapUrl = document.getElementById('mapUrl').value.trim();

    if (!mapUrl) {
        alert