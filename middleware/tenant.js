const {
  connectTenantDB,
  getTenantModels,
  getSuperAdminModels
} = require('../config/db');

// Detect tenant from subdomain / headers / query
exports.detectTenant = async (req, res, next) => {
  try {
    // ✅ Skip tenant detection for super-admin routes
    if (req.originalUrl.startsWith('/api/super-admin')) {
      return next();
    }

    let tenantId = req.headers['x-tenant-id'] || req.headers['x-tenant'];

    let subdomain =
      req.headers['x-tenant-subdomain'] ||
      req.headers['x-tenant'];

    // ✅ Query support
    if (!tenantId && req.query?.tenant) {
      tenantId = req.query.tenant;
    }

    // ✅ Extract from hostname
    if (!tenantId && !subdomain) {
      let hostname = (
        req.hostname ||
        (req.get('host') || '').split(':')[0] ||
        ''
      ).toLowerCase();

      if (!hostname) return next();

      let BASE_DOMAIN = process.env.BASE_DOMAIN || 'hrm-saas.vercel.app';
      BASE_DOMAIN = BASE_DOMAIN.toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .split(':')[0]
        .replace(/^www\./, '');

      const parts = hostname.split('.');
      const baseParts = BASE_DOMAIN.split('.');

      if (hostname === 'localhost' || parts.length === 1) return next();
      if (hostname === BASE_DOMAIN) return next();

      if (
        hostname.endsWith('.' + BASE_DOMAIN) &&
        parts.length > baseParts.length
      ) {
        subdomain = parts[0];
      }
    }

    // ✅ Resolve tenant
    if (subdomain || tenantId) {
      const { Tenant } = getSuperAdminModels();

      let tenant;

      try {
        tenant = await Tenant.findOne({
          $or: [
            { subdomain: String(subdomain).toLowerCase() },
            { _id: tenantId }
          ],
          isActive: true
        });
      } catch (e) {
        tenant = await Tenant.findOne({
          subdomain: String(subdomain).toLowerCase(),
          isActive: true
        });
      }

      if (!tenant) {
        console.warn(
          `⚠️ Tenant not found or inactive: ${subdomain || tenantId}`
        );

        req.tenant = undefined;
        return next();
      }

      // ✅ Attach tenant info
      req.tenant = tenant;
      req.tenantId = tenant._id;
      req.tenantSubdomain = tenant.subdomain;

      // ✅ Connect DB
      const tenantConnection = await connectTenantDB(
        tenant._id.toString(),
        tenant.companyName
      );

      req.tenantDB = tenantConnection;

      // ✅ Load models
      let models;
      try {
        models = await getTenantModels(tenantConnection);
      } catch (e) {
        console.error('❌ getTenantModels failed:', e);
        return res.status(500).json({
          message: 'Failed to initialize tenant models'
        });
      }

      // 🔥 CRITICAL FIX: Ensure User is MODEL (not schema)
      if (
        !models ||
        !models.User ||
        typeof models.User.findOne !== 'function'
      ) {
        console.error(`❌ Invalid User model detected. Attempting recovery...`);

        try {
          const userSchema = require('../models/userModel');

          models.User =
            tenantConnection.models.User ||
            tenantConnection.model('User', userSchema);

          console.log('✅ Recovered User model dynamically');
        } catch (err) {
          console.error('❌ Recovery failed:', err.message);

          return res.status(500).json({
            message: 'Tenant model initialization failed (User model)'
          });
        }
      }

      // ✅ Final assignment
      req.models = models;

      console.log(`🔗 Connected: ${tenant.companyName}`);
    }

    next();
  } catch (error) {
    console.error('❌ Tenant detection error:', error);
    res.status(500).json({ message: 'Tenant detection failed' });
  }
};

// ✅ Require tenant middleware
exports.requireTenant = (req, res, next) => {
  if (!req.tenant) {
    return res.status(400).json({
      message: 'Company context required'
    });
  }
  next();
};
