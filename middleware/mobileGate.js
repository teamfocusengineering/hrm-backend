const jwt = require('jsonwebtoken');
const DefaultUser = require('../models/User');

// Simple mobile UA check
const isMobileUA = (ua = '') => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);

// Hosts/origins used by tenant-app (if request comes from one of these origins, enforce mobile gate)
const TENANT_APP_ORIGINS = [
  'hrm.focusengineeringapp.com',
  'localhost:5173',
  'localhost:5174',
  'localhost:5175'
];

module.exports = async function mobileGate(req, res, next) {
  try {
    // Only enforce when request appears to come from tenant-app origins (if no origin header, skip enforcement)
    const origin = req.get('origin');
    if (!origin) return next();

    const matchesTenantApp = TENANT_APP_ORIGINS.some(h => origin.includes(h));
    if (!matchesTenantApp) return next();

    // Skip super-admin APIs
    if (req.originalUrl && req.originalUrl.startsWith('/api/super-admin')) return next();

    // If not a mobile UA, do nothing
    const ua = req.headers['user-agent'] || '';
    if (!isMobileUA(ua)) return next();

    // If no auth token present, allow request to proceed (login/public flows should continue)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

    const token = authHeader.split(' ')[1];
    if (!token) return next();

    // Decode token to get user id; then load user from tenant-aware models if available
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      // If token invalid, let auth middleware handle it later — don't block here
      return next();
    }

    // Resolve user model from req.models (tenant-aware) or default
    const UserModel = (req.models && req.models.User) ? req.models.User : DefaultUser;

    const user = await UserModel.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'User not found' });

    // Admins always allowed; otherwise require explicit mobileAllowed flag
    if (user.role === 'admin' || user.mobileAllowed === true) {
      return next();
    }

    // Block access for mobile
    return res.status(403).json({ message: 'Mobile access is not allowed for your account. Please use desktop or contact your administrator.' });
  } catch (err) {
    console.error('mobileGate error:', err);
    // Fail-open: do not prevent requests if mobileGate fails unexpectedly
    return next();
  }
};
