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

// ============ ADMIN ROUTES ============
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalAds = await Ad.countDocuments();
        const activeAds = await Ad.countDocuments({ status: 'active' });
        const totalOrders = await Order.countDocuments();
        const completedOrders = await Order.countDocuments({ status: 'completed' });
        const totalRevenue = await Payment.aggregate([
            { $match: { status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        
        res.json({
            users: { total: totalUsers },
            ads: { total: totalAds, active: activeAds },
            orders: { total: totalOrders, completed: completedOrders },
            revenue: { total: totalRevenue[0]?.total || 0 }
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const users = await User.find().select('-password').sort({ createdAt: -1 });
        res.json(users);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.put('/api/admin/users/:id/verify', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const user = await User.findByIdAndUpdate(req.params.id, { isVerified: true }, { new: true });
        res.json({ success: true, user });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============ AI BOT ROUTE - SIMPLE VERSION (NO GEMINI API) ============
app.post('/api/bot/chat', async (req, res) => {
    try {
        const { message, language } = req.body;
        
        const lowerMsg = (message || '').toLowerCase();
        let reply = '';
        
        if (lowerMsg.includes('bei') || lowerMsg.includes('price') || lowerMsg.includes('gharama') || lowerMsg.includes('kiasi')) {
            reply = "💰 **Bei za Matangazo:**\n• Banner: $100 kwa mwezi\n• Featured: $500 kwa mwezi\n• Sponsored: $1,000 kwa mwezi\n\nKwa maelezo zaidi, WhatsApp: +255796323348";
        }
        else if (lowerMsg.includes('lipa') || lowerMsg.includes('payment') || lowerMsg.includes('malipo') || lowerMsg.includes('bank') || lowerMsg.includes('nmb')) {
            reply = "🏦 **Maelezo ya Malipo:**\n\nBenki: NMB Bank\nJina la Akaunti: City Tech Holdings\nNamba ya Akaunti: 5161480052318274\nSWIFT: NMBCTZTZ\n\n💵 **Njia za Malipo:**\n• Direct Bank Transfer (NMB)\n• Mobile Money (M-Pesa, Tigo Pesa, Airtel Money)\n• Cash on Delivery\n\nBaada ya malipo, tuna proof yako kwa WhatsApp: +255796323348";
        }
        else if (lowerMsg.includes('refund') || lowerMsg.includes('rejesha') || lowerMsg.includes('reimburse')) {
            reply = "💰 **Kuhusu Refund (Kurejeshewa Pesa):**\n\nPesa yako itarejeshwa na **City Tech Holdings** kupitia NMB Bank (Akaunti: 5161480052318274).\n\n📌 **Mchakato wa Refund:**\n1. Ukifanya quality check na bidhaa hailingani\n2. Tunachakata ombi lako ndani ya saa 24\n3. Pesa inarejeshwa kwenye M-Pesa au Akaunti yako ya Benki\n4. Muda wa kurejesha: Siku 1-3\n\nKwa msaada zaidi, WhatsApp: +255796323348";
        }
        else if (lowerMsg.includes('simu') || lowerMsg.includes('phone') || lowerMsg.includes('contact') || lowerMsg.includes('wasiliana') || lowerMsg.includes('namba')) {
            reply = "📞 **Mawasiliano Yetu:**\n\nWhatsApp/Simu: +255796323348\nBarua Pepe: citytechuk@gmail.com\n\nTunapatikana 24/7 kwa maswali yako yote!";
        }
        else if (lowerMsg.includes('track') || lowerMsg.includes('fuatilia') || lowerMsg.includes('order') || lowerMsg.includes('agizo')) {
            reply = "📦 **Kufuatilia Order Yako:**\n\nNenda kwenye sehemu ya 'Track' kwenye website yetu na ingiza namba yako ya order (inaanza na ORD).\n\nAu tuma namba yako ya order hapa nikusaidie kufuatilia!";
        }
        else if (lowerMsg.includes('quality') || lowerMsg.includes('ubora') || lowerMsg.includes('check') || lowerMsg.includes('kagua')) {
            reply = "✅ **Quality Check Process:**\n\n1. Pokea bidhaa yako\n2. Rekodi video fupi (sekunde 10-20) ikionyesha bidhaa\n3. Piga picha 2-3 za bidhaa\n4. Tembelea sehemu ya 'Quality Check' kwenye website yako\n5. Pakia video na picha\n\nKama bidhaa hailingani na maelezo, utalipwa pesa yako tena ndani ya siku 3!";
        }
        else {
            reply = "👋 Hello! I'm City Find AI Assistant.\n\nI can help you with:\n• 💰 **Bei za Matangazo** - Banner $100, Featured $500, Sponsored $1000\n• 📦 **Kufuatilia delivery** - Tuma order number yako\n• 💳 **Malipo** - NMB Bank: 5161480052318274\n• ✅ **Quality check** - Ukaguzi wa bidhaa kwa video\n• 🔄 **Refund** - Kurejeshewa pesa kama bidhaa hailingani\n\n📞 WhatsApp: +255796323348\n📧 Email: citytechuk@gmail.com\n\nNiulize swali lolote kuhusu huduma zetu!";
        }
        
        res.json({ reply: reply });
    } catch (error) {
        console.error('Bot Error:', error.message);
        res.json({ reply: "Samahani, kuna tatizo. Tafadhali wasiliana nasi kwenye WhatsApp: +255796323348 kwa msaada wa haraka." });
    }
});

// ============ SERVE HTML FILES ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 City Find Global Platform running on port ${PORT}`);
    console.log(`📱 Admin Email: ${process.env.ADMIN_EMAIL || 'citytechuk@gmail.com'}`);
    console.log(`📞 Admin Phone: ${process.env.ADMIN_PHONE || '+255796323348'}`);
    console.log(`🏦 NMB Account: ${process.env.NMB_ACCOUNT || '5161480052318274'}`);
});
