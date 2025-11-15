const express = require('express');
const {
  applyForPermission,
  getMyPermissions,
  getAllPermissions,
  updatePermissionStatus,
  getPermissionStats
} = require('../controllers/permissionController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.post('/', applyForPermission);
router.get('/my-permissions', getMyPermissions);
router.get('/stats', getPermissionStats);
router.get('/', authorize('admin'), getAllPermissions);
router.put('/:id/status', authorize('admin'), updatePermissionStatus);

module.exports = router;