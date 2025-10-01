const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ⚠️ IMPORTANT: Firebase initialization assumes the FIREBASE_SERVICE_ACCOUNT 
// environment variable is set in your Vercel dashboard.
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('Firebase Admin Initialized successfully.');
} catch (e) {
    console.error('Failed to initialize Firebase Admin SDK. Check FIREBASE_SERVICE_ACCOUNT variable.', e.message);
}


const app = express();
app.use(cors({ origin: '*' })); // CORS enabled for all origins (restrict in production!)
app.use(express.json());

/**
 * Utility function for validating required user profile data fields.
 */
function validateProfileData(data) {
    const { userId, name, email, phone, age, country, photoUrl } = data;
    const errors = [];

    // Basic required field checks
    if (!userId) errors.push('userId (Firebase UID) is required.');
    if (!name || name.trim().length < 2) errors.push('Name is required and must be at least 2 characters.');
    if (!email || !email.includes('@')) errors.push('A valid Email is required.');
    if (!phone || phone.trim().length < 10) errors.push('Phone Number must be at least 10 digits.');
    if (!age || isNaN(parseInt(age)) || parseInt(age) < 18) errors.push('Age is required and must be 18 or older.');
    if (!country || country.trim().length < 2) errors.push('Country is required.');
    
    if (photoUrl && typeof photoUrl !== 'string') errors.push('Photo URL must be a string.');

    return errors;
}

// -------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------

// Health check endpoint: GET /
app.get('/', (req, res) => {
    res.status(200).send('LonyiChat Backend API is running.');
});

/**
 * POST /api/signup-profile
 * Endpoint to store extended user profile information (Name, Phone, Age, Country) in Firestore.
 */
app.post('/signup-profile', async (req, res) => {
    const data = req.body;
    
    const validationErrors = validateProfileData(data);
    if (validationErrors.length > 0) {
        return res.status(400).json({ 
            success: false, 
            message: 'Validation failed.', 
            errors: validationErrors 
        });
    }
    
    if (!db) {
        return res.status(500).json({
            success: false,
            message: 'Server error: Firebase connection not available. Check Vercel secrets.'
        });
    }

    // --- Actual Firebase interaction: Save profile data to Firestore ---
    try {
        const userRef = db.collection('users').doc(data.userId);
        
        await userRef.set({
            name: data.name,
            email: data.email,
            phone: data.phone,
            age: parseInt(data.age),
            country: data.country,
            photoUrl: data.photoUrl || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`[Backend Log] Successfully stored profile data for user: ${data.userId}`);

        res.status(201).json({ 
            success: true, 
            message: 'Profile data saved successfully to Firestore.',
            profile: { 
                id: data.userId, 
                name: data.name, 
                country: data.country 
            }
        });

    } catch (error) {
        console.error("Error saving user profile data:", error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to save profile data.', 
            error: error.message 
        });
    }
});


// Export the Express app as the Vercel serverless function entry point
module.exports = app;
