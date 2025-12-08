// Global variables to hold the map instance and markers
let mapInstance = null;
let userMarker = null; 
let accuracyCircle = null; 

// --- GEOMETRY UTILITY FUNCTIONS (No changes needed here) ---

/**
 * Solves for the 3x3 Homography Matrix (H) using the 4 control points.
 */
function calculateHomographyMatrix(P_pixel, P_real) {
    const A = [];
    const B = [];
    for (let i = 0; i < 4; i++) {
        const x_p = P_pixel[i].x;
        const y_p = P_pixel[i].y;
        const x_r = P_real[i].lng; // Target X (Lon)
        const y_r = P_real[i].lat; // Target Y (Lat)

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
 * Projects a point (x, y) using a 3x3 Homography Matrix (H).
 */
function projectPoint(H, x, y) {
    const p = [x, y, 1];
    const p_prime = numeric.dot(H, p);
    const w = p_prime[2];
    const x_prime = p_prime[0] / w;
    const y_prime = p_prime[1] / w;
    return [x_prime, y_prime];
}

// --- GPS TRACKING AND MAP LOGIC (Modified) ---

/**
 * Initializes and continuously updates the user's position and accuracy circle 
 * using direct pixel coordinates on the L.CRS.Simple map.
 */
function startGpsTracking(map, H_inv, meterToPixelScale) {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser. Cannot track position.");
        return;
    }
    
    const watchOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

    navigator.geolocation.watchPosition(
        (position) => {
            const currentLat = position.coords.latitude;
            const currentLon = position.coords.longitude;
            const accuracy = position.coords.accuracy; // GPS accuracy in meters!
            
            // --- Step 1: Project GPS (Real World) to Pixels (Image Map) ---
            // Use H_inv to find where this Lat/Lon lands on the UNWARPED image.
            const [X_px, Y_px] = projectPoint(H_inv, currentLon, currentLat); 
            
            // Leaflet L.CRS.Simple expects coordinates in [Y, X] order (similar to [Lat, Lon])
            const newPixelPoint = [Y_px, X_px]; 
            
            // Calculate accuracy radius in pixels
            // This is an approximation and will only be accurate at one point/zoom level
            const pixelRadius = accuracy * meterToPixelScale; 
            
            // --- Step 2: Update the Accuracy Circle ---
            if (accuracyCircle) {
                accuracyCircle.setLatLng(newPixelPoint).setRadius(pixelRadius);
            } else {
                accuracyCircle = L.circle(newPixelPoint, {
                    radius: pixelRadius,
                    color: '#888888',
                    fillColor: '#888888',
                    fillOpacity: 0.2,
                    weight: 1 
                }).addTo(map);
            }

            // --- Step 3: Update the User Marker (Red Dot) ---
            if (userMarker) {
                userMarker.setLatLng(newPixelPoint);
            } else {
                userMarker = L.circleMarker(newPixelPoint, {
                    radius: 8,
                    color: 'red',
                    fillColor: '#FF0000',
                    fillOpacity: 1.0 
                }).addTo(map);
            }
            
            userMarker.bringToFront(); 

            // Center map on the marker the first time (if not already centered)
            if (map.getCenter().lat === 0 && map.getCenter().lng === 0) { 
                 map.setView(newPixelPoint, map.getZoom() || 0);
            }
        },
        (error) => {
            console.error("Geolocation Error:", error);
            if (error.code === error.PERMISSION_DENIED) {
                 console.warn("Location permission denied by user.");
            }
        },
        watchOptions
    );
}

// --- MAIN EXECUTION (Modified) ---
document.getElementById('loadMapButton').addEventListener('click', function() {
    const mapUrl = document.getElementById('mapUrl').value;
    
    // 1. Collect real-world coordinates (P_real)
    const P_real = [
        L.latLng(parseFloat(document.getElementById('lat1').value), parseFloat(document.getElementById('lon1').value)), 
        L.latLng(parseFloat(document.getElementById('lat2').value), parseFloat(document.getElementById('lon2').value)), 
        L.latLng(parseFloat(document.getElementById('lat3').value), parseFloat(document.getElementById('lon3').value)), 
        L.latLng(parseFloat(document.getElementById('lat4').value), parseFloat(document.getElementById('lon4').value))
    ];

    // 2. CRITICAL FIX: Initialize Map ONLY ONCE using L.CRS.Simple
    if (!mapInstance) {
        mapInstance = L.map('map', {
            crs: L.CRS.Simple,
            minZoom: -5,
            maxZoom: 5,
            scrollWheelZoom: true
        }).setView([0, 0], 0); // Center at pixel 0,0 with zoom 0
    }
    
    // Clear any previous overlays
    mapInstance.eachLayer(function (layer) {
        if (layer.options && layer.options.attribution && layer.options.attribution.includes('Overlay')) {
            mapInstance.removeLayer(layer);
        }
    });

    // 3. Get image dimensions and proceed (Requires an async load)
    const image = new Image();
    
    // Handle loading success
    image.onload = function() {
        const width = this.width;
        const height = this.height;
        
        // Define the image pixel coordinates (P_pixel)
        const P_pixel = [
            {x: 0, y: 0}, 
            {x: width, y: 0}, 
            {x: width, y: height}, 
            {x: 0, y: height}
        ];

        // 4. Calculate Matrices
        const H = calculateHomographyMatrix(P_pixel, P_real);
        const H_inv = numeric.inv(H); 
        
        // 5. Calculate Meter-to-Pixel Scale Factor (Approximation)
        // This is a necessary step for L.CRS.Simple to display the accuracy circle correctly.
        // We calculate the pixel distance of the longest side and divide by the real-world distance.
        const longestSidePixel = Math.max(width, height);
        const P1 = P_real[0];
        const P2 = P_real[1];
        // Approximate distance function (Leaflet's distanceTo uses meters)
        const realWorldDistance = P1.distanceTo(P2); 
        const meterToPixelScale = longestSidePixel / realWorldDistance;
        

        // 6. Display the Unwarped Image using PIXEL BOUNDS
        // Bounds are defined in [Y, X] order: [[minY, minX], [maxY, maxX]]
        const bounds = [[0, 0], [height, width]];
        L.imageOverlay(mapUrl, bounds, { 
            attribution: 'Custom Image Overlay',
            opacity: 1.0,
            interactive: false
        }).addTo(mapInstance);

        // 7. Start Tracking
        startGpsTracking(mapInstance, H_inv, meterToPixelScale);
        mapInstance.fitBounds(bounds); 
    };

    // Handle Image Loading Error
    image.onerror = function() {
        alert("Error loading map image. Please check the URL and ensure it is a public JPG/PNG image.");
    };
    
    // Start loading the image
    image.src = mapUrl; 
});