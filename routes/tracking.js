const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');

const authMiddleware = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// Create Order with QR/Barcode
router.post('/orders/create', authMiddleware, async (req, res) => {
    try {
        const { productName, quantity, qualitySpecs, receiverId, productImage, deliveryFee } = req.body;
        
        const orderNumber = 'ORD' + Date.now() + Math.floor(Math.random() * 10000);
        
        // Generate QR Code
        const qrData = JSON.stringify({ orderNumber, productName, senderId: req.user.id, timestamp: Date.now() });
        const qrImage = await QRCode.toDataURL(qrData);
        
        // Generate Barcode
        const barcodeBuffer = await bwipjs.toBuffer({
            bcid: 'code128',
            text: orderNumber,
            scale: 3,
            height: 10,
            includetext: true,
            textxalign: 'center'
        });
        
        const order = new Order({
            orderNumber,
            productName,
            quantity,
            qualitySpecs: qualitySpecs ? qualitySpecs.split(',') : [],
            productImage,
            senderId: req.user.id,
            receiverId,
            productQR: qrImage,
            productBarcode: barcodeBuffer.toString('base64'),
            deliveryFee: deliveryFee || 0,
            status: 'pending',
            paymentStatus: 'pending'
        });
        
        await order.save();
        res.json({ success: true, order, qrCode: qrImage });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Get Orders for User
router.get('/orders', authMiddleware, async (req, res) => {
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

// Get Single Order
router.get('/orders/:orderNumber', async (req, res) => {
    try {
        const order = await Order.findOne({ orderNumber: req.params.orderNumber })
            .populate('senderId receiverId providerId', 'fullName phone companyName rating');
        if (!order) return res.status(404).json({ error: 'Order not found' });
        res.json(order);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Scan Order (Update Status)
router.post('/orders/scan', authMiddleware, async (req, res) => {
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
        
        // Status progression
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
        
        // Emit socket event (will be handled in server.js)
        const io = req.app.get('io');
        if (io) {
            io.emit('order-update', { orderNumber, status: order.status, location, timestamp: new Date() });
        }
        
        res.json({ success: true, order });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Update GPS Location
router.post('/orders/update-location', authMiddleware, async (req, res) => {
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
        
        const io = req.app.get('io');
        if (io) {
            io.emit('location-update', { orderNumber, lat, lng, address });
        }
        
        res.json({ success: true, location: order.currentLocation });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Quality Check
router.post('/orders/quality-check', authMiddleware, async (req, res) => {
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
            
            const Payment = require('../models/Payment');
            await Payment.findOneAndUpdate(
                { orderId: order._id },
                { status: 'completed' }
            );
        } else {
            order.status = 'disputed';
            order.qualityIssues = issues;
        }
        
        await order.save();
        
        const io = req.app.get('io');
        if (io) {
            io.emit('quality-check-result', { orderNumber, qualityPassed, issues });
        }
        
        res.json({ success: true, order });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Resolve Dispute
router.post('/orders/:orderNumber/resolve', authMiddleware, async (req, res) => {
    try {
        const { action } = req.body;
        const order = await Order.findOne({ orderNumber: req.params.orderNumber });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        if (action === 'refund') {
            order.paymentStatus = 'refunded';
            order.status = 'disputed';
        } else if (action === 'release') {
            order.paymentStatus = 'released';
            order.status = 'completed';
        }
        
        await order.save();
        res.json({ success: true, order });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
