import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet'; // ✅ ADD THIS
import compression from 'compression'; // ✅ ADD THIS
import connectDB from './config/db.js';
import cookieParser from 'cookie-parser';
import http from 'http';

// Import all your routes
import orthancRoutes from './routes/orthanc.routes.js';
import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import labRoutesEdit from './routes/labEdit.routes.js'; 
import lab from './routes/lab.routes.js';
import doctorRotues from './routes/doctor.routes.js';
import documentRoutes from './routes/document.routes.js'
import studyDownloadRoutes from './routes/study.download.routes.js';
import changePasswordRoutes from './routes/changePassword.routes.js';
import forgotPasswordRoutes from './routes/forgotPassword.routes.js';
import reportRoutes from './routes/TAT.routes.js'
import discussionRoutes from './routes/discussion.routes.js';
import footer from './routes/footer.routes.js'
import websocketService from './config/webSocket.js';
// import radiantBridgeRoutes from './routes/radiantBridgeRoutes.js'; 
import sharingRoutes from './routes/sharing.routes.js';
import zipdownloadRoutes from './routes/zipdownload.route.js';
import tatRoutes from './routes/TAT.routes.js';
import htmlTemplateRoutes from './routes/htmlTemplate.routes.js';



// import orthancProaxyRoutes from './routes/orthanc.proxy.routes.js'



dotenv.config();

// Connect to MongoDB
connectDB();

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// 🔧 PRODUCTION SECURITY MIDDLEWARE
// ✅ 1. HELMET - Security headers
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false, // Disable for file downloads
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin requests
}));

// ✅ 2. COMPRESSION - Gzip compression
app.use(compression({
    filter: (req, res) => {
        // Don't compress if the request includes a cache-control no-transform directive
        if (req.headers['cache-control'] && req.headers['cache-control'].includes('no-transform')) {
            return false;
        }
        // Use compression filter
        return compression.filter(req, res);
    },
    level: 6, // Compression level (1-9, 6 is default)
    threshold: 1024 // Only compress if response is larger than 1KB
}));

// ✅ 3. PRODUCTION CORS - Fixed configuration
const allowedOrigins = process.env.NODE_ENV === 'production' 
    ? [
        'http://64.227.187.164',        // ✅ CHANGE from 157.245.86.199
        'https://64.227.187.164',       // ✅ HTTPS version
        process.env.FRONTEND_URL,       // ✅ Environment variable fallback
        'http://localhost',             // ✅ Local testing
        'https://localhost',   
        'http://portal.xcentic.in',     // ✅ ADD THIS
        'https://portal.xcentic.in',
        'https://ai.starradiology.com',
                'http://ai.starradiology.com',
                'http://206.189.139.34'

               // ✅ Local HTTPS testing
      ]
    : [
        'http://localhost:3000',
        'http://localhost:3001', 
        'http://localhost:5173', // Vite dev server
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
        'http://64.227.187.164',        // ✅ CHANGE from 157.245.86.199
        'https://64.227.187.164',
        'http://portal.xcentic.in',     // ✅ ADD THIS
        'https://portal.xcentic.in',
        'http://ai.starradiology.com',
                'https://ai.starradiology.com',
                'http://206.189.139.34'

      ];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes(origin)) {
            console.log(`✅ CORS allowed origin: ${origin}`);
            callback(null, true);
        } else {
            console.warn(`🚨 CORS blocked origin: ${origin}`);
            callback(new Error(`Not allowed by CORS: ${origin}`));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Content-Type', 
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Origin',
        'Cache-Control'
    ],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400
}));

// ✅ 4. SECURITY MIDDLEWARE
app.use(express.text());
app.use(express.json({ 
    limit: '100mb', // Increased for medical images..
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ 
    extended: true, 
    limit: '100mb'
}));
app.use(cookieParser());

// ✅ 5. SECURITY HEADERS
app.use((req, res, next) => {
    // Remove server fingerprinting
    res.removeHeader('X-Powered-By');
    
    // Add custom security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // HSTS in production
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
    
    next();
});

// ✅ 6. HEALTH CHECK ENDPOINTS
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        env: process.env.NODE_ENV || 'development',
        version: process.env.npm_package_version || '1.0.0'
    });
});

app.get('/ready', async (req, res) => {
    try {
        // Add your readiness checks here
        res.status(200).json({ 
            status: 'ready',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({ 
            status: 'not ready', 
            error: error.message 
        });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'DICOM Workflow API is running!',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString()
    });
});

// ✅ 7. MOUNT ROUTES
app.use('/api/orthanc', orthancRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/labEdit', labRoutesEdit);
app.use('/api/lab', lab);
app.use('/api/doctor', doctorRotues);
app.use('/api/documents', documentRoutes);
app.use('/api/orthanc-download', studyDownloadRoutes);
app.use('/api/auth', changePasswordRoutes);
app.use('/api/forgot-password', forgotPasswordRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api', discussionRoutes);
app.use('/api/footer', footer);
// app.use('/api/radiant', radiantBridgeRoutes); 
app.use('/api/sharing', sharingRoutes);
app.use('/api/download', zipdownloadRoutes)
app.use('/api/tat', tatRoutes)
app.use('/api/html-templates', htmlTemplateRoutes);


// app.use('/api/orthanc-proxy', orthancProaxyRoutes);


// ✅ 8. ERROR HANDLING MIDDLEWARE
app.use((req, res, next) => {
    res.status(404).json({
        success: false,
        message: `Route ${req.originalUrl} not found`,
        timestamp: new Date().toISOString()
    });
});

app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    
    // Don't leak error details in production
    const errorMessage = process.env.NODE_ENV === 'production' 
        ? 'Internal server error' 
        : err.message;
    
    const statusCode = err.statusCode || 500;
    
    res.status(statusCode).json({
        success: false,
        message: errorMessage,
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
        timestamp: new Date().toISOString()
    });
});

// ✅ 9. INITIALIZE WEBSOCKETS
websocketService.initialize(server);

// ✅ 10. GRACEFUL SHUTDOWN
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

// ✅ 11. START SERVER
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 WebSocket available at ws://localhost:${PORT}/ws/admin`);
    console.log(`🏥 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔒 Security: Helmet + Compression enabled`);
    console.log(`🌐 CORS: ${process.env.NODE_ENV === 'production' ? 'Production' : 'Development'} mode`);
});



