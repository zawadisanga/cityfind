const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const path = require('path');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
app.set('io', io);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ DATABASE SCHEMAS ============
const userSchema = new mongoose.Schema({
    fullName: String,
    email: { type: String, unique: true },
    password: String,
    phone: String,
    role: { type: String, enum: ['admin', 'company', 'provider', 'receiver', 'viewer'], default: 'viewer' },
    companyName: String,
    logoUrl: String,
    isVerified: { type: Boolean, default: false },
    walletBalance: { type: Number, default: 0 },
    rating: { type: Number, default: 5 },
    totalDeliveries: { type: Number, default: 0 },
    location: { lat: Number, lng: Number, address: String },
    createdAt: { type: Date, default: Date.now }
});

const adSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    title: String,
    description: String,
    mediaUrls: [String],
    mediaType: { type: String, enum: ['image', 'video', 'pdf', 'animation'], default: 'image' },
    category: String,
    adType: { type: String, enum: ['banner', 'featured', 'sidebar', 'sponsored'], default: 'banner' },
    price: Number,
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['pending', 'active', 'expired', 'rejected'], default: 'pending' },
    expiryDate: Date,
    galaxyAnimation: String,
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
    orderNumber: { type: String, unique: true },
    productName: String,
    productQR: String,
    productBarcode: String,
    productImage: String,
    quantity: Number,
    qualitySpecs: [String],
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { 
        type: String, 
        enum: ['pending', 'scanning', 'in_transit', 'quality_check', 'delivered', 'disputed', 'completed'],
        default: 'pending'
    },
    currentLocation: { lat: Number, lng: Number, address: String },
    trackingHistory: [{
        location: { lat: Number, lng: Number, address: String },
        status: String,
        timestamp: Date,
        videoUrl: String,
        photoUrls: [String]
    }],
    qualityCheckVideo: String,
    qualityCheckPhotos: [String],
    qualityPassed: { type: Boolean, default: false },
    qualityIssues: String,
    paymentAmount: { type: Number, default: 0 },
    paymentCurrency: { type: String, default: 'USD' },
    paymentStatus: { type: String, enum: ['pending', 'escrow', 'released', 'refunded'], default: 'pending' },
    deliveryFee: { type: Number, default: 10 },
    distance: { type: Number, default: 0 },
    estimatedDelivery: Date,
    actualDelivery: Date,
    createdAt: { type: Date, default: Date.now }
});

const paymentSchema = new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    adId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad' },
    amount: Number,
    currency: { type: String, default: 'USD' },
    method: { type: String, enum: ['stripe', 'pesapal', 'nmb', 'card', 'crypto'] },
    transactionId: String,
    status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },
    senderAccount: String,
    receiverAccount: String,
    senderName: String,
    receiverName: String,
    createdAt: { type: Date, default: Date.now }
});

const companyRatingSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    deliveryOnTime: Boolean,
    qualityMatched: Boolean,
    communication: { type: Number, min: 1, max: 5 },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Ad = mongoose.model('Ad', adSchema);
const Order = mongoose.model('Order', orderSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const CompanyRating = mongoose.model('CompanyRating', companyRatingSchema);

// ============ CONNECT TO MONGODB ============
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cityfind';
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('✅ MongoDB connected successfully');
}).catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
});

// ============ AUTH MIDDLEWARE ============
const authMiddleware = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'citytech_secret_key');
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const adminMiddleware = async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
};

// ============ AUTH ROUTES ============
app.post('/api/auth/register', async (req, res) => {
    try {
        const { fullName, email, password, phone, role, companyName } = req.body;
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: 'Email already registered' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ fullName, email, password: hashedPassword, phone, role, companyName });
        await user.save();
        
        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'citytech_secret_key');
        res.json({ token, user: { id: user._id, email, role, fullName, phone } });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid password' });
        
        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'citytech_secret_key');
        res.json({ token, user: { id: user._id, email, role: user.role, fullName: user.fullName, phone: user.phone } });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json(user);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============ ADS ROUTES ============
app.post('/api/ads/create', authMiddleware, async (req, res) => {
    try {
        const { title, description, mediaUrls, mediaType, category, adType, price, currency, expiryDate } = req.body;
        
        const galaxyAnimations = {
            banner: 'spiral_galaxy',
            featured: 'exploding_stars',
            sidebar: 'nebula_cloud',
            sponsored: 'black_hole_pulse'
        };
        
        const ad = new Ad({
            companyId: req.user.id,
            title,
            description,
            mediaUrls: mediaUrls || [],
            mediaType: mediaType || 'image',
            category,
            adType: adType || 'banner',
            price: price || (adType === 'banner' ? 100 : adType === 'featured' ? 500 : 1000),
            currency: currency || 'USD',
            expiryDate: expiryDate ? new Date(expiryDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            galaxyAnimation: galaxyAnimations[adType] || 'standard_galaxy',
            status: 'pending'
        });
        
        await ad.save();
        res.json({ success: true, ad });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/ads', async (req, res) => {
    try {
        const { category, type, search } = req.query;
        let query = { status: 'active' };
        if (category && category !== 'all') query.category = category;
        if (type) query.adType = type;
        if (search) query.title = { $regex: search, $options: 'i' };
        
        const ads = await Ad.find(query).populate('companyId', 'companyName logoUrl rating').sort({ createdAt: -1 });
        res.json(ads);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/ads/my', authMiddleware, async (req, res) => {
    try {
        const ads = await Ad.find({ companyId: req.user.id });
        res.json(ads);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.put('/api/ads/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const ad = await Ad.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true });
        res.json({ success: true, ad });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/ads/:id', authMiddleware, async (req, res) => {
    try {
        await Ad.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============ ORDER & TRACKING ROUTES ============
app.post('/api/orders/create', authMiddleware, async (req, res) => {
    try {
        const { productName, quantity, qualitySpecs, receiverId, productImage, deliveryFee } = req.body;
        
        const orderNumber = 'ORD' + Date.now() + Math.floor(Math.random() * 10000);
        
        const qrData = JSON.stringify({ orderNumber, productName, senderId: req.user.id, timestamp: Date.now() });
        const qrImage = await QRCode.toDataURL(qrData);
        
        let barcodeBase64 = '';
        try {
            const barcodeBuffer = await bwipjs.toBuffer({
                bcid: 'code128',
                text: orderNumber,
                scale: 3,
                height: 10,
                includetext: true,
                textxalign: 'center'
            });
            barcodeBase64 = barcodeBuffer.toString('base64');
        } catch (barcodeErr) {
            console.error('Barcode error:', barcodeErr);
        }
        
        const order = new Order({
            orderNumber,
            productName,
            quantity: quantity || 1,
            qualitySpecs: qualitySpecs ? qualitySpecs.split(',') : [],
            productImage,
            senderId: req.user.id,
            receiverId: receiverId || req.user.id,
            productQR: qrImage,
            productBarcode: barcodeBase64,
            deliveryFee: deliveryFee || 10,
            status: 'pending',
            paymentStatus: 'pending'
        });
        
        await order.save();
        res.json({ success: true, order, qrCode: qrImage });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/orders', authMiddleware, async (req, res) => {
    try {
        const orders = await Order.find({
            $or: [
                { senderId: req.user.id },
                { receiverId: req.user.id },
                { providerId: req.user.id }
            ]
        }).populate('senderId receiverId providerId', 'fullName phone companyName rating');
        res.json(orders);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/orders/:orderNumber', async (req, res) => {
    try {
        const order = await Order.findOne({ orderNumber: req.params.orderNumber })
            .populate('senderId receiverId providerId', 'fullName phone companyName rating');
        if (!order) return res.status(404).json({ error: 'Order not found' });
        res.json(order);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/orders/scan', authMiddleware, async (req, res) => {
    try {
        const { orderNumber, location, videoUrl, photoUrls } = req.body;
        const order = await Order.findOne({ orderNumber });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        order.trackingHistory.push({
            location,
            status: order.status,
            timestamp: new Date(),
            videoUrl,
            photoUrls: photoUrls || []
        });
        
        if (order.status === 'pending') {
            order.status = 'scanning';
            order.providerId = req.user.id;
        } else if (order.status === 'scanning') {
            order.status = 'in_transit';
        } else if (order.status === 'in_transit') {
            order.status = 'quality_check';
        }
        
        order.currentLocation = location;
        await order.save();
        
        io.emit('order-update', { orderNumber, status: order.status, location, timestamp: new Date() });
        
        res.json({ success: true, order });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/orders/update-location', authMiddleware, async (req, res) => {
    try {
        const { orderNumber, lat, lng, address } = req.body;
        const order = await Order.findOne({ orderNumber });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        order.currentLocation = { lat, lng, address };
        order.trackingHistory.push({
            location: { lat, lng, address },
            status: order.status,
            timestamp: new Date()
        });
        
        await order.save();
        io.emit('location-update', { orderNumber, lat, lng, address });
        
        res.json({ success: true, location: order.currentLocation });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/orders/quality-check', authMiddleware, async (req, res) => {
    try {
        const { orderNumber, qualityPassed, videoUrl, photos, issues } = req.body;
        const order = await Order.findOne({ orderNumber });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        order.qualityCheckVideo = videoUrl;
        order.qualityCheckPhotos = photos || [];
        order.qualityPassed = qualityPassed;
        
        if (qualityPassed) {
            order.status = 'completed';
            order.actualDelivery = new Date();
            await Payment.findOneAndUpdate({ orderId: order._id }, { status: 'completed' });
        } else {
            order.status = 'disputed';
            order.qualityIssues = issues;
        }
        
        await order.save();
        io.emit('quality-check-result', { orderNumber, qualityPassed, issues });
        
        res.json({ success: true, order });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============ PAYMENT ROUTES ============
app.post('/api/payments/create-intent', authMiddleware, async (req, res) => {
    try {
        const { amount, currency, orderId, method } = req.body;
        
        const payment = new Payment({
            orderId,
            amount,
            currency: currency || 'USD',
            method: method || 'nmb',
            transactionId: (method === 'nmb' ? 'NMB' : 'TXN') + Date.now() + Math.floor(Math.random() * 10000),
            status: 'pending',
            receiverAccount: process.env.NMB_ACCOUNT || '5161480052318274',
            senderName: req.user.fullName,
            receiverName: 'City Tech Holdings'
        });
        await payment.save();
        
        if (method === 'nmb') {
            res.json({ 
                bankDetails: {
                    bank: 'NMB Bank Tanzania',
                    accountName: 'City Tech Holdings',
                    accountNumber: process.env.NMB_ACCOUNT || '5161480052318274',
                    swiftCode: 'NMBCTZTZ',
                    reference: payment.transactionId,
                    amount: amount,
                    currency: currency || 'USD'
                },
                paymentId: payment._id
            });
        } else {
            res.json({ 
                message: 'Payment initiated',
                paymentId: payment._id,
                transactionId: payment.transactionId
            });
        }
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/payments/confirm', authMiddleware, async (req, res) => {
    try {
        const { paymentId, transactionReference } = req.body;
        const payment = await Payment.findById(paymentId);
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        
        payment.status = 'completed';
        payment.transactionId = transactionReference || payment.transactionId;
        await payment.save();
        
        if (payment.orderId) {
            await Order.findByIdAndUpdate(payment.orderId, { paymentStatus: 'escrow', paymentAmount: payment.amount });
        }
        
        res.json({ success: true, payment });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/payments/history', authMiddleware, async (req, res) => {
    try {
        const payments = await Payment.find().sort({ createdAt: -1 });
        res.json(payments);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============ RATINGS ROUTES ============
app.post('/api/ratings/company', authMiddleware, async (req, res) => {
    try {
        const { companyId, orderId, rating, comment, deliveryOnTime, qualityMatched, communication } = req.body;
        
        const ratingRecord = new CompanyRating({
            companyId,
            reviewerId: req.user.id,
            orderId,
            rating,
            comment,
            deliveryOnTime,
            qualityMatched,
            communication: communication || 5
        });
        await ratingRecord.save();
        
        const avgRating = await CompanyRating.aggregate([
            { $match: { companyId: companyId } },
            { $group: { _id: null, avg: { $avg: '$rating' } } }
        ]);
        
        await User.findByIdAndUpdate(companyId, { rating: avgRating[0]?.avg || 5 });
        
        res.json({ success: true, rating: ratingRecord });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/ratings/company/:companyId', async (req, res) => {
    try {
        const ratings = await CompanyRating.find({ companyId: req.params.companyId })
            .populate('reviewerId', 'fullName')
            .sort({ createdAt: -1 });
        res.json(ratings);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============ AI BOT ROUTE - SIMPLE VERSION ============
// // ============ AI BOT ROUTE - WITH DEEPSEEK API ============
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

app.post('/api/bot/chat', async (req, res) => {
    try {
        const { message, language } = req.body;
        
        console.log('🤖 User asked:', message);
        
        // DeepSeek API endpoint
        const apiUrl = "https://api.deepseek.com/v1/chat/completions";
        
        const response = await axios.post(
            apiUrl,
            {
                model: "deepseek-chat",
                messages: [
                    {
                        role: "system",
                        content: `You are City Find AI Assistant - a helpful business assistant for a Tanzanian company.

COMPANY INFO:
- Name: City Find (by City Tech Holdings)
- WhatsApp/Phone: +255796323348
- Email: citytechuk@gmail.com
- Bank: NMB Bank Tanzania
- Account Name: City Tech Holdings  
- Account Number: 5161480052318274
- SWIFT: NMBCTZTZ

SERVICES & PRICING:
- Banner Ads: $100 per month
- Featured Ads: $500 per month
- Sponsored Ads: $1,000 per month
- Delivery Tracking: Free
- Quality Check: Free (with video verification)

CAPABILITIES:
- Can create HTML/CSS/JavaScript code for websites, animations, and applications
- Can create flower animations, car animations, music players, galaxy effects, and more
- Can help with business inquiries about ads, payments, tracking, and quality checks

INSTRUCTIONS:
1. If user asks to CREATE something (HTML, CSS, website, animation, flower, car, music, galaxy), provide COMPLETE working code
2. Answer in ${language === 'sw' ? 'Swahili (Kiswahili)' : 'English'}
3. Be friendly, helpful, and professional
4. For HTML/CSS requests, give full code inside triple backticks
5. Keep responses helpful and concise`
                    },
                    {
                        role: "user",
                        content: message
                    }
                ],
                temperature: 0.7,
                max_tokens: 2000
            },
            {
                headers: { 
                    Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        
        if (response.data && response.data.choices && response.data.choices[0]) {
            const botReply = response.data.choices[0].message.content;
            console.log('✅ DeepSeek API responded successfully');
            return res.json({ reply: botReply });
        }
        
        throw new Error('No response from DeepSeek');
        
    } catch (error) {
        console.error('❌ DeepSeek API Error:', error.message);
        if (error.response) {
            console.error('API Response:', error.response.data);
        }
        
        // Fallback response for HTML/CSS creation
        const lowerMsg = (message || '').toLowerCase();
        let fallbackReply = "";
        
        // HTML/CSS creation fallbacks
        if (lowerMsg.includes('flower') || (lowerMsg.includes('frower'))) {
            fallbackReply = `🌸 **Beautiful Flower HTML/CSS** 🌸

\`\`\`html
<!DOCTYPE html>
<html>
<head>
<style>
body {
    background: linear-gradient(135deg, #0a0f2a, #000);
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
}
.flower {
    position: relative;
    width: 200px;
    height: 200px;
    animation: float 3s ease infinite;
}
@keyframes float {
    0%,100% { transform: translateY(0); }
    50% { transform: translateY(-20px); }
}
.petal {
    position: absolute;
    width: 80px;
    height: 80px;
    background: radial-gradient(circle, #ff69b4, #ff1493);
    border-radius: 50%;
    box-shadow: 0 0 20px rgba(255,105,180,0.5);
}
.petal1 { top: -30px; left: 60px; }
.petal2 { top: 30px; right: -30px; }
.petal3 { bottom: -30px; left: 60px; }
.petal4 { top: 30px; left: -30px; }
.center {
    position: absolute;
    width: 50px;
    height: 50px;
    background: radial-gradient(circle, #ffd700, #ff8c00);
    border-radius: 50%;
    top: 75px;
    left: 75px;
    animation: pulse 1s ease infinite;
}
@keyframes pulse {
    0%,100% { transform: scale(1); }
    50% { transform: scale(1.1); }
}
.stem {
    position: absolute;
    width: 8px;
    height: 150px;
    background: green;
    bottom: -140px;
    left: 96px;
}
</style>
</head>
<body>
<div class="flower">
    <div class="petal petal1"></div>
    <div class="petal petal2"></div>
    <div class="petal petal3"></div>
    <div class="petal petal4"></div>
    <div class="center"></div>
    <div class="stem"></div>
</div>
</body>
</html>
\`\`\`

Save as flower.html and open in browser! 🌷`;
        }
        else if (lowerMsg.includes('car')) {
            fallbackReply = "🚗 **Car Animation Coming!** I'll help you create a car animation. Please be more specific about what kind of car animation you want!";
        }
        else if (lowerMsg.includes('music') || lowerMsg.includes('song')) {
            fallbackReply = "🎵 **Music Player Coming!** I can help you create a music player website. Would you like a simple audio player or a full music streaming interface?";
        }
        else if (lowerMsg.includes('galaxy') || lowerMsg.includes('space')) {
            fallbackReply = "🌌 **Galaxy Animation Coming!** I can create a beautiful spinning galaxy animation. Let me prepare the code for you!";
        }
        else {
            fallbackReply = "👋 **Hello! I'm City Find AI Assistant.**\n\n🎨 **I can create:**\n• 🌸 Flowers\n• 🚗 Car animations\n• 🎵 Music players\n• 🌌 Galaxy effects\n• Any HTML/CSS you want!\n\n💰 **Business:**\n• Ads: $100-$1000/month\n• Payments: NMB 5161480052318274\n\n📞 WhatsApp: +255796323348\n\n**Just tell me what to create!**";
        }
        
        res.json({ reply: fallbackReply });
    }
});

// ============ SERVE HTML FILES ============
app.get('/dashboard-admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard-admin.html'));
});
app.get('/dashboard-company.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard-company.html'));
});
app.get('/dashboard-provider.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard-provider.html'));
});
app.get('/dashboard-receiver.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard-receiver.html'));
});

// ============ SOCKET.IO CONNECTION ============
const connectedUsers = new Map();

io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);
    
    socket.on('register-user', (userId) => {
        connectedUsers.set(userId, socket.id);
        socket.userId = userId;
    });
    
    socket.on('call-user', ({ from, to, signalData, type }) => {
        const targetSocket = connectedUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('incoming-call', { from, signalData, type });
        }
    });
    
    socket.on('answer-call', ({ to, signalData }) => {
        const targetSocket = connectedUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('call-answered', { signalData });
        }
    });
    
    socket.on('disconnect', () => {
        for (let [userId, sockId] of connectedUsers.entries()) {
            if (sockId === socket.id) connectedUsers.delete(userId);
        }
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============ ROOT ROUTE ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 City Find Global Platform running on port ${PORT}`);
    console.log(`📱 Admin Email: ${process.env.ADMIN_EMAIL || 'citytechuk@gmail.com'}`);
    console.log(`📞 Admin Phone: ${process.env.ADMIN_PHONE || '+255796323348'}`);
    console.log(`🏦 NMB Account: ${process.env.NMB_ACCOUNT || '5161480052318274'}`);
});


// ============ PAYMENT VERIFICATION SYSTEM WITH FREE TIER ============

// Free tier check - user gets 1 month free on first login
app.get('/api/check-free-tier', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        
        // Check if user already used free tier
        if (user.freeTierUsed && user.freeTierExpiry > new Date()) {
            return res.json({ 
                hasFreeTier: true, 
                expiresAt: user.freeTierExpiry,
                message: "You have an active free tier!"
            });
        }
        
        if (!user.freeTierUsed) {
            // Give free tier for 30 days
            user.freeTierUsed = true;
            user.freeTierExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            user.isPremium = false;
            await user.save();
            
            return res.json({ 
                hasFreeTier: true, 
                expiresAt: user.freeTierExpiry,
                message: "Welcome! You've received 1 month free tier!"
            });
        }
        
        res.json({ hasFreeTier: false, message: "Free tier expired. Please make a payment." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Upload payment screenshot
const paymentUpload = multer({ storage: storage });

app.post('/api/payments/upload-screenshot', authMiddleware, paymentUpload.single('screenshot'), async (req, res) => {
    try {
        const { amount, phoneNumber, transactionId } = req.body;
        const screenshotUrl = req.file ? req.file.path : null;
        
        const payment = new Payment({
            userId: req.user.id,
            amount: amount || 0,
            currency: 'TZS',
            method: 'bank_transfer',
            transactionId: transactionId || 'PENDING_' + Date.now(),
            status: 'pending',
            screenshotUrl: screenshotUrl,
            phoneNumber: phoneNumber,
            senderName: req.user.fullName
        });
        
        await payment.save();
        
        // Send WhatsApp notification to admin
        const whatsappMessage = `🔔 *NEW PAYMENT UPLOADED!*\n\nUser: ${req.user.fullName}\nPhone: ${phoneNumber}\nAmount: ${amount} TZS\nTransaction ID: ${payment.transactionId}\n\nPlease verify payment and confirm.`;
        
        // You'll need WhatsApp Business API or Twilio
        await sendWhatsAppMessage(process.env.ADMIN_PHONE, whatsappMessage);
        
        res.json({ 
            success: true, 
            paymentId: payment._id,
            message: "Payment screenshot uploaded! Our team will verify within 24 hours."
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Admin verify payment and activate service
app.post('/api/admin/verify-payment', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { paymentId, action } = req.body;
        const payment = await Payment.findById(paymentId).populate('userId');
        
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        
        if (action === 'approve') {
            payment.status = 'completed';
            payment.verifiedAt = new Date();
            await payment.save();
            
            // Activate premium for user (1 month)
            payment.userId.isPremium = true;
            payment.userId.premiumExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            await payment.userId.save();
            
            // Send WhatsApp confirmation to user
            const confirmMessage = `✅ *PAYMENT CONFIRMED!*\n\nDear ${payment.userId.fullName},\n\nYour payment has been verified! Your premium account is now ACTIVE for 30 days.\n\nThank you for choosing City Find! 🚀`;
            await sendWhatsAppMessage(payment.userId.phone, confirmMessage);
            
            res.json({ success: true, message: "Payment verified! User premium activated." });
        } else if (action === 'reject') {
            payment.status = 'failed';
            payment.rejectionReason = req.body.reason;
            await payment.save();
            
            const rejectMessage = `❌ *PAYMENT REJECTED*\n\nDear ${payment.userId.fullName},\n\nYour payment could not be verified. Please contact us for assistance.\n\nWhatsApp: +255796323348`;
            await sendWhatsAppMessage(payment.userId.phone, rejectMessage);
            
            res.json({ success: true, message: "Payment rejected." });
        }
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// User check payment status
app.get('/api/payments/status', authMiddleware, async (req, res) => {
    try {
        const payments = await Payment.find({ userId: req.user.id }).sort({ createdAt: -1 });
        const user = await User.findById(req.user.id);
        
        res.json({
            payments: payments,
            isPremium: user.isPremium || false,
            premiumExpiry: user.premiumExpiry,
            freeTierUsed: user.freeTierUsed,
            freeTierExpiry: user.freeTierExpiry
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// WhatsApp webhook for incoming messages (to verify payments)
app.post('/api/whatsapp-webhook', async (req, res) => {
    try {
        const { from, message, mediaUrl } = req.body;
        
        // Check if message contains payment confirmation
        if (message.toLowerCase().includes('confirmed') || message.toLowerCase().includes('thibitisha')) {
            // Extract transaction ID from message
            const transactionMatch = message.match(/TXN[0-9]+/i);
            if (transactionMatch) {
                const payment = await Payment.findOne({ transactionId: transactionMatch[0] });
                if (payment && payment.status === 'pending') {
                    payment.status = 'completed';
                    payment.verifiedAt = new Date();
                    await payment.save();
                    
                    // Activate premium
                    const user = await User.findById(payment.userId);
                    user.isPremium = true;
                    user.premiumExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                    await user.save();
                    
                    await sendWhatsAppMessage(from, `✅ Payment confirmed! Your premium is active for 30 days.`);
                }
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Helper function to send WhatsApp messages (using WhatsApp Business API or Green API)
async function sendWhatsAppMessage(phoneNumber, message) {
    try {
        // If you have Green API or WhatsApp Business API, put here
        console.log(`WhatsApp to ${phoneNumber}: ${message}`);
        
        // Example with Green API (you'll need to sign up)
        // const GREEN_API_URL = process.env.GREEN_API_URL;
        // const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;
        // await axios.post(`${GREEN_API_URL}/sendMessage`, {
        //     phone: phoneNumber,
        //     message: message
        // }, {
        //     headers: { Authorization: `Bearer ${GREEN_API_TOKEN}` }
        // });
        
        return true;
    } catch (error) {
        console.error('WhatsApp send error:', error);
        return false;
    }
}

// ============ FREE TIER & PAYMENT ROUTES ============

// Check free tier status
app.get('/api/check-free-tier', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const now = new Date();
        
        // Check if user already has active free tier
        if (user.freeTierExpiry && user.freeTierExpiry > now) {
            return res.json({ 
                hasFreeTier: true, 
                expiresAt: user.freeTierExpiry,
                message: "You have an active free tier!"
            });
        }
        
        // If user never had free tier, give them 30 days
        if (!user.freeTierUsed) {
            user.freeTierUsed = true;
            user.freeTierExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            await user.save();
            
            return res.json({ 
                hasFreeTier: true, 
                expiresAt: user.freeTierExpiry,
                message: "Welcome! You've received 1 month free tier!"
            });
        }
        
        res.json({ hasFreeTier: false, message: "Free tier expired. Please make a payment." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Upload payment screenshot
const paymentUpload = multer({ storage: storage });
app.post('/api/payments/upload-screenshot', authMiddleware, paymentUpload.single('screenshot'), async (req, res) => {
    try {
        const { amount, phoneNumber, transactionId } = req.body;
        const screenshotUrl = req.file ? req.file.path : null;
        
        const payment = new Payment({
            orderId: null,
            amount: amount || 0,
            currency: 'TZS',
            method: 'bank_transfer',
            transactionId: transactionId || 'PENDING_' + Date.now(),
            status: 'pending',
            senderAccount: phoneNumber,
            receiverAccount: process.env.NMB_ACCOUNT || '5161480052318274',
            senderName: req.user.fullName,
            receiverName: 'City Tech Holdings'
        });
        
        await payment.save();
        
        // You can add WhatsApp notification here
        console.log(`📱 Payment uploaded by ${req.user.fullName}: ${amount} TZS`);
        
        res.json({ 
            success: true, 
            paymentId: payment._id,
            message: "Payment screenshot uploaded! Our team will verify within 24 hours."
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Get payment status
app.get('/api/payments/status', authMiddleware, async (req, res) => {
    try {
        const payments = await Payment.find({ senderName: req.user.fullName }).sort({ createdAt: -1 });
        const user = await User.findById(req.user.id);
        
        res.json({
            payments: payments.map(p => ({
                amount: p.amount,
                status: p.status,
                createdAt: p.createdAt
            })),
            isPremium: user.isPremium || false,
            premiumExpiry: user.premiumExpiry
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Submit rating for company
app.post('/api/ratings/company', authMiddleware, async (req, res) => {
    try {
        const { companyId, orderId, rating, comment, deliveryOnTime, qualityMatched, communication } = req.body;
        
        const ratingRecord = new CompanyRating({
            companyId,
            reviewerId: req.user.id,
            orderId: orderId || 'test_order_' + Date.now(),
            rating: rating,
            comment: comment || '',
            deliveryOnTime: deliveryOnTime || true,
            qualityMatched: qualityMatched || true,
            communication: communication || rating
        });
        await ratingRecord.save();
        
        // Update company's average rating
        const avgRating = await CompanyRating.aggregate([
            { $match: { companyId: companyId } },
            { $group: { _id: null, avg: { $avg: '$rating' } } }
        ]);
        
        await User.findByIdAndUpdate(companyId, { rating: avgRating[0]?.avg || rating });
        
        res.json({ success: true, message: "Rating submitted successfully!" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Get ratings for a company
app.get('/api/ratings/company/:companyId', async (req, res) => {
    try {
        const ratings = await CompanyRating.find({ companyId: req.params.companyId })
            .populate('reviewerId', 'fullName')
            .sort({ createdAt: -1 });
        res.json(ratings);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});
