const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const moment = require('moment');
const reverseGeocode = require('../utils/reverseGeocode');

// @desc    Check in employee
// @route   POST /api/attendance/checkin
// @access  Private
exports.checkIn = async (req, res) => {
  try {
    const { Attendance } = req.models;
    const today = moment().startOf('day');
    
    // Check if already checked in today
    const existingAttendance = await Attendance.findOne({
      employee: req.user.employee._id,
      date: {
        $gte: today.toDate(),
        $lte: moment(today).endOf('day').toDate()
      }
    });

    if (existingAttendance) {
      return res.status(400).json({ message: 'Already checked in for today' });
    }

    // Accept optional location payload from the client (checkInLat/checkInLng/checkInAccuracy/checkInPlace)
    const { checkInLat, checkInLng, checkInAccuracy, checkInPlace } = req.body || {};

    const attendanceData = {
      employee: req.user.employee._id,
      date: new Date(),
      checkIn: new Date()
    };

    if (checkInLat !== undefined) attendanceData.checkInLat = Number(checkInLat);
    if (checkInLng !== undefined) attendanceData.checkInLng = Number(checkInLng);
    if (checkInAccuracy !== undefined) attendanceData.checkInAccuracy = Number(checkInAccuracy);
    if (checkInPlace) attendanceData.checkInPlace = String(checkInPlace);

    // If coords provided but no human-readable place, attempt reverse geocoding (best-effort)
    if ((attendanceData.checkInLat != null && attendanceData.checkInLng != null) && !attendanceData.checkInPlace) {
      try {
        const place = await reverseGeocode(attendanceData.checkInLat, attendanceData.checkInLng);
        if (place) attendanceData.checkInPlace = place;
      } catch (err) {
        // ignore reverse geocode failures
        console.warn('Reverse geocode error (check-in):', err && err.message ? err.message : err);
      }
    }

    const attendance = await Attendance.create(attendanceData);

    res.status(201).json(attendance);
  } catch (error) {
    console.error('Check in error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Check out employee
// @route   POST /api/attendance/checkout
// @access  Private
exports.checkOut = async (req, res) => {
  try {
    const { Attendance } = req.models;
    const today = moment().startOf('day');
    
    const attendance = await Attendance.findOne({
      employee: req.user.employee._id,
      date: {
        $gte: today.toDate(),
        $lte: moment(today).endOf('day').toDate()
      }
    });

    if (!attendance) {
      return res.status(400).json({ message: 'No check-in found for today' });
    }

    if (attendance.checkOut) {
      return res.status(400).json({ message: 'Already checked out for today' });
    }

    // Accept optional location payload for checkout
    const { checkOutLat, checkOutLng, checkOutAccuracy, checkOutPlace } = req.body || {};

    attendance.checkOut = new Date();
    if (checkOutLat !== undefined) attendance.checkOutLat = Number(checkOutLat);
    if (checkOutLng !== undefined) attendance.checkOutLng = Number(checkOutLng);
    if (checkOutAccuracy !== undefined) attendance.checkOutAccuracy = Number(checkOutAccuracy);
    if (checkOutPlace) attendance.checkOutPlace = String(checkOutPlace);

    // If checkout coords provided but no place, attempt reverse geocoding
    if ((attendance.checkOutLat != null && attendance.checkOutLng != null) && !attendance.checkOutPlace) {
      try {
        const place = await reverseGeocode(attendance.checkOutLat, attendance.checkOutLng);
        if (place) attendance.checkOutPlace = place;
      } catch (err) {
        console.warn('Reverse geocode error (check-out):', err && err.message ? err.message : err);
      }
    }

    await attendance.save();

    res.json(attendance);
  } catch (error) {
    console.error('Check out error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get employee's attendance
// @route   GET /api/attendance/my-attendance
// @access  Private
exports.getMyAttendance = async (req, res) => {
  try {
    const { Attendance } = req.models;
    const { month, year } = req.query;
    let startDate, endDate;

    if (month && year) {
      startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
    } else {
      // Default to current month
      startDate = moment().startOf('month').toDate();
      endDate = moment().endOf('month').toDate();
    }

    const attendance = await Attendance.find({
      employee: req.user.employee._id,
      date: { $gte: startDate, $lte: endDate }
    }).sort({ date: -1 });

    res.json(attendance);
  } catch (error) {
    console.error('Get my attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get all attendance (Admin)
// @route   GET /api/attendance
// @access  Private/Admin
exports.getAllAttendance = async (req, res) => {
  try {
    const { Attendance, Employee } = req.models;
    const { month, year, employeeId } = req.query;
    let startDate, endDate;

    if (month && year) {
      startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
    } else {
      startDate = moment().startOf('month').toDate();
      endDate = moment().endOf('month').toDate();
    }

    let filter = {
      date: { $gte: startDate, $lte: endDate }
    };

    if (employeeId) {
      filter.employee = employeeId;
    }

    const attendance = await Attendance.find(filter)
      .populate('employee', 'name email department position')
      .sort({ date: -1 });

    res.json(attendance);
  } catch (error) {
    console.error('Get all attendance error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get attendance summary
// @route   GET /api/attendance/summary
// @access  Private/Admin
exports.getAttendanceSummary = async (req, res) => {
  try {
    const { Attendance } = req.models;
    const { month, year } = req.query;
    const startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
    const endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();

    const summary = await Attendance.aggregate([
      {
        $match: {
          date: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$employee',
          totalPresent: {
            $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] }
          },
          totalHalfDay: {
            $sum: { $cond: [{ $eq: ['$status', 'half-day'] }, 1, 0] }
          },
          totalWorkingHours: { $sum: '$workingHours' }
        }
      },
      {
        $lookup: {
          from: 'employees',
          localField: '_id',
          foreignField: '_id',
          as: 'employee'
        }
      },
      {
        $unwind: '$employee'
      },
      {
        $project: {
          'employee.name': 1,
          'employee.email': 1,
          'employee.department': 1,
          totalPresent: 1,
          totalHalfDay: 1,
          totalWorkingHours: 1
        }
      }
    ]);

    res.json(summary);
  } catch (error) {
    console.error('Get attendance summary error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get attendance with permissions
// @route   GET /api/attendance/with-permissions
// @access  Private
exports.getAttendanceWithPermissions = async (req, res) => {
  try {
    const { month, year } = req.query;
    let startDate, endDate;

    if (month && year) {
      startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
    } else {
      startDate = moment().startOf('month').toDate();
      endDate = moment().endOf('month').toDate();
    }

    const attendance = await Attendance.find({
      employee: req.user.employee._id,
      date: { $gte: startDate, $lte: endDate }
    })
    .populate('permissions.permission')
    .sort({ date: -1 });

    res.json(attendance);
  } catch (error) {
    console.error('Get attendance with permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};