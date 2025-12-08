// Global variables to hold the map instance and tracking markers
let mapInstance = null;
let userMarker = null; 
let accuracyCircle = null; 
let osmLayer = null;

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

// --- MAP VIEW TOGGLING LOGIC ---

function updateToggleButtons() {
    const baseBtn = document.getElementById('toggleBaseMap');
    const imgBtn = document.getElementById('toggleImageMap');
    const display = document.getElementById('activeMapDisplay');
    
    // Enable buttons once calibration starts
    baseBtn.disabled = false;
    imgBtn.disabled = false;

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

    // Re-add markers to ensure they are on top
    if (calibrationPoints.activeMarker) {
        calibrationPoints.activeMarker.bringToFront();
    }
}

function toggleToBaseMap() {
    currentMapView = 'base';
    updateToggleButtons();
}

function toggleToImageMap() {
    currentMapView = 'image';
    updateToggleButtons();
}


// --- GPS TRACKING AND OPERATION PHASE (Minor changes) ---

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
    
    // Clear ALL layers (base map, calibration markers, temp image)
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
            
            // Update Accuracy Circle
            if (accuracyCircle) {
                accuracyCircle.setLatLng(newPixelPoint).setRadius(pixelRadius);
            } else {
                accuracyCircle = L.circle(newPixelPoint, {
                    radius: pixelRadius, color: 'gray', fillColor: '#888888', fillOpacity: 0.2, weight: 1 
                }).addTo(mapInstance);
            }

            // Update User Marker
            if (userMarker) {
                userMarker.setLatLng(newPixelPoint);
            } else {
                userMarker = L.circleMarker(newPixelPoint, {
                    radius: 8, color: 'red', fillColor: '#FF0000', fillOpacity: 1.0 
                }).addTo(mapInstance);
            }
            
            userMarker.bringToFront(); 
            
            if (mapInstance.getCenter().lat === 0 && mapInstance.getCenter().lng === 0) { 
                 mapInstance.setView(newPixelPoint, 0);
            }
        },
        (error) => { console.error("Geolocation Error:", error); },
        watchOptions
    );
}


// --- CALIBRATION PHASE FUNCTIONS (Major changes) ---

function handleMapClick(e) {
    const step = calibrationPoints.currentStep;
    
    // Only allow placing a marker if one isn't already active
    if (calibrationPoints.activeMarker) return;

    // Stop listening for new clicks until the current point is confirmed
    mapInstance.off('click', handleMapClick); 

    // 1. Create a draggable marker at the clicked LatLng
    const iconHtml = `<div class="pinpoint-marker"><label>P${step}</label></div>`;
    
    const newMarker = L.marker(e.latlng, {
        draggable: true,
        title: `P${step}`,
        icon: L.divIcon({className: 'pinpoint-marker', html: iconHtml})
    }).addTo(mapInstance);

    calibrationPoints.activeMarker = newMarker;

    // 2. Set up the drag listener
    newMarker.on('dragend', function() {
        document.getElementById('status-message').innerHTML = `P${step} position updated. Click **Confirm Point** to finalize.`;
    });
    
    // 3. Update status and show the confirmation button
    document.getElementById('status-message').innerHTML = `P${step} set on the **${currentMapView === 'base' ? 'Base Map' : 'Image Map'}**. Drag the marker to adjust, then click **Confirm Point**.`;
    document.getElementById('confirmPointButton').style.display = 'inline';
}

function confirmCurrentPoint() {
    const step = calibrationPoints.currentStep;
    const marker = calibrationPoints.activeMarker;
    if (!marker) return;

    // The logic has changed: We need to know which map view the user was on
    if (currentMapView === 'base') {
        // 1. Store the final REAL-WORLD (LatLng) coordinate
        const finalLatLng = marker.getLatLng();
        calibrationPoints.P_real.push(finalLatLng);
        
        // 2. Clear marker and prompt for Image Map click
        mapInstance.removeLayer(marker); 
        calibrationPoints.activeMarker = null;
        
        toggleToImageMap(); // Switch to the Image Map view
        document.getElementById('status-message').innerHTML = `**P${step} Real-World** confirmed. Switch to **Image Map** and click to set the corresponding pixel point.`;
        mapInstance.on('click', handleMapClick); // Re-enable clicks
        
    } else { // currentMapView === 'image'
        // 1. Calculate and store the PIXEL coordinate
        const finalLatLng = marker.getLatLng(); // LatLng from the *current* image projection
        
        const mapBounds = calibrationPoints.mapImage.getBounds();
        const pixelPoint = mapInstance.latLngToContainerPoint(finalLatLng);
        
        // Normalize the pixel coordinate relative to the top-left of the image overlay
        const imageTopLeftPixel = mapInstance.latLngToContainerPoint(mapBounds.getNorthWest());
        
        const x_px = pixelPoint.x - imageTopLeftPixel.x;
        const y_px = pixelPoint.y - imageTopLeftPixel.y;
        
        calibrationPoints.P_pixel.push({x: x_px, y: y_px});
        
        // 2. Cleanup marker and advance to the next point (P2)
        mapInstance.removeLayer(marker); 
        calibrationPoints.activeMarker = null;
        document.getElementById('confirmPointButton').style.display = 'none';

        calibrationPoints.currentStep++;
        
        if (calibrationPoints.currentStep <= 4) {
            // Continue to the next point, starting back on the Base Map
            toggleToBaseMap(); 
            document.getElementById('status-message').innerHTML = `**P${step} Pixel** confirmed. Switch to **Base Map** and click to set **P${calibrationPoints.currentStep} Real-World** point.`;
            mapInstance.on('click', handleMapClick); 
        } else {
            // All 4 points collected! Final step.
            document.getElementById('status-message').innerHTML = 'Calibration complete! Calculating projection...';
            runFinalProjection(); 
        }
    }
}

function runFinalProjection() {
    const { P_pixel, P_real, imageDimensions } = calibrationPoints;
    
    // 1. Calculate Matrices
    const H = calculateHomographyMatrix(P_pixel, P_real);
    const H_inv = numeric.inv(H); 
    
    // 2. Calculate Meter-to-Pixel Scale Factor
    const longestSidePixel = Math.max(imageDimensions.width, imageDimensions.height);
    const P1 = P_real[0];
    const P2 = P_real[1];
    const realWorldDistance = P1.distanceTo(P2); 
    const meterToPixelScale = longestSidePixel / realWorldDistance;
    
    // 3. Start the final tracking phase
    startGpsTracking(H_inv, document.getElementById('mapUrl').value, meterToPixelScale);
}

// --- MAIN EXECUTION AND SETUP PHASE ---

document.getElementById('startCalibrationButton').addEventListener('click', function() {
    const mapUrl = document.getElementById('mapUrl').value.trim();

    // CHECK 1: MISSING URL
    if (!mapUrl) {
        alert("🚨 Error: Please enter a Map Image URL before starting calibration.");
        return; 
    }

    // Initialize Map and OSM Layer
    if (!mapInstance) {
        mapInstance = L.map('map').setView([40.7, -74.0], 13);
        osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
        mapInstance.addLayer(osmLayer);
    } else {
        mapInstance.options.crs = L.CRS.EPSG3857; // Ensure geographic CRS is set
        mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
        mapInstance.addLayer(osmLayer);
    }
    
    // Reset calibration state
    calibrationPoints = { 
        currentStep: 1, P_pixel: [], P_real: [], activeMarker: null, mapImage: null, imageDimensions: {}
    };
    document.getElementById('status-message').innerHTML = 'Loading image...';
    
    // 1. Load Image (to get dimensions)
    const image = new Image();
    
    // CHECK 2: INVALID URL / LOADING FAILURE
    image.onerror = function() {
        document.getElementById('status-message').innerHTML = 'Image loading failed.';
        alert("❌ Error: Could not load the image from the provided URL. Please check the link and ensure the image is publicly accessible (JPG/PNG).");
        if (mapInstance) mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
    };
    
    image.onload = function() {
        const width = this.width;
        const height = this.height;

        calibrationPoints.imageDimensions = {width, height};

        // 2. Create the TEMPORARY image overlay 
        // We use the full geographic bounds of the OSM layer for setup purposes.
        const tempBounds = L.latLngBounds([10, -180], [80, 180]); 
        
        calibrationPoints.mapImage = L.imageOverlay(mapUrl, tempBounds, {
            opacity: 1.0, // Set to 1.0 because it's no longer layered on top of the OSM map
            attribution: 'Calibration Image Overlay',
            interactive: false // Clicks should pass through to the map layer
        }); // Do NOT add to map yet, it will be added by the toggle function
        
        document.getElementById('status-message').innerHTML = `Image loaded (${width}x${height}). Click on the map to set **P1 (Real-World)** point.`;
        
        // 3. Start listening for clicks
        currentMapView = 'base'; // Ensure we start on the base map
        updateToggleButtons();
        mapInstance.on('click', handleMapClick);
        document.getElementById('confirmPointButton').style.display = 'none';
    };
    
    image.src = mapUrl;
});

// Attach the confirm button handler
document.getElementById('confirmPointButton').addEventListener('click', confirmCurrentPoint);

// Attach the toggle button handlers
document.getElementById('toggleBaseMap').addEventListener('click', toggleToBaseMap);
document.getElementById('toggleImageMap').addEventListener('click', toggleToImageMap);