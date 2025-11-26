const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { connectMainDB, checkDatabaseHealth } = require('./config/db');
const { detectTenant } = require('./middleware/tenant');

// Start server only after main DB is connected so models are registered on the correct connection
const startServer = async () => {
  try {
    await connectMainDB();
  } catch (err) {
    console.error('Failed to connect to main DB on startup:', err);
    process.exit(1);
  }

  const app = express();

  app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      express.json()(req, res, next);
    } else {
      next();
    }
  });

  // Middleware
  // CORS configuration for multi-tenant
  app.use(cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        'https://kb-hrs-software.vercel.app',
        'https://hrm.focusengineeringapp.com',
        'https://hrm-superadmin.focusengineeringapp.com',
        'https://hrm-superadmin.vercel.app',
        'https://hrm-tenant.pages.dev',
        'https://hrm-super-admin.pages.dev',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175'
      ];
      
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      // Check if origin matches any allowed pattern
      if (allowedOrigins.some(allowed => origin === allowed || origin.endsWith('.hrm-saas.vercel.app'))) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }));

  app.use(express.json());

  // Development request logger to aid debugging
  if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
      console.log(`➡️  ${req.method} ${req.originalUrl} | Host: ${req.get('host')} | Origin: ${req.get('origin') || 'N/A'} | Tenant header: ${req.headers['x-tenant'] || req.headers['x-tenant-id'] || 'N/A'}`);
      next();
    });
  }

  // Tenant detection middleware for all routes
  app.use(detectTenant);

  // Public routes (no tenant required)
  app.use('/api/super-admin', require('./routes/super-admin'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/employees', require('./routes/employees'));
  app.use('/api/attendance', require('./routes/attendance'));
  app.use('/api/leaves', require('./routes/leaves'));
  app.use('/api/payroll', require('./routes/payroll'));
  app.use('/api/dashboard', require('./routes/dashboard'));
  app.use('/api/company', require('./routes/company'));
  app.use('/api/permissions', require('./routes/permissions'));
  // Add these with your other app.use routes
  app.use('/api/projects', require('./routes/projects'));
  // Mount task progress routes before generic task routes to ensure
  // more specific endpoints (like /my-updates/today) are matched first.
  app.use('/api/tasks', require('./routes/taskProgress'));
  app.use('/api/tasks', require('./routes/tasks'));
  app.use('/api/notifications', require('./routes/notifications'));

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      tenant: req.tenant ? req.tenant.subdomain : 'main'
    });
  });

  // Error handling middleware
  app.use((err, req, res, next) => {
    // In development include the error message/stack to aid debugging
    console.error('Unhandled error middleware caught:', err && err.stack ? err.stack : err);
    const payload = { message: 'Something went wrong!' };
    if (process.env.NODE_ENV === 'development') {
      payload.error = err && err.message ? err.message : String(err);
      payload.stack = err && err.stack ? err.stack : undefined;
    }
    res.status(500).json(payload);
  });

  // 404 handler
  app.use('', (req, res) => {
    res.status(404).json({ message: 'Route not found' });
  });

  const PORT = process.env.PORT || 5000;

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Multi-tenant HRM SaaS ready`);
  });
};

startServer();

// Global handlers for unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason && reason.stack ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err && err.stack ? err.stack : err);
  // optional: process.exit(1) if you want to crash on uncaught exceptions
});