//attendance routes
const express = require('express');
const {
  checkIn,
  checkOut,
  getMyAttendance,
  getAllAttendance,
  getAttendanceSummary,
  getAttendanceWithPermissions,
  getAttendanceStatus,
  getTodayShiftsStatus,
  updateAttendanceTime
} = require('../controllers/attendanceController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.post('/checkin', checkIn);
router.post('/checkout', checkOut);
router.get('/status', getAttendanceStatus);
router.get('/my-attendance', getMyAttendance);
router.get('/today-shifts', getTodayShiftsStatus);
router.get('/', authorize('admin'), getAllAttendance);
router.put('/:id/time', authorize('admin'), updateAttendanceTime);
router.get('/summary', authorize('admin'), getAttendanceSummary);
router.get('/with-permissions', getAttendanceWithPermissions);

module.exports = router;
