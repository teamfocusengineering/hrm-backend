const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const moment = require('moment');
const reverseGeocode = require('../utils/reverseGeocode');
const Shift = require('../models/Shift');


exports.checkIn = async (req, res) => {
  try {
    const { Attendance, Employee, Shift, DepartmentSetting } = req.models;
    const today = moment().startOf('day');

    // ✅ Log incoming request
    //console.log('Check-in request body:', req.body);
    // console.log('Check-in location data:', {
    //   lat: req.body.checkInLat,
    //   lng: req.body.checkInLng,
    //   accuracy: req.body.checkInAccuracy,
    //   place: req.body.checkInPlace
    // });

    // Get employee details
    const employee = await Employee.findById(req.user.employee._id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Check if department requires shift
    const deptSetting = await DepartmentSetting.findOne({
      tenant: req.tenant._id,
      departmentName: employee.department
    });

    const isShiftRequired = deptSetting ? deptSetting.shiftRequired : false;

    // Determine which shift to check into
    let targetShift = null;
    let shiftSource = null;
    
    if (req.body.shiftId) {
      // Use specifically requested shift
      targetShift = await Shift.findOne({
        _id: req.body.shiftId,
        tenant: req.tenant._id,
        isActive: true
      });
      
      if (targetShift) {
        // Validate if employee is assigned to this shift
        const isAssigned = (
          targetShift.assignedEmployees?.includes(employee._id) || 
          targetShift.assignedDepartments?.includes(employee.department) || 
          targetShift.assignedRoles?.includes(employee.position)
        );
        
        if (!isAssigned) {
          return res.status(403).json({ message: 'You are not assigned to this shift' });
        }
        shiftSource = 'requested';
      }
    }

    // Fallback to default effective shift if none requested or found
    if (!targetShift) {
       const shiftResult = await employee.getEffectiveShift(req.models);
       targetShift = shiftResult.shift;
       shiftSource = shiftResult.source;
    }

    // Check if already checked in for today for THIS SPECIFIC SHIFT
    // This allows multiple shifts per day
    const checkInShiftId = targetShift ? targetShift._id : null;
    
    const existingAttendance = await Attendance.findOne({
      employee: req.user.employee._id,
      date: {
        $gte: today.toDate(),
        $lte: moment(today).endOf('day').toDate()
      },
      shift: checkInShiftId
    });

    if (existingAttendance && existingAttendance.checkIn) {
      return res.status(400).json({ 
        message: `Already checked in for ${existingAttendance.shiftName || 'this shift'} today at ${moment(existingAttendance.checkIn).format('hh:mm A')}` 
      });
    }

    // Validate shift if required
    let validationResult = { 
      canCheckIn: true, 
      message: 'Check-in allowed',
      status: null,
      isLate: false,
      isHalfDay: false
    };

    if (isShiftRequired) {
      if (!targetShift) {
        return res.status(400).json({
          message: `Department "${employee.department}" requires shift assignment. Please contact administrator.`,
          requiresShift: true
        });
      }

      const currentTime = new Date();
      validationResult = targetShift.getShiftStatus(currentTime, 'checkin');

      if (!validationResult.canCheckIn && validationResult.status !== 'half-day') {
        return res.status(400).json({
          message: validationResult.message,
          shift: {
            name: targetShift.displayName,
            startTime: targetShift.startTime,
            endTime: targetShift.endTime
          }
        });
      }
    }

    // Determine attendance status
    let attendanceStatus = 'present';
    if (validationResult.isHalfDay) {
      attendanceStatus = 'half-day';
    }

    // ✅ Create attendance record with location
    const attendanceData = {
      employee: req.user.employee._id,
      date: new Date(),
      checkIn: new Date(),
      shift: targetShift ? targetShift._id : null,
      shiftSource: shiftSource,
      shiftName: targetShift ? targetShift.displayName : null,
      isLateCheckIn: validationResult.isLate || false,
      checkInStatus: validationResult.status || null,
      status: attendanceStatus
    };

    // ✅ Ensure location data is properly saved
    if (req.body.checkInLat !== undefined && req.body.checkInLat !== null) {
      attendanceData.checkInLat = Number(req.body.checkInLat);
      console.log('Saving checkInLat:', attendanceData.checkInLat);
    }
    if (req.body.checkInLng !== undefined && req.body.checkInLng !== null) {
      attendanceData.checkInLng = Number(req.body.checkInLng);
      console.log('Saving checkInLng:', attendanceData.checkInLng);
    }
    if (req.body.checkInAccuracy !== undefined && req.body.checkInAccuracy !== null) {
      attendanceData.checkInAccuracy = Number(req.body.checkInAccuracy);
    }
    if (req.body.checkInPlace) {
      attendanceData.checkInPlace = String(req.body.checkInPlace);
    }

    const attendance = await Attendance.create(attendanceData);
    
    console.log('Attendance created successfully:', {
      id: attendance._id,
      checkIn: attendance.checkIn,
      hasLocation: !!(attendance.checkInLat && attendance.checkInLng)
    });

    res.status(201).json({
      success: true,
      data: attendance,
      shiftInfo: targetShift ? {
        name: targetShift.displayName,
        startTime: targetShift.startTime,
        endTime: targetShift.endTime,
        source: shiftSource,
        status: validationResult.status,
        isHalfDay: validationResult.isHalfDay || false
      } : null
    });

  } catch (error) {
    console.error('Check in error:', error);
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
};
// @desc    Check out employee (with shift validation)
// @route   POST /api/attendance/checkout
// @access  Private
exports.checkOut = async (req, res) => {
  try {
    const { Attendance, Employee, Shift, DepartmentSetting } = req.models;
    const today = moment().startOf('day');

    // Get employee with shift
    const employee = await Employee.findById(req.user.employee._id);

    // Find active check-in for today (any shift)
    const attendance = await Attendance.findOne({
      employee: req.user.employee._id,
      date: {
        $gte: today.toDate(),
        $lte: moment(today).endOf('day').toDate()
      },
      $or: [
        { checkOut: { $exists: false } },
        { checkOut: null }
      ]
    }).sort({ checkIn: -1 }); // Get latest active check-in

    if (!attendance) {
      return res.status(400).json({ message: "No active check-in found for today. Please check in first." });
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
    const { checkOutLat, checkOutLng, checkOutAccuracy, checkOutPlace } = req.body || {};

    attendance.checkOut = new Date();
    if (checkOutLat !== undefined) attendance.checkOutLat = Number(checkOutLat);
    if (checkOutLng !== undefined) attendance.checkOutLng = Number(checkOutLng);
    if (checkOutAccuracy !== undefined) attendance.checkOutAccuracy = Number(checkOutAccuracy);
    if (checkOutPlace) attendance.checkOutPlace = String(checkOutPlace);

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
    const deptSetting = await DepartmentSetting.findOne({
      tenant: req.tenant._id,
      departmentName: employee.department
    });

    const isShiftRequired = deptSetting ? deptSetting.shiftRequired : false;

    if (isShiftRequired && !shiftResult.shift) {
      return res.status(400).json({
        message: `Department "${employee.department}" requires shift assignment. Cannot checkout.`,
        requiresShift: true
      });
    }

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
    
    // Get ALL shifts applicable to this employee
    const applicableShifts = await Shift.find({
      tenant: req.tenant._id,
      isActive: true,
      $or: [
        { assignedDepartments: { $in: [employee.department] } },
        { assignedRoles: { $in: [employee.position] } },
        { assignedEmployees: employee._id }
      ]
    }).sort({ startTime: 1 });

    // Get today's attendance records
    const todayAttendances = await Attendance.find({
      employee: req.user.employee._id,
      date: {
        $gte: today.toDate(),
        $lte: moment(today).endOf('day').toDate()
      }
    });

    // Build shift statuses
    const shiftsWithStatus = applicableShifts.map(shift => {
      const attendance = todayAttendances.find(a => 
        a.shift?.toString() === shift._id.toString()
      );
      
      const checkInStatus = shift.getShiftStatus(now, 'checkin');
      const checkOutStatus = attendance?.checkIn ? 
        shift.getShiftStatus(now, 'checkout') : null;
      
      return {
        _id: shift._id,
        name: shift.displayName,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isNightShift: shift.isNightShift || false,
        status: attendance ? 
          (attendance.checkOut ? 'completed' : 'checked_in') : 
          'pending',
        checkIn: attendance?.checkIn,
        checkOut: attendance?.checkOut,
        canCheckIn: !attendance && checkInStatus.canCheckIn,
        canCheckOut: attendance && !attendance.checkOut && checkOutStatus?.canCheckOut,
        checkInWindow: checkInStatus,
        workingHours: attendance?.workingHours
      };
    });

    // Find active shift (checked in but not out)
    const activeShift = shiftsWithStatus.find(s => s.status === 'checked_in');
    
    // Find next pending shift that can be checked in
    const nextShift = shiftsWithStatus.find(s => s.status === 'pending' && s.canCheckIn);

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