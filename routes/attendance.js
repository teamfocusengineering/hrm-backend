const express = require('express');
const {
  checkIn,
  checkOut,
  getMyAttendance,
  getAllAttendance,
  getAttendanceSummary,
  getAttendanceWithPermissions
} = require('../controllers/attendanceController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.post('/checkin', checkIn);
router.post('/checkout', checkOut);
router.get('/my-attendance', getMyAttendance);
router.get('/', authorize('admin'), getAllAttendance);
router.get('/summary', authorize('admin'), getAttendanceSummary);
router.get('/with-permissions', getAttendanceWithPermissions);

module.exports = router;