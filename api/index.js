const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// --- Firebase Admin Initialization ---
// This setup assumes you have the FIREBASE_SERVICE_ACCOUNT environment variable
// configured in your Vercel project settings.
let db;
try {
    if (admin.apps.length === 0) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log('Firebase Admin Initialized successfully.');
    }
} catch (e) {
    console.error('Failed to initialize Firebase Admin SDK:', e.message);
}

const app = express();
app.use(cors({ origin: '*' })); // Be sure to restrict this in a real production environment
app.use(express.json());


// =========================================================================
// AUTHENTICATION MIDDLEWARE
// =========================================================================
const authenticate = async (req, res, next) => {
    const { authorization } = req.headers;
    if (!authorization || !authorization.startsWith('Bearer ')) {
        return res.status(401).send({ success: false, message: 'Unauthorized: No token provided.' });
    }
    const token = authorization.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; // Add user info to the request object
        next();
    } catch (error) {
        return res.status(401).send({ success: false, message: 'Unauthorized: Invalid token.' });
    }
};


// =========================================================================
// API ROUTES
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
 * Creates the user's profile document in Firestore after they sign up.
 */
app.post('/signup-profile', async (req, res) => {
    const { userId, name, email, phone, age, country, photoUrl } = req.body;

    if (!userId || !name || !email) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    try {
        const userRef = db.collection('users').doc(userId);
        await userRef.set({
            name,
            email,
            phone: phone || null,
            age: age ? parseInt(age) : null,
            country: country || null,
            photoUrl: photoUrl || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            following: [], // List of user IDs they follow
            followers: [], // List of user IDs that follow them
        });
        res.status(201).json({ success: true, message: 'Profile created successfully.' });
    } catch (error) {
        console.error("Error creating user profile:", error);
        res.status(500).json({ success: false, message: 'Failed to create profile.', error: error.message });
    }
});

/**
 * GET /users/search
 * Finds other Christians by searching for their name or email.
 */
app.get('/users/search', authenticate, async (req, res) => {
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ success: false, message: 'A search query is required.' });
    }
    try {
        const snapshot = await db.collection('users').where('name', '>=', query).where('name', '<=', query + '\uf8ff').get();
        const users = snapshot.docs.map(doc => ({
            id: doc.id,
            name: doc.data().name,
            photoUrl: doc.data().photoUrl
        }));
        res.status(200).json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /users/friend-request
 * Sends a friend request to another user.
 */
app.post('/users/friend-request', authenticate, async (req, res) => {
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
        res.status(500).json({ success: false, message: error.message });
    }
});


// -------------------------------------------------------------------------
// POSTS, STATUS UPDATES, REACTIONS & COMMENTS ROUTES
// -------------------------------------------------------------------------

/**
 * POST /posts
 * Creates a new post or status update.
 */
app.post('/posts', authenticate, async (req, res) => {
    const { content, type = 'post' } = req.body; // type can be 'post' or 'status'
    if (!content) {
        return res.status(400).json({ success: false, message: 'Content is required.' });
    }
    try {
        const newPost = {
            authorId: req.user.uid,
            authorName: req.user.name,
            authorPhotoUrl: req.user.picture || null,
            content,
            type,
            reactions: {}, // e.g., { amen: 10, hallelujah: 5 }
            commentCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const postRef = await db.collection('posts').add(newPost);
        res.status(201).json({ success: true, message: 'Post created.', postId: postRef.id });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /posts/:postId/react
 * Adds a reaction to a post.
 */
app.post('/posts/:postId/react', authenticate, async (req, res) => {
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
        res.status(500).json({ success: false, message: error.message });
    }
});


// -------------------------------------------------------------------------
// CHURCHES, GROUPS & EVENTS ROUTES
// -------------------------------------------------------------------------

/**
 * POST /churches
 * Creates a new church/group.
 */
app.post('/churches', authenticate, async (req, res) => {
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
            followerCount: 1
        };
        const churchRef = await db.collection('churches').add(newChurch);
        res.status(201).json({ success: true, message: 'Church created.', churchId: churchRef.id });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /churches/:churchId/follow
 * Allows a user to follow/join a church.
 */
app.post('/churches/:churchId/follow', authenticate, async (req, res) => {
    const { churchId } = req.params;
    try {
        const churchRef = db.collection('churches').doc(churchId);
        await churchRef.update({
            members: admin.firestore.FieldValue.arrayUnion(req.user.uid),
            followerCount: admin.firestore.FieldValue.increment(1)
        });
        res.status(200).json({ success: true, message: 'Successfully followed church.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /churches/:churchId/events
 * Creates a new event for a church to advertise.
 */
app.post('/churches/:churchId/events', authenticate, async (req, res) => {
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
            postedBy: req.user.uid
        });
        res.status(201).json({ success: true, message: 'Event created.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


// -------------------------------------------------------------------------
// MEDIA ROUTES (VIDEOS, LIVESTREAMS, TESTIMONIES)
// -------------------------------------------------------------------------

/**
 * POST /media
 * Uploads metadata for a video, testimony, or livestream.
 */
app.post('/media', authenticate, async (req, res) => {
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
        res.status(500).json({ success: false, message: error.message });
    }
});


// -------------------------------------------------------------------------
// BIBLE & MUSIC ROUTES
// -------------------------------------------------------------------------

/**
 * GET /bible/verse-of-the-day
 * Fetches a pre-selected verse of the day.
 */
app.get('/bible/verse-of-the-day', async (req, res) => {
    try {
        // In a real app, you would have a collection of verses and pick one,
        // but for now, we'll return a static one.
        const verse = {
            reference: "John 3:16",
            text: "For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life."
        };
        res.status(200).json({ success: true, verse });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /music/trending
 * Fetches a list of trending Christian songs.
 */
app.get('/music/trending', async (req, res) => {
    // This would typically involve a more complex system, maybe integrating with a
    // music API or tracking plays internally. Here's a static example.
    const trendingSongs = [
        { title: "Reckless Love", artist: "Cory Asbury" },
        { title: "You Say", artist: "Lauren Daigle" },
        { title: "Oceans (Where Feet May Fail)", artist: "Hillsong UNITED" }
    ];
    res.status(200).json({ success: true, songs: trendingSongs });
});

// Export the app for Vercel
module.exports = app;
