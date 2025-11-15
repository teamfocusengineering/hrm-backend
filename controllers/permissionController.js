const DefaultPermission = require('../models/Permission');
const DefaultAttendance = require('../models/Attendance');
const DefaultEmployee = require('../models/Employee');
const mongoose = require('mongoose');

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};
const moment = require('moment');

// @desc    Apply for permission
// @route   POST /api/permissions
// @access  Private
exports.applyForPermission = async (req, res) => {
  try {
    const { permissionType, date, startTime, endTime, reason } = req.body;

    console.log('Received permission data:', {
      permissionType,
      date,
      startTime,
      endTime,
      reason,
    });

    // Validate required fields
    if (!permissionType || !date || !startTime || !endTime || !reason) {
      return res.status(400).json({
        message:
          'All fields are required: permissionType, date, startTime, endTime, reason',
      });
    }

    // Validate date is not in past
    const permissionDate = moment(date).startOf('day');
    const today = moment().startOf('day');

    if (permissionDate.isBefore(today)) {
      return res
        .status(400)
        .json({ message: 'Cannot apply for permission for past dates' });
    }

    const parseTimeWithAMPM = (timeStr, dateStr) => {
      let time = timeStr.trim().toUpperCase();
      let [timePart, modifier] = time.split(' ');

      let [hours, minutes] = timePart.split(':');
      hours = parseInt(hours);
      minutes = parseInt(minutes || '0');

      console.log('Parsing time:', {
        timeStr,
        timePart,
        modifier,
        hours,
        minutes,
      });

      // Handle AM/PM
      if (modifier === 'PM' && hours < 12) {
        hours += 12;
      }
      if (modifier === 'AM' && hours === 12) {
        hours = 0;
      }

      // Handle 24-hour format (if no AM/PM provided)
      if (!modifier && hours < 12 && timeStr.includes('04')) {
        // If it's 04:00 without AM/PM, assume PM for early departure
        hours += 12;
      }

      // Create date in IST timezone (UTC+5:30)
      const timeString = `${dateStr}T${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:00+05:30`;
      
      return moment(timeString).toDate(); // This will store as UTC but represent IST time
    };

    const startDateTime = parseTimeWithAMPM(startTime, date);
    const endDateTime = parseTimeWithAMPM(endTime, date);

    console.log('Final parsed times:', {
      startTime: startTime,
      startDateTime: startDateTime.toISOString(),
      startDateTimeLocal: startDateTime.toString(),
      endTime: endTime,
      endDateTime: endDateTime.toISOString(),
      endDateTimeLocal: endDateTime.toString(),
    });

    // Validate that dates are valid
    if (!moment(startDateTime).isValid() || !moment(endDateTime).isValid()) {
      return res.status(400).json({ message: 'Invalid date or time format' });
    }

    // Validate that end time is after start time
    if (moment(endDateTime).isSameOrBefore(moment(startDateTime))) {
      return res
        .status(400)
        .json({ message: 'End time must be after start time' });
    }

    // Calculate duration in hours
    const duration = moment(endDateTime).diff(
      moment(startDateTime),
      'hours',
      true
    );

    console.log('Calculated duration:', duration);

    // Validate duration is positive
    if (duration <= 0) {
      return res.status(400).json({
        message:
          'Duration must be positive. End time should be after start time.',
      });
    }

    // Check for existing permission on same date
    const PermissionModel = resolveModel(req, 'Permission', DefaultPermission);
    const existingPermission = await PermissionModel.findOne({
      employee: req.user.employee._id,
      date: permissionDate.toDate(),
      status: { $in: ['pending', 'approved'] },
    });

    if (existingPermission) {
      return res
        .status(400)
        .json({ message: 'Already have a permission request for this date' });
    }

    const permission = await PermissionModel.create({
      employee: req.user.employee._id,
      permissionType,
      date: permissionDate.toDate(),
      startTime: startDateTime,
      endTime: endDateTime,
      duration: parseFloat(duration.toFixed(2)),
      reason,
    });

    await permission.populate('employee', 'name email department position');

    res.status(201).json(permission);
  } catch (error) {
    console.error('Apply for permission error:', error);

    // More detailed error logging
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        message: 'Validation failed',
        errors,
      });
    }

    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get my permissions
// @route   GET /api/permissions/my-permissions
// @access  Private
exports.getMyPermissions = async (req, res) => {
  try {
    const { month, year, status } = req.query;
    let filter = { employee: req.user.employee._id };

    if (month && year) {
      // CHANGE: Use local time instead of UTC
      const startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      const endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
      filter.date = { $gte: startDate, $lte: endDate };
    }

    if (status) {
      filter.status = status;
    }

    const PermissionModel2 = resolveModel(req, 'Permission', DefaultPermission);
    const permissions = await PermissionModel2.find(filter)
      .populate('approvedBy', 'name')
      .sort({ date: -1 });

    res.json(permissions);
  } catch (error) {
    console.error('Get my permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};


// @desc    Get all permissions (Admin/Manager)
// @route   GET /api/permissions
// @access  Private/Admin
exports.getAllPermissions = async (req, res) => {
  try {
    const { status, month, year, employeeId } = req.query;
    let filter = {};

    if (status) {
      filter.status = status;
    }

    if (month && year) {
      // CHANGE: Use local time instead of UTC
      const startDate = moment(`${year}-${month}`, 'YYYY-MM').startOf('month').toDate();
      const endDate = moment(`${year}-${month}`, 'YYYY-MM').endOf('month').toDate();
      filter.date = { $gte: startDate, $lte: endDate };
    }

    if (employeeId) {
      filter.employee = employeeId;
    }

    const PermissionModel3 = resolveModel(req, 'Permission', DefaultPermission);
    const permissions = await PermissionModel3.find(filter)
      .populate('employee', 'name email department position')
      .populate('approvedBy', 'name')
      .sort({ createdAt: -1 });

    res.json(permissions);
  } catch (error) {
    console.error('Get all permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update permission status
// @route   PUT /api/permissions/:id/status
// @access  Private/Admin
exports.updatePermissionStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const PermissionModel4 = resolveModel(req, 'Permission', DefaultPermission);
    const permission = await PermissionModel4.findById(req.params.id).populate(
      'employee',
      'name email department position'
    );

    if (!permission) {
      return res.status(404).json({ message: 'Permission not found' });
    }

    permission.status = status;
    permission.approvedBy = req.user.employee._id;
    permission.approvedAt = new Date();

    await permission.save();

    // If approved, update attendance record
    if (status === 'approved') {
      await updateAttendanceWithPermission(req, permission);
    }

    await permission.populate('approvedBy', 'name');

    res.json(permission);
  } catch (error) {
    console.error('Update permission status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get permission statistics
// @route   GET /api/permissions/stats
// @access  Private
exports.getPermissionStats = async (req, res) => {
  try {
    const currentYear = moment().year();

    const PermissionModel5 = resolveModel(req, 'Permission', DefaultPermission);
    const stats = await PermissionModel5.aggregate([
      {
        $match: {
          employee: req.user.employee._id,
          date: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`),
          },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalHours: { $sum: '$duration' },
        },
      },
    ]);

    // Get monthly breakdown

  const monthlyStats = await PermissionModel5.aggregate([
      {
        $match: {
          employee: req.user.employee._id,
          date: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`),
          },
        },
      },
      {
        $group: {
          _id: {
            month: { $month: '$date' },
            status: '$status',
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { '_id.month': 1 },
      },
    ]);

    res.json({
      yearlyStats: stats,
      monthlyStats: monthlyStats,
    });
  } catch (error) {
    console.error('Get permission stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Helper function to update attendance with permission
const updateAttendanceWithPermission = async (req, permission) => {
  try {
    // CHANGE: Use local time instead of UTC
    const attendanceDate = moment(permission.date).startOf('day');
    // Resolve attendance model for tenant
    const AttendanceModel = resolveModel(req, 'Attendance', DefaultAttendance);
    let attendance = await AttendanceModel.findOne({
      employee: permission.employee._id,
      date: {
        $gte: attendanceDate.toDate(),
        $lte: attendanceDate.endOf('day').toDate(),
      },
    });

    if (!attendance) {
      // Create attendance record if doesn't exist
      attendance = await AttendanceModel.create({
        employee: permission.employee._id,
        date: permission.date,
        checkIn: permission.startTime,
        status: 'present-with-permission',
      });
    }

    // Add permission to attendance record
    attendance.permissions.push({
      permission: permission._id,
      type: permission.permissionType,
      duration: permission.duration,
    });

    await attendance.save();
  } catch (error) {
    console.error('Error updating attendance with permission:', error);
    throw error;
  }
};