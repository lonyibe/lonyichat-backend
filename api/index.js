const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ⚠️ IMPORTANT: Firebase initialization assumes the FIREBASE_SERVICE_ACCOUNT 
// environment variable is set in your Vercel dashboard.
let db;
try {
    // Ensure the app isn't initialized multiple times in serverless environment
    if (admin.apps.length === 0) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log('Firebase Admin Initialized successfully.');
    } else {
        // If already initialized (e.g., in development environment or hot reload), reuse it
        db = admin.firestore();
    }
} catch (e) {
    console.error('Failed to initialize Firebase Admin SDK. Check FIREBASE_SERVICE_ACCOUNT variable.', e.message);
}


const app = express();
app.use(cors({ origin: '*' })); // CORS enabled for all origins (restrict in production!)
app.use(express.json());


// =========================================================================
// AUTHENTICATION MIDDLEWARE (Required for most authenticated endpoints)
// =========================================================================
const authenticate = async (req, res, next) => {
    const { authorization } = req.headers;
    if (!authorization || !authorization.startsWith('Bearer ')) {
        return res.status(401).send({ success: false, message: 'Unauthorized: No token provided.' });
    }
    const token = authorization.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; // Add user info (UID) to the request object
        next();
    } catch (error) {
        // This handles expired, malformed, or invalid tokens
        return res.status(401).send({ success: false, message: 'Unauthorized: Invalid token.' });
    }
};


// =========================================================================
// UTILITIES
// =========================================================================

/**
 * Utility function for validating required user profile data fields (used by POST /signup-profile).
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

/**
 * Checks if the Firestore connection is available.
 */
function checkDbConnection(res) {
    if (!db) {
        res.status(500).json({
            success: false,
            message: 'Server error: Firebase connection not available. Check Vercel secrets.'
        });
        return false;
    }
    return true;
}


// =========================================================================
// 🌐 API ROUTES 🌐
// =========================================================================

// --- Health Check ---
app.get('/', (req, res) => {
    res.status(200).send('LonyiChat Backend API is running.');
});


// -------------------------------------------------------------------------
// AUTH & USER PROFILE ROUTES
// -------------------------------------------------------------------------

/**
 * POST /signup-profile
 * Endpoint to store extended user profile information (Name, Phone, Age, Country) in Firestore.
 */
app.post('/signup-profile', async (req, res) => {
    if (!checkDbConnection(res)) return;

    const data = req.body;
    
    const validationErrors = validateProfileData(data);
    if (validationErrors.length > 0) {
        return res.status(400).json({ 
            success: false, 
            message: 'Validation failed.', 
            errors: validationErrors 
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
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            // Initialize social fields for later use
            following: [], 
            followers: [],
            churches: []
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

/**
 * GET /users/search
 * Finds other Christians by searching for their name.
 */
app.get('/users/search', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ success: false, message: 'A search query is required.' });
    }
    try {
        // Simple prefix search on 'name' field
        const snapshot = await db.collection('users').where('name', '>=', query).where('name', '<=', query + '\uf8ff').limit(10).get();
        const users = snapshot.docs.map(doc => ({
            id: doc.id,
            name: doc.data().name,
            photoUrl: doc.data().photoUrl || null
        }));
        res.status(200).json({ success: true, users });
    } catch (error) {
        console.error("Error searching users:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /users/friend-request
 * Sends a friend request to another user.
 */
app.post('/users/friend-request', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    const { recipientId } = req.body;
    const senderId = req.user.uid;
    if (!recipientId) {
        return res.status(400).json({ success: false, message: 'Recipient ID is required.' });
    }
    try {
        const requestRef = db.collection('friend_requests').doc(`${senderId}_${recipientId}`);
        await requestRef.set({
            from: senderId,
            to: recipientId,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.status(201).json({ success: true, message: 'Friend request sent.' });
    } catch (error) {
        console.error("Error sending friend request:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// -------------------------------------------------------------------------
// POSTS, STATUS UPDATES, REACTIONS & COMMENTS ROUTES
// -------------------------------------------------------------------------

/**
 * GET /posts
 * Fetches the latest 20 posts, ordered by creation time (Required for HomeFeedViewModel).
 */
app.get('/posts', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    try {
        const postsSnapshot = await db.collection('posts')
            .orderBy('createdAt', 'desc')
            .limit(20) // For performance, limit the feed size
            .get();

        const posts = postsSnapshot.docs.map(doc => {
            const data = doc.data();
            // Convert Firebase Timestamp to the { _seconds, _nanoseconds } format 
            // expected by the Android client's Post.kt data model.
            return {
                id: doc.id,
                authorId: data.authorId,
                authorName: data.authorName,
                authorPhotoUrl: data.authorPhotoUrl || null,
                content: data.content,
                type: data.type,
                reactions: data.reactions || { amen: 0, hallelujah: 0, praiseGod: 0 },
                commentCount: data.commentCount || 0,
                createdAt: {
                    _seconds: data.createdAt.seconds,
                    _nanoseconds: data.createdAt.nanoseconds
                }
            };
        });

        res.status(200).json({ success: true, posts });
    } catch (error) {
        console.error("Error fetching posts:", error);
        res.status(500).json({ success: false, message: 'Failed to fetch posts.', error: error.message });
    }
});

/**
 * POST /posts
 * Creates a new post or status update (Required for HomeFeedViewModel).
 */
app.post('/posts', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    const { content, type = 'post' } = req.body; // type can be 'post' or 'status'
    if (!content) {
        return res.status(400).json({ success: false, message: 'Content is required.' });
    }
    
    try {
        // Fetch user data from Firestore to ensure the post has the correct, up-to-date name/photo
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        const userData = userDoc.data();

        if (!userData) {
            return res.status(404).json({ success: false, message: 'User profile not found.' });
        }

        const newPost = {
            authorId: req.user.uid,
            authorName: userData.name, 
            authorPhotoUrl: userData.photoUrl || null,
            content,
            type,
            reactions: { amen: 0, hallelujah: 0, praiseGod: 0 }, // Initialize reactions
            commentCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const postRef = await db.collection('posts').add(newPost);
        res.status(201).json({ success: true, message: 'Post created.', postId: postRef.id });
    } catch (error) {
        console.error("Error creating post:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /posts/:postId/react
 * Adds a reaction to a post.
 */
app.post('/posts/:postId/react', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    const { postId } = req.params;
    const { reactionType } = req.body; // e.g., "amen", "hallelujah", "praiseGod"
    if (!reactionType) {
        return res.status(400).json({ success: false, message: 'Reaction type is required.' });
    }
    try {
        const postRef = db.collection('posts').doc(postId);
        await postRef.update({
            [`reactions.${reactionType}`]: admin.firestore.FieldValue.increment(1)
        });
        res.status(200).json({ success: true, message: 'Reaction added.' });
    } catch (error) {
        console.error("Error adding reaction:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// -------------------------------------------------------------------------
// CHURCHES, GROUPS & EVENTS ROUTES
// -------------------------------------------------------------------------

/**
 * GET /churches
 * Fetches a list of all churches/groups (Required for ChurchesViewModel).
 */
app.get('/churches', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    try {
        const churchesSnapshot = await db.collection('churches').get();
        const churches = churchesSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.name,
                description: data.description,
                createdBy: data.createdBy,
                members: data.members || [],
                followerCount: data.followerCount || 0
            };
        });
        res.status(200).json({ success: true, churches });
    } catch (error) {
        console.error("Error fetching churches:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /churches
 * Creates a new church/group.
 */
app.post('/churches', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    const { name, description } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, message: 'Church name is required.' });
    }
    try {
        const newChurch = {
            name,
            description: description || '',
            createdBy: req.user.uid,
            members: [req.user.uid],
            followerCount: 1,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const churchRef = await db.collection('churches').add(newChurch);
        res.status(201).json({ success: true, message: 'Church created.', churchId: churchRef.id });
    } catch (error) {
        console.error("Error creating church:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /churches/:churchId/follow
 * Allows a user to follow/join a church (Required for ChurchesViewModel).
 */
app.post('/churches/:churchId/follow', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    const { churchId } = req.params;
    try {
        const churchRef = db.collection('churches').doc(churchId);
        await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(churchRef);
            if (!doc.exists) throw new Error("Church not found.");
            
            const currentMembers = doc.data().members || [];
            if (currentMembers.includes(req.user.uid)) {
                // Already a member, do nothing
                return Promise.resolve({ success: true, message: 'Already joined.' });
            }

            // Atomically update members array and follower count
            transaction.update(churchRef, {
                members: admin.firestore.FieldValue.arrayUnion(req.user.uid),
                followerCount: admin.firestore.FieldValue.increment(1)
            });
        });

        // Also update the user's profile to track which churches they follow
        const userRef = db.collection('users').doc(req.user.uid);
        await userRef.update({
             churches: admin.firestore.FieldValue.arrayUnion(churchId)
        });

        res.status(200).json({ success: true, message: 'Successfully followed church.' });
    } catch (error) {
        console.error("Error following church:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /churches/:churchId/events
 * Creates a new event for a church to advertise.
 */
app.post('/churches/:churchId/events', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    const { churchId } = req.params;
    const { title, details, eventDate } = req.body;
    if (!title || !details || !eventDate) {
        return res.status(400).json({ success: false, message: 'Title, details, and date are required.' });
    }
    try {
        const eventRef = db.collection('churches').doc(churchId).collection('events');
        await eventRef.add({
            title,
            details,
            eventDate: new Date(eventDate),
            postedBy: req.user.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.status(201).json({ success: true, message: 'Event created.' });
    } catch (error) {
        console.error("Error creating church event:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// -------------------------------------------------------------------------
// MEDIA ROUTES (VIDEOS, LIVESTREAMS, TESTIMONIES)
// -------------------------------------------------------------------------

/**
 * GET /media
 * Fetches a list of media items (Required for MediaViewModel).
 */
app.get('/media', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    try {
        const mediaSnapshot = await db.collection('media').orderBy('createdAt', 'desc').limit(10).get();
        const media = mediaSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                title: data.title,
                description: data.description,
                url: data.url,
                mediaType: data.mediaType,
                uploaderId: data.uploaderId,
            };
        });
        res.status(200).json({ success: true, media });
    } catch (error) {
        console.error("Error fetching media:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /media
 * Uploads metadata for a video, testimony, or livestream.
 */
app.post('/media', authenticate, async (req, res) => {
    if (!checkDbConnection(res)) return;
    const { title, description, url, mediaType } = req.body; // mediaType: 'video', 'livestream', 'testimony'
    if (!title || !url || !mediaType) {
        return res.status(400).json({ success: false, message: 'Title, url, and mediaType are required.' });
    }
    try {
        const newMedia = {
            title,
            description: description || '',
            url,
            mediaType,
            uploaderId: req.user.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const mediaRef = await db.collection('media').add(newMedia);
        res.status(201).json({ success: true, message: 'Media created.', mediaId: mediaRef.id });
    } catch (error) {
        console.error("Error creating media item:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// -------------------------------------------------------------------------
// BIBLE & MUSIC ROUTES
// -------------------------------------------------------------------------

/**
 * GET /bible/verse-of-the-day
 * Fetches a pre-selected verse of the day (Required for BibleViewModel).
 */
app.get('/bible/verse-of-the-day', async (req, res) => {
    // This endpoint is public and does not require authentication
    try {
        // In a real app, you would fetch from a database or external API.
        // For now, we'll return a static one as per your original request.
        const verse = {
            reference: "John 3:16",
            text: "For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life."
        };
        res.status(200).json({ success: true, verse });
    } catch (error) {
        console.error("Error fetching verse of the day:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /music/trending
 * Fetches a list of trending Christian songs.
 */
app.get('/music/trending', async (req, res) => {
    // This endpoint is public and does not require authentication
    const trendingSongs = [
        { title: "Reckless Love", artist: "Cory Asbury" },
        { title: "You Say", artist: "Lauren Daigle" },
        { title: "Oceans (Where Feet May Fail)", artist: "Hillsong UNITED" }
    ];
    res.status(200).json({ success: true, songs: trendingSongs });
});

// Export the Express app as the Vercel serverless function entry point
module.exports = app;
