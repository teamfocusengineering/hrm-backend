//attendencecontroller.js
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const moment = require('moment');
const reverseGeocode = require('../utils/reverseGeocode');
const Shift = require('../models/Shift');
const mongoose = require('mongoose');


exports.checkIn = async (req, res) => {
  try {
    const { Attendance, Employee, Shift } = req.models;
    const today = moment().startOf('day');
    const employeeId = req.user?.employee?._id || req.user?.employee;

    if (!employeeId) {
      return res.status(400).json({ message: 'Employee profile not found' });
    }

    // Get employee details
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Determine which shift to check into
    let targetShift = null;
    let shiftSource = null;
    
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

      const directEmployeeIds = (targetShift.assignedEmployees || []).map(id => id.toString());
      const isAssigned = (
        directEmployeeIds.includes(employee._id.toString()) ||
        (targetShift.assignedDepartments || []).includes(employee.department) ||
        (targetShift.assignedRoles || []).includes(employee.position)
      );

      if (!isAssigned) {
        return res.status(403).json({ message: 'You are not assigned to this shift' });
      }
      shiftSource = 'requested';
    }

    // if (!targetShift && isShiftRequired) {
    //   return res.status(400).json({
    //     message: `Department "${employee.department}" requires shift assignment. Please contact administrator.`,
    //     requiresShift: true
    //   });
    // }

    // ✅ CRITICAL FIX: Check if shift exists and validate check-in time
    if (targetShift) {
      const currentTime = new Date();
      const checkInStatus = targetShift.getShiftStatus(currentTime, 'checkin');
      
      console.log('Shift check-in validation:', {
        shiftName: targetShift.displayName,
        shiftStart: targetShift.startTime,
        shiftEnd: targetShift.endTime,
        currentTime: currentTime.toLocaleTimeString(),
        canCheckIn: checkInStatus.canCheckIn,
        status: checkInStatus.status,
        message: checkInStatus.message
      });
      
      // ❌ BLOCK check-in if not allowed
      if (!checkInStatus.canCheckIn) {
        return res.status(400).json({ 
          message: checkInStatus.message,
          shift: {
            name: targetShift.displayName,
            startTime: targetShift.startTime,
            endTime: targetShift.endTime,
            checkInWindow: `${targetShift.getCheckInWindowStart?.() || targetShift.startTime} - ${targetShift.endTime}`
          }
        });
      }
      
      // Check if already checked in for this shift today
      const existingAttendance = await Attendance.findOne({
        employee: employeeId,
        date: {
          $gte: today.toDate(),
          $lte: moment(today).endOf('day').toDate()
        },
        shift: targetShift._id
      });

      if (existingAttendance && existingAttendance.checkIn) {
        return res.status(400).json({ 
          message: `Already checked in for ${targetShift.displayName} shift today at ${moment(existingAttendance.checkIn).format('hh:mm A')}` 
        });
      }

      const activeAttendance = await Attendance.findOne({
        employee: employeeId,
        $or: [
          { checkOut: { $exists: false } },
          { checkOut: null }
        ]
      });

      if (activeAttendance) {
        return res.status(400).json({
          message: 'Please check out from your current shift before checking in to another shift.'
        });
      }

      // Determine attendance status
      let attendanceStatus = 'present';
      if (checkInStatus.isHalfDay) {
        attendanceStatus = 'half-day';
      }

      // Create attendance record
      const attendanceData = {
        employee: employeeId,
        date: new Date(),
        checkIn: new Date(),
        shift: targetShift._id,
        shiftSource: shiftSource || 'requested',
        shiftName: targetShift.displayName,
        isLateCheckIn: checkInStatus.isLate || false,
        checkInStatus: checkInStatus.status || null,
        status: attendanceStatus
      };

      // Add location if provided
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
        shiftInfo: {
          name: targetShift.displayName,
          startTime: targetShift.startTime,
          endTime: targetShift.endTime,
          status: checkInStatus.status,
          isHalfDay: checkInStatus.isHalfDay || false
        }
      });
    } else {
      // No shift assigned - allow check-in with default rules
      const existingAttendance = await Attendance.findOne({
        employee: employeeId,
        date: {
          $gte: today.toDate(),
          $lte: moment(today).endOf('day').toDate()
        }
      });

      if (existingAttendance && existingAttendance.checkIn) {
        return res.status(400).json({ 
          message: `Already checked in today at ${moment(existingAttendance.checkIn).format('hh:mm A')}` 
        });
      }

      const activeAttendance = await Attendance.findOne({
        employee: employeeId,
        $or: [
          { checkOut: { $exists: false } },
          { checkOut: null }
        ]
      });

      if (activeAttendance) {
        return res.status(400).json({
          message: 'Please check out from your current attendance before checking in again.'
        });
      }

      const attendanceData = {
        employee: employeeId,
        date: new Date(),
        checkIn: new Date(),
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
        data: attendance
      });
    }

  } catch (error) {
    console.error('Check in error:', error);
    if (error.name === 'ValidationError' || error.name === 'CastError' || error.code === 11000) {
      return res.status(400).json({
        message: error.code === 11000
          ? 'Attendance has already been recorded for this shift.'
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
    const attendance = await Attendance.findOne({
      employee: req.user.employee._id,
      $or: [
        { checkOut: { $exists: false } },
        { checkOut: null }
      ]
    }).sort({ checkIn: -1 }); // Get latest active check-in

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

    // Get effective shift for validation (already computed)
    let validationResult = { canCheckOut: true, message: 'No shift restrictions' };

    if (shiftResult.shift) {
      const currentTime = new Date();
      validationResult = shiftResult.shift.getShiftStatus(currentTime, 'checkout');

      // Note: We allow checkout even if validation says it's early, just track it
      // But we don't block checkout
    }

    // Accept location payload for checkout
    const { checkOutLat, checkOutLng, checkOutAccuracy, checkOutPlace, checkOutLocation } = req.body || {};

    attendance.checkOut = new Date();
    if (checkOutLat !== undefined) attendance.checkOutLat = Number(checkOutLat);
    if (checkOutLng !== undefined) attendance.checkOutLng = Number(checkOutLng);
    if (checkOutAccuracy !== undefined) attendance.checkOutAccuracy = Number(checkOutAccuracy);
    if (checkOutPlace) attendance.checkOutPlace = String(checkOutPlace);
    if (checkOutLocation) attendance.checkOutLocation = checkOutLocation;

    // Update shift checkout status
    attendance.isEarlyCheckOut = validationResult.isEarly || false;
    attendance.checkOutStatus = validationResult.status || null;

    // If checkout coords provided but no place, attempt reverse geocoding
    if ((attendance.checkOutLat != null && attendance.checkOutLng != null) && !attendance.checkOutPlace) {
      try {
        const reverseGeocode = require('../utils/reverseGeocode');
        const place = await reverseGeocode(attendance.checkOutLat, attendance.checkOutLng);
        if (place) attendance.checkOutPlace = place;
      } catch (err) {
        console.warn('Reverse geocode error (check-out):', err && err.message ? err.message : err);
      }
    }

    // After getting employee, add this check
    // const deptSetting = await DepartmentSetting.findOne({
    //   tenant: req.tenant._id,
    //   departmentName: employee.department
    // });

    //const isShiftRequired = deptSetting ? deptSetting.shiftRequired : false;

    await attendance.save();

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
      date: { $gte: startDate, $lte: endDate }
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
      date: { $gte: startDate, $lte: endDate }
    };

    if (employeeId) {
      filter.employee = employeeId;
    }

    const attendance = await Attendance.find(filter)
      .populate('employee', 'name email department position')
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
            $gte: today.toDate(),
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

    // Get ALL shifts applicable to this employee
    let applicableShifts = await Shift.find({
      tenant: req.tenant._id,
      isActive: true,
      $or: [
        { assignedDepartments: { $in: [employee.department] } },
        { assignedRoles: { $in: [employee.position] } },
        { assignedEmployees: employee._id }
      ]
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

    const hasActiveAttendance = todayAttendances.some(att => att.checkIn && !att.checkOut);

    // Build shift statuses - EACH SHIFT INDEPENDENTLY
    const shiftsWithStatus = applicableShifts.map(shift => {
      // Find attendance for THIS SPECIFIC shift only
      const attendance = todayAttendances.find(a => 
        a.shift?.toString() === shift._id.toString()
      );
      
      // Determine status for THIS shift only
      let status = 'pending';
      let canCheckIn = false;
      let canCheckOut = false;
      
      if (attendance) {
        if (attendance.checkOut) {
          status = 'completed';  // This specific shift is completed
        } else if (attendance.checkIn) {
          status = 'checked_in';  // This specific shift is active
          canCheckOut = true;
        }
      } else {
        // No attendance for this shift yet - check if check-in is allowed
        const checkInStatus = shift.getShiftStatus(now, 'checkin');
        canCheckIn = !hasActiveAttendance && checkInStatus.canCheckIn;
      }
      
      // Check if shift can be checked in (time window)
      const checkInStatus = shift.getShiftStatus(now, 'checkin');
      
      return {
        _id: shift._id,
        name: shift.displayName,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isNightShift: shift.isNightShift || false,
        status: status,
        checkIn: attendance?.checkIn,
        checkOut: attendance?.checkOut,
        canCheckIn: canCheckIn && status === 'pending',
        canCheckOut: canCheckOut,
        checkInWindow: checkInStatus,
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
