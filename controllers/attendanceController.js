//attendencecontroller.js
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const moment = require('moment');
const reverseGeocode = require('../utils/reverseGeocode');
const Shift = require('../models/Shift');
const mongoose = require('mongoose');

const openAttendanceFilter = (employeeId) => ({
  employee: employeeId,
  checkIn: { $exists: true, $ne: null },
  $or: [
    { checkOut: { $exists: false } },
    { checkOut: null }
  ]
});

const hasRecordedCheckout = (record) => record?.checkOut !== undefined && record?.checkOut !== null && record?.checkOut !== '';

const calculateWorkingHours = (attendance) => {
  if (!attendance?.checkIn || !attendance?.checkOut) return 0;
  const checkIn = new Date(attendance.checkIn);
  const checkOut = new Date(attendance.checkOut);
  const diffMs = checkOut.getTime() - checkIn.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Number((diffMs / (1000 * 60 * 60)).toFixed(2));
};

const normalizeAttendanceSession = (attendanceRecord) => {
  if (!attendanceRecord) return null;
  const attendance = typeof attendanceRecord.toObject === 'function'
    ? attendanceRecord.toObject()
    : attendanceRecord;

  const selectedShift = attendance.shift && typeof attendance.shift === 'object'
    ? {
        _id: attendance.shift._id,
        name: attendance.shift.displayName || attendance.shift.name || attendance.shiftName,
        displayName: attendance.shift.displayName,
        startTime: attendance.shift.startTime,
        endTime: attendance.shift.endTime,
        isNightShift: attendance.shift.isNightShift || false
      }
    : null;

  const workingHours = hasRecordedCheckout(attendance)
    ? Number(attendance.workingHours || calculateWorkingHours(attendance) || 0)
    : Number(attendance.workingHours || 0);

  return {
    ...attendance,
    workingHours,
    selectedShift,
    selectedLocation: attendance.checkInLocation || null,
    activeAttendanceId: attendance._id,
    checkInTime: attendance.checkIn
  };
};

const buildActiveAttendanceStatus = async (Attendance, Shift, employeeId) => {
  const activeAttendance = await Attendance.findOne(openAttendanceFilter(employeeId))
    .populate('shift', 'name displayName startTime endTime isNightShift')
    .sort({ checkIn: -1, createdAt: -1 });

  const now = moment();
  const todayStart = moment(now).startOf('day');
  const todayEnd = moment(now).endOf('day');
  const completedAttendances = await Attendance.find({
    employee: employeeId,
    checkIn: { $exists: true, $ne: null },
    checkOut: { $exists: true, $ne: null },
    $or: [
      { date: { $gte: todayStart.toDate(), $lte: todayEnd.toDate() } },
      { checkIn: { $gte: todayStart.toDate(), $lte: todayEnd.toDate() } },
      { checkOut: { $gte: todayStart.toDate(), $lte: todayEnd.toDate() } }
    ]
  })
    .populate('shift', 'name displayName startTime endTime isNightShift')
    .sort({ checkOut: -1, checkIn: -1, createdAt: -1 });

  const attendanceRecordsToPopulate = [
    ...(activeAttendance ? [activeAttendance] : []),
    ...completedAttendances
  ];
  const populatedRecords = await populateLocations(attendanceRecordsToPopulate);
  const populatedActiveAttendance = activeAttendance ? populatedRecords[0] : null;
  const populatedCompletedAttendances = activeAttendance ? populatedRecords.slice(1) : populatedRecords;

  const activeSession = normalizeAttendanceSession(populatedActiveAttendance);
  const todayCompletedSessions = populatedCompletedAttendances.map(normalizeAttendanceSession);
  const latestCompletedSession = todayCompletedSessions[0] || null;
  const overallTodayWorkedHours = Number(
    todayCompletedSessions.reduce((sum, session) => sum + Number(session?.workingHours || 0), 0).toFixed(2)
  );

  return {
    isCheckedIn: Boolean(activeSession),
    activeSession,
    latestCompletedSession,
    todayCompletedSessions,
    overallTodayWorkedHours,
    activeAttendanceId: activeSession?._id || null,
    checkInTime: activeSession?.checkIn || null,
    checkIn: activeSession?.checkIn || null,
    checkOut: activeSession?.checkOut || null,
    selectedShift: activeSession?.selectedShift || null,
    selectedLocation: activeSession?.selectedLocation || null,
    status: activeSession ? 'working' : (latestCompletedSession ? 'completed' : 'pending'),
    attendance: activeSession || latestCompletedSession || null
  };
};

// @desc    Get current active attendance session
// @route   GET /api/attendance/status
// @access  Private
exports.getAttendanceStatus = async (req, res) => {
  try {
    const { Attendance, Shift } = req.models;
    const employeeId = req.user?.employee?._id || req.user?.employee;

    if (!employeeId) {
      return res.status(400).json({ message: 'Employee profile not found' });
    }

    const status = await buildActiveAttendanceStatus(Attendance, Shift, employeeId);
    res.json(status);
  } catch (error) {
    console.error('Get attendance status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.checkIn = async (req, res) => {
  try {
    const { Attendance, Employee, Shift } = req.models;
    const employeeId = req.user?.employee?._id || req.user?.employee;

    if (!employeeId) {
      return res.status(400).json({ message: 'Employee profile not found' });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    let targetShift = null;
    if (req.body.shiftId) {
      if (!mongoose.isValidObjectId(req.body.shiftId)) {
        return res.status(400).json({ message: 'Please select a valid shift' });
      }

      targetShift = await Shift.findOne({
        _id: req.body.shiftId,
        tenant: req.tenant._id,
        isActive: true
      });

      if (!targetShift) {
        return res.status(404).json({ message: 'Shift not found' });
      }
    }

    const activeAttendance = await Attendance.findOne(openAttendanceFilter(employeeId))
      .sort({ checkIn: -1, createdAt: -1 });

    if (activeAttendance) {
      return res.status(400).json({
        message: 'Please check out from your current attendance before checking in again.'
      });
    }

    const attendanceData = {
      employee: employeeId,
      date: new Date(),
      checkIn: new Date(),
      shift: targetShift?._id || null,
      shiftSource: targetShift ? 'requested' : null,
      shiftName: targetShift ? targetShift.displayName : null,
      status: 'present'
    };

    if (req.body.checkInLat !== undefined && req.body.checkInLat !== null) {
      const latitude = Number(req.body.checkInLat);
      const longitude = Number(req.body.checkInLng);
      const accuracy = Number(req.body.checkInAccuracy);

      if (Number.isFinite(latitude)) attendanceData.checkInLat = latitude;
      if (Number.isFinite(longitude)) attendanceData.checkInLng = longitude;
      if (Number.isFinite(accuracy)) attendanceData.checkInAccuracy = accuracy;
    }
    if (req.body.checkInPlace) {
      attendanceData.checkInPlace = String(req.body.checkInPlace);
    }
    if (req.body.checkInLocation) {
      attendanceData.checkInLocation = req.body.checkInLocation;
    }

    const attendance = await Attendance.create(attendanceData);

    res.status(201).json({
      success: true,
      data: attendance,
      shiftInfo: targetShift ? {
        name: targetShift.displayName,
        startTime: targetShift.startTime,
        endTime: targetShift.endTime
      } : null
    });
  } catch (error) {
    console.error('Check in error:', error);
    if (error.name === 'ValidationError' || error.name === 'CastError' || error.code === 11000) {
      return res.status(400).json({
        message: error.code === 11000
          ? 'Attendance could not be recorded because an old unique attendance index is still active.'
          : error.message
      });
    }
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};


// @desc    Check out employee (with shift validation)
// @route   POST /api/attendance/checkout
// @access  Private
exports.checkOut = async (req, res) => {
  try {
    const { Attendance, Employee, Shift, DepartmentSetting } = req.models;

    // Get employee with shift
    const employee = await Employee.findById(req.user.employee._id);

    // Find the latest unfinished check-in, including night shifts that crossed midnight.
    const requestedAttendanceId = req.body?.attendanceId || req.body?.activeAttendanceId;
    const attendanceQuery = requestedAttendanceId && mongoose.isValidObjectId(requestedAttendanceId)
      ? { _id: requestedAttendanceId, employee: req.user.employee._id }
      : openAttendanceFilter(req.user.employee._id);

    const attendance = await Attendance.findOne(attendanceQuery)
      .sort({ checkIn: -1, createdAt: -1 }); // Get latest active check-in

    if (!attendance) {
      return res.status(400).json({ message: "No active check-in found. Please check in first." });
    }

    // Get the shift associated with this attendance
    let targetShift = null;
    if (attendance.shift) {
      targetShift = await Shift.findById(attendance.shift);
    }
    
    // Fallback/Validation shift result for legacy or other checks
    let shiftResult = { shift: targetShift, source: attendance.shiftSource || 'attendance' };

    if (attendance.checkOut) {
      return res.status(400).json({ message: 'Already checked out for today' });
    }

    let validationResult = { canCheckOut: true, message: 'No shift restrictions' };

    // Accept location payload for checkout
    const { checkOutLat, checkOutLng, checkOutAccuracy, checkOutPlace, checkOutLocation } = req.body || {};

    attendance.checkOut = new Date();
    if (checkOutLat !== undefined) attendance.checkOutLat = Number(checkOutLat);
    if (checkOutLng !== undefined) attendance.checkOutLng = Number(checkOutLng);
    if (checkOutAccuracy !== undefined) attendance.checkOutAccuracy = Number(checkOutAccuracy);
    if (checkOutPlace) attendance.checkOutPlace = String(checkOutPlace);
    if (checkOutLocation) attendance.checkOutLocation = checkOutLocation;

    attendance.isEarlyCheckOut = false;
    attendance.checkOutStatus = null;

    // After getting employee, add this check
    // const deptSetting = await DepartmentSetting.findOne({
    //   tenant: req.tenant._id,
    //   departmentName: employee.department
    // });

    //const isShiftRequired = deptSetting ? deptSetting.shiftRequired : false;

    await attendance.save();

    const shouldResolveCheckOutPlace = (
      attendance.checkOutLat != null
      && attendance.checkOutLng != null
      && !attendance.checkOutPlace
    );
    const attendanceId = attendance._id;
    const checkOutLatForPlace = attendance.checkOutLat;
    const checkOutLngForPlace = attendance.checkOutLng;
    const AttendanceModel = attendance.constructor;

    res.json({
      ...attendance.toObject(),
      shiftInfo: shiftResult.shift ? {
        name: shiftResult.shift.displayName,
        startTime: shiftResult.shift.startTime,
        endTime: shiftResult.shift.endTime,
        source: shiftResult.source,
        checkOutStatus: validationResult.status
      } : null
    });

    if (shouldResolveCheckOutPlace) {
      setImmediate(async () => {
        try {
          const place = await reverseGeocode(checkOutLatForPlace, checkOutLngForPlace);
          if (place) {
            await AttendanceModel.updateOne(
              { _id: attendanceId, checkOutPlace: { $exists: false } },
              { $set: { checkOutPlace: place } }
            );
          }
        } catch (err) {
          console.warn('Reverse geocode error (check-out):', err && err.message ? err.message : err);
        }
      });
    }
  } catch (error) {
    console.error('Check out error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Helper to manually populate checkInLocation and checkOutLocation from SuperAdmin DB
const populateLocations = async (attendanceRecords) => {
  if (!attendanceRecords || attendanceRecords.length === 0) return attendanceRecords;

  try {
    const { getSuperAdminModels } = require('../config/db');
    const { Location } = getSuperAdminModels();

    // Extract all unique location ObjectIds
    const locationIds = new Set();
    attendanceRecords.forEach(record => {
      if (record.checkInLocation) locationIds.add(record.checkInLocation.toString());
      if (record.checkOutLocation) locationIds.add(record.checkOutLocation.toString());
    });

    if (locationIds.size === 0) return attendanceRecords;

    // Fetch locations from super-admin DB
    const locations = await Location.find({
      _id: { $in: Array.from(locationIds) }
    }).select('name address');

    const locationMap = locations.reduce((map, loc) => {
      map[loc._id.toString()] = loc;
      return map;
    }, {});

    // Map location details to the attendance records
    return attendanceRecords.map(record => {
      const recordObj = typeof record.toObject === 'function' ? record.toObject() : record;
      if (record.checkInLocation) {
        recordObj.checkInLocation = locationMap[record.checkInLocation.toString()] || { _id: record.checkInLocation };
      }
      if (record.checkOutLocation) {
        recordObj.checkOutLocation = locationMap[record.checkOutLocation.toString()] || { _id: record.checkOutLocation };
      }
      return recordObj;
    });
  } catch (error) {
    console.error('Error manually populating locations:', error);
    return attendanceRecords;
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
      $or: [
        { date: { $gte: startDate, $lte: endDate } },
        {
          checkIn: { $exists: true, $ne: null },
          $or: [
            { checkOut: { $exists: false } },
            { checkOut: null }
          ]
        }
      ]
    })
      .sort({ date: -1 });

    const populatedAttendance = await populateLocations(attendance);

    res.json(populatedAttendance);
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
      $or: [
        { date: { $gte: startDate, $lte: endDate } },
        {
          checkIn: { $exists: true, $ne: null },
          $or: [
            { checkOut: { $exists: false } },
            { checkOut: null }
          ]
        }
      ]
    };

    if (employeeId) {
      filter.employee = employeeId;
    }

    const attendance = await Attendance.find(filter)
      .populate('employee', 'name email department position')
      .populate('shift', 'name displayName startTime endTime isNightShift')
      .sort({ date: -1 });

    const populatedAttendance = await populateLocations(attendance);

    res.json(populatedAttendance);
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
// Helper: Get employee with shift info
const getEmployeeWithShift = async (req, Employee) => {
  const employee = await Employee.findById(req.user.employee._id);
  return employee;
};

// Helper: Record attendance with shift info
const createAttendanceWithShift = async (req, Attendance, employee, shiftResult, checkInTime, locationData) => {
  const attendanceData = {
    employee: req.user.employee._id,
    date: new Date(),
    checkIn: checkInTime,
    shift: shiftResult.shift ? shiftResult.shift._id : null,
    shiftSource: shiftResult.source,
    shiftName: shiftResult.shift ? shiftResult.shift.displayName : null,
    isLateCheckIn: shiftResult.isLate || false,
    checkInStatus: shiftResult.status || null
  };

  // Add location data if provided
  if (locationData) {
    if (locationData.lat !== undefined) attendanceData.checkInLat = Number(locationData.lat);
    if (locationData.lng !== undefined) attendanceData.checkInLng = Number(locationData.lng);
    if (locationData.accuracy !== undefined) attendanceData.checkInAccuracy = Number(locationData.accuracy);
    if (locationData.place) attendanceData.checkInPlace = String(locationData.place);
  }

  return await Attendance.create(attendanceData);
};


// @desc    Get today's shifts with check-in/out status
// @route   GET /api/attendance/today-shifts
// @access  Private
exports.getTodayShiftsStatus = async (req, res) => {
  try {
    const { Attendance, Employee, Shift } = req.models;
    const today = moment().startOf('day');
    const yesterday = moment(today).subtract(1, 'day');
    const now = new Date();

    const employee = await Employee.findById(req.user.employee._id);
    
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    
    // Get today's records plus any unfinished check-in from a previous day.
    const todayAttendances = await Attendance.find({
      employee: req.user.employee._id,
      $or: [
        {
          date: {
            $gte: yesterday.toDate(),
            $lte: moment(today).endOf('day').toDate()
          }
        },
        {
          checkIn: { $exists: true },
          $or: [
            { checkOut: { $exists: false } },
            { checkOut: null }
          ]
        }
      ]
    });

    // Employees manually select from all active tenant shifts.
    let applicableShifts = await Shift.find({
      tenant: req.tenant._id,
      isActive: true
    }).sort({ startTime: 1 });

    // IMPORTANT: union with shifts referenced by today's attendance.
    // This guarantees the dashboard reflects a successful check-in
    // even if shift assignment filtering doesn't match the employee's record fields.
    const attendanceShiftIds = new Set(
      todayAttendances
        .map(a => a.shift)
        .filter(Boolean)
        .map(s => s.toString())
    );

    if (attendanceShiftIds.size > 0) {
      const shiftsFromAttendance = await Shift.find({
        tenant: req.tenant._id,
        isActive: true,
        _id: { $in: Array.from(attendanceShiftIds) }
      });

      const byId = new Map();
      [...applicableShifts, ...shiftsFromAttendance].forEach(s => byId.set(s._id.toString(), s));
      applicableShifts = Array.from(byId.values()).sort({ startTime: 1 });
    }


    console.log('Today attendances found:', todayAttendances.length);
    todayAttendances.forEach(att => {
      console.log(`- Shift: ${att.shiftName}, CheckIn: ${!!att.checkIn}, CheckOut: ${!!att.checkOut}`);
    });

    const hasRecordedCheckout = (record) => record?.checkOut !== undefined && record?.checkOut !== null && record?.checkOut !== '';
    const activeAttendance = todayAttendances
      .filter(att => att.checkIn && !hasRecordedCheckout(att))
      .sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn))[0] || null;

    // Build shift statuses - EACH SHIFT INDEPENDENTLY
    const shiftsWithStatus = applicableShifts.map(shift => {
      const attendance = activeAttendance?.shift?.toString() === shift._id.toString() ? activeAttendance : null;
      const status = attendance ? 'checked_in' : 'pending';
      
      return {
        _id: shift._id,
        name: shift.displayName,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isNightShift: shift.isNightShift || false,
        status: status,
        checkIn: attendance?.checkIn,
        checkOut: attendance?.checkOut,
        canCheckIn: !activeAttendance && status === 'pending',
        canCheckOut: status === 'checked_in',
        checkInWindow: { canCheckIn: !activeAttendance, message: 'No shift time restrictions' },
        workingHours: attendance?.workingHours
      };
    });

    // Find active shift (checked in but not out)
    const activeShift = shiftsWithStatus.find(s => s.status === 'checked_in');
    
    // Find next pending shift that can be checked in
    const nextShift = shiftsWithStatus.find(s => s.status === 'pending' && s.canCheckIn);

    console.log('Shift statuses:', shiftsWithStatus.map(s => ({ name: s.name, status: s.status, canCheckIn: s.canCheckIn })));
    console.log('Active shift:', activeShift?.name);
    console.log('Next shift:', nextShift?.name);

    res.json({
      success: true,
      data: {
        shifts: shiftsWithStatus,
        activeShift,
        nextShift,
        hasMoreShifts: shiftsWithStatus.some(s => s.status === 'pending'),
        totalShifts: shiftsWithStatus.length,
        completedShifts: shiftsWithStatus.filter(s => s.status === 'completed').length
      }
    });
  } catch (error) {
    console.error('Get today shifts status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
