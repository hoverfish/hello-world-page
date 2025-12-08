let userMarker = null; // Global variable to hold the GPS marker

// --- GEOMETRY UTILITY FUNCTIONS ---

/**
 * Solves for the 3x3 Homography Matrix (H) using the 4 control points.
 * NOTE: This is complex matrix math. Using numericjs greatly simplifies this.
 * This implementation is based on standard perspective mapping formulas.
 * @param {Array} P_pixel - Array of {x, y} pixel coordinates.
 * @param {Array} P_real - Array of {lat, lon} real-world coordinates.
 * @returns {Array} The 3x3 Homography Matrix H.
 */
function calculateHomographyMatrix(P_pixel, P_real) {
    // 1. Prepare the linear system for numeric.js
    // We solve for the 8 unknown parameters (h11 to h32, where h33=1)
    const A = [];
    const B = [];

    // Combine all 4 points to create 8 equations
    for (let i = 0; i < 4; i++) {
        const x_p = P_pixel[i].x; // Source X (Pixel)
        const y_p = P_pixel[i].y; // Source Y (Pixel)
        
        // Target X (Lat) and Y (Lon) - Note: Using Lat for Y and Lon for X is common
        // But for consistency with standard GIS, we map to X=Lon, Y=Lat.
        const x_r = P_real[i].lng; // Target X (Lon)
        const y_r = P_real[i].lat; // Target Y (Lat)

        // Equations for X (Lon)
        A.push([x_p, y_p, 1, 0, 0, 0, -x_r * x_p, -x_r * y_p]);
        B.push(x_r);

        // Equations for Y (Lat)
        A.push([0, 0, 0, x_p, y_p, 1, -y_r * x_p, -y_r * y_p]);
        B.push(y_r);
    }

    // 2. Solve the linear system A * h = B using numeric.js
    // The result is an array of 8 values (h11, h12, h13, h21, h22, h23, h31, h32)
    const h_params = numeric.solve(A, B);

    // 3. Assemble the 3x3 Homography Matrix H
    const H = [
        [h_params[0], h_params[1], h_params[2]],
        [h_params[3], h_params[4], h_params[5]],
        [h_params[6], h_params[7], 1] // h33 is normalized to 1
    ];
    
    return H;
}


/**
 * Projects a point (x, y) using a 3x3 Homography Matrix (H).
 * @param {Array} H - The 3x3 Homography Matrix.
 * @param {number} x - The x-coordinate (Pixel X or Lon).
 * @param {number} y - The y-coordinate (Pixel Y or Lat).
 * @returns {Array} The projected point [x', y'].
 */
function projectPoint(H, x, y) {
    const p = [x, y, 1]; // Input point vector

    // Matrix multiplication: H * p
    const p_prime = numeric.dot(H, p);

    // Normalize the result by the third coordinate
    const w = p_prime[2];
    const x_prime = p_prime[0] / w;
    const y_prime = p_prime[1] / w;

    return [x_prime, y_prime];
}

// --- GPS TRACKING AND MAP LOGIC ---

// Global variables to hold the marker and the accuracy circle
let userMarker = null; 
let accuracyCircle = null; 

/**
 * Initializes and continuously updates the user's position and accuracy circle.
 * The position is projected onto the unwarped custom map image.
 * * @param {object} map - The Leaflet map instance.
 * @param {Array} H - The 3x3 Forward Homography Matrix (Pixel -> Real World).
 * @param {Array} H_inv - The 3x3 Inverse Homography Matrix (Real World -> Pixel).
 */
function startGpsTracking(map, H, H_inv) {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser. Cannot track position.");
        return;
    }
    
    // Set up options for tracking
    const watchOptions = { 
        enableHighAccuracy: true, 
        timeout: 10000, 
        maximumAge: 0 
    };

    navigator.geolocation.watchPosition(
        (position) => {
            const currentLat = position.coords.latitude;
            const currentLon = position.coords.longitude;
            const accuracy = position.coords.accuracy; // GPS accuracy in meters!
            
            // --- Step 1: Project GPS (Real World) to Pixels (Image Map) ---
            // Use H_inv to find where this Lat/Lon lands on the UNWARPED image.
            // Remember: projectPoint uses [x, y], so we use [Lon, Lat]
            const [X_px, Y_px] = projectPoint(H_inv, currentLon, currentLat); 
            
            // --- Step 2: Project Pixels back to Lat/Lon for Leaflet ---
            // Use the forward matrix (H) to find the precise Lat/Lon that 
            // corresponds to this calculated pixel location on the map.
            const [Lon_marker, Lat_marker] = projectPoint(H, X_px, Y_px);

            const newLatLng = L.latLng(Lat_marker, Lon_marker);

            // --- Step 3: Update the Accuracy Circle ---
            if (accuracyCircle) {
                // If the circle exists, just update its position and radius
                accuracyCircle.setLatLng(newLatLng).setRadius(accuracy);
            } else {
                // If this is the first update, create the circle
                accuracyCircle = L.circle(newLatLng, {
                    radius: accuracy, // Set radius to the reported accuracy (in meters)
                    color: '#888888',
                    fillColor: '#888888',
                    fillOpacity: 0.2, // Semi-transparent fill
                    weight: 1 
                }).addTo(map);
            }

            // --- Step 4: Update the User Marker (the Red Dot) ---
            if (userMarker) {
                userMarker.setLatLng(newLatLng);
            } else {
                // Create the red dot
                userMarker = L.circleMarker(newLatLng, {
                    radius: 8,
                    color: 'red',
                    fillColor: '#FF0000',
                    fillOpacity: 1.0 
                }).addTo(map);
            }
            
            // Ensure the dot is always drawn *on top* of the circle
            userMarker.bringToFront(); 

            // Optional: Center the map on the marker the first time
            if (!map.getCenter().lat) { 
                 map.setView(newLatLng, map.getZoom() || 15);
            }
        },
        (error) => {
            console.error("Geolocation Error:", error);
            // Inform the user, but don't halt the application
            if (error.code === error.PERMISSION_DENIED) {
                 console.warn("Location permission denied by user.");
            }
        },
        watchOptions
    );
}

// NOTE: Ensure the projectPoint, calculateHomographyMatrix, and the main 
// event listener logic are also present in app.js!

// Global variable to hold the map instance, allowing access/re-use
let mapInstance = null; 

// --- MAIN EXECUTION ---
document.getElementById('loadMapButton').addEventListener('click', function() {
    const mapUrl = document.getElementById('mapUrl').value;
    
    // 1. Collect real-world coordinates (P_real) (No change here)
    const P_real = [
        L.latLng(parseFloat(document.getElementById('lat1').value), parseFloat(document.getElementById('lon1').value)), 
        L.latLng(parseFloat(document.getElementById('lat2').value), parseFloat(document.getElementById('lon2').value)), 
        L.latLng(parseFloat(document.getElementById('lat3').value), parseFloat(document.getElementById('lon3').value)), 
        L.latLng(parseFloat(document.getElementById('lat4').value), parseFloat(document.getElementById('lon4').value))
    ];

    // --- CRITICAL FIX: Initialize Map ONLY ONCE ---
    if (!mapInstance) {
        // Initialize map only if it doesn't exist
        mapInstance = L.map('map').setView(P_real[0], 13);
        // Add the base tile layer only once
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mapInstance);
    }
    
    // Clear any previous overlays before loading new map
    mapInstance.eachLayer(function (layer) {
        if (layer.options && layer.options.attribution && layer.options.attribution.includes('Image Overlay')) {
            mapInstance.removeLayer(layer);
        }
    });

    // 2. Get image dimensions and proceed (Requires an async load)
    const image = new Image();
    
    // Handle loading success
    image.onload = function() {
        const width = this.width;
        const height = this.height;
        // ... rest of the matrix calculation (P_pixel, H, H_inv) is correct ...
        
        // Define the image pixel coordinates (P_pixel)
        const P_pixel = [
            {x: 0, y: 0}, 
            {x: width, y: 0}, 
            {x: width, y: height}, 
            {x: 0, y: height}
        ];

        // 3. Calculate Matrices
        const H = calculateHomographyMatrix(P_pixel, P_real);
        const H_inv = numeric.inv(H); 

        // 4. Display the Unwarped Image using the mapInstance
        const bounds = L.latLngBounds(P_real[0], P_real[2]);
        L.imageOverlay(mapUrl, bounds, { attribution: 'Custom Image Overlay' }).addTo(mapInstance);

        // 5. Start Tracking
        startGpsTracking(mapInstance, H, H_inv);
        mapInstance.fitBounds(bounds); 
    };

    // Handle Image Loading Error (if URL is bad)
    image.onerror = function() {
        alert("Error loading map image. Please check the URL and ensure it is a public JPG/PNG image.");
    };
    
    // Start loading the image
    image.src = mapUrl; 
});