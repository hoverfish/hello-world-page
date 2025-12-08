// Global variables to hold the map instance and markers
let mapInstance = null;
let userMarker = null; 
let accuracyCircle = null; 

// New Global Variables for Calibration State
let calibrationPoints = {
    currentStep: 1,      // 1 to 4
    P_pixel: [],         // Stores {x, y} pixel coordinates from the image
    P_real: [],          // Stores L.LatLng objects (real-world coordinates)
    activeMarker: null,  // The draggable marker currently being adjusted
    mapImage: null,      // Reference to the L.imageOverlay
    imageDimensions: {}  // Stores {width, height} for final projection
};

// --- GEOMETRY UTILITY FUNCTIONS (No changes needed here) ---

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

// --- GPS TRACKING AND OPERATION PHASE ---

function startGpsTracking(H_inv, mapUrl, meterToPixelScale) {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }

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
            
            // Project GPS (Lon, Lat) to Image Pixels (X_px, Y_px)
            const [X_px, Y_px] = projectPoint(H_inv, currentLon, currentLat); 
            const newPixelPoint = [Y_px, X_px]; // Leaflet L.CRS.Simple uses [Y, X]
            
            // Calculate accuracy radius in pixels
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
            // Center map on the marker the first time 
            if (mapInstance.getCenter().lat === 0 && mapInstance.getCenter().lng === 0) { 
                 mapInstance.setView(newPixelPoint, 0); // Zoom level 0 for initial view
            }
        },
        (error) => { console.error("Geolocation Error:", error); },
        watchOptions
    );
}

// --- CALIBRATION PHASE FUNCTIONS ---

function handleMapClick(e) {
    const step = calibrationPoints.currentStep;
    
    if (calibrationPoints.activeMarker) {
         // Should not happen if confirmed button is used, but good safeguard
         return; 
    }
    
    // Stop listening for new clicks until the current point is confirmed
    mapInstance.off('click', handleMapClick); 

    // 1. Create a draggable marker at the clicked LatLng
    const newMarker = L.marker(e.latlng, {
        draggable: true,
        title: `P${step}`,
        icon: L.divIcon({className: 'calibration-marker', html: `<b>P${step}</b>`})
    }).addTo(mapInstance);

    calibrationPoints.activeMarker = newMarker;

    // 2. Set up the drag listener
    newMarker.on('dragend', function() {
        document.getElementById('status-message').innerHTML = `P${step} position updated. Click **Confirm Point** to finalize.`;
    });
    
    // 3. Update status and show the confirmation button
    document.getElementById('status-message').innerHTML = `P${step} set. Drag the marker to adjust, then click **Confirm Point**.`;
    document.getElementById('confirmPointButton').style.display = 'inline';
}

function confirmCurrentPoint() {
    const step = calibrationPoints.currentStep;
    const marker = calibrationPoints.activeMarker;
    if (!marker) return;

    // 1. Store the final REAL-WORLD (LatLng) coordinate
    const finalLatLng = marker.getLatLng();
    calibrationPoints.P_real.push(finalLatLng);

    // 2. Calculate and store the PIXEL coordinate
    // The LatLng must be converted to a pixel point relative to the image's top-left corner
    const mapBounds = calibrationPoints.mapImage.getBounds();
    const pixelPoint = mapInstance.latLngToContainerPoint(finalLatLng);
    
    // Normalize the pixel coordinate relative to the top-left of the image overlay
    const imageTopLeftPixel = mapInstance.latLngToContainerPoint(mapBounds.getNorthWest());
    
    const x_px = pixelPoint.x - imageTopLeftPixel.x;
    const y_px = pixelPoint.y - imageTopLeftPixel.y;
    
    // IMPORTANT: Leaflet's imageOverlay assumes its corners map to the real-world corners
    // This calculation ensures that clicks relative to the image itself are recorded correctly.
    calibrationPoints.P_pixel.push({x: x_px, y: y_px});

    // 3. Cleanup marker and advance
    marker.dragging.disable();
    document.getElementById('confirmPointButton').style.display = 'none';
    calibrationPoints.activeMarker = null; // Clear the active marker
    
    // Remove the temporary visual marker now that the point is stored
    mapInstance.removeLayer(marker); 
    
    calibrationPoints.currentStep++;
    
    if (calibrationPoints.currentStep <= 4) {
        // Continue to the next point
        document.getElementById('status-message').innerHTML = `**P${step}** confirmed. Click on the map to set **P${calibrationPoints.currentStep}**.`;
        mapInstance.on('click', handleMapClick); // Re-enable clicks
    } else {
        // All 4 points collected! Final step.
        document.getElementById('status-message').innerHTML = 'Calibration complete! Calculating projection...';
        runFinalProjection(); 
    }
}

function runFinalProjection() {
    const { P_pixel, P_real, imageDimensions } = calibrationPoints;
    
    // 1. Calculate Matrices
    const H = calculateHomographyMatrix(P_pixel, P_real);
    const H_inv = numeric.inv(H); 
    
    // 2. Calculate Meter-to-Pixel Scale Factor
    // Used to convert GPS accuracy (in meters) to pixel radius on the map.
    const longestSidePixel = Math.max(imageDimensions.width, imageDimensions.height);
    const P1 = P_real[0];
    const P2 = P_real[1];
    // Use the distance between two corners for scale reference
    const realWorldDistance = P1.distanceTo(P2); 
    const meterToPixelScale = longestSidePixel / realWorldDistance;
    
    // 3. Start the final tracking phase
    startGpsTracking(H_inv, document.getElementById('mapUrl').value, meterToPixelScale);
}

// --- MAIN EXECUTION AND SETUP PHASE ---

document.getElementById('startCalibrationButton').addEventListener('click', function() {
    const mapUrl = document.getElementById('mapUrl').value;
    if (!mapUrl) {
        alert("Please enter a Map Image URL.");
        return;
    }

    // Reset Map and State
    if (!mapInstance) {
        // Initialize map with default Geographic CRS (EPSG:3857) for calibration
        mapInstance = L.map('map').setView([40.7, -74.0], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mapInstance);
    } else {
        // Clean up previous runs
        mapInstance.options.crs = L.CRS.EPSG3857;
        mapInstance.eachLayer(layer => mapInstance.removeLayer(layer));
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mapInstance);
    }
    
    // Reset calibration state
    calibrationPoints = { 
        currentStep: 1, P_pixel: [], P_real: [], activeMarker: null, mapImage: null, imageDimensions: {}
    };
    document.getElementById('status-message').innerHTML = 'Loading image...';
    
    // 1. Load Image (to get dimensions)
    const image = new Image();
    image.onload = function() {
        const width = this.width;
        const height = this.height;

        calibrationPoints.imageDimensions = {width, height};

        // 2. Display the TEMPORARY image overlay with low opacity
        // Use wide bounds to ensure the image is visible over the map area for initial setup
        const tempBounds = L.latLngBounds([10, -180], [80, 180]); // Large temp bounds
        
        calibrationPoints.mapImage = L.imageOverlay(mapUrl, tempBounds, {
            opacity: 0.5, 
            attribution: 'Calibration Image Overlay',
            interactive: true // Ensure the overlay can block clicks if needed
        }).addTo(mapInstance);
        
        document.getElementById('status-message').innerHTML = `Image loaded (${width}x${height}). Click on the map to set **P1 (Top-Left corner)**.`;
        
        // 3. Start listening for clicks
        mapInstance.on('click', handleMapClick);
        document.getElementById('confirmPointButton').style.display = 'none';
    };
    
    image.onerror = () => alert("Error loading map image. Check URL.");
    image.src = mapUrl;
});

// Attach the confirm button handler
document.getElementById('confirmPointButton').addEventListener('click', confirmCurrentPoint);