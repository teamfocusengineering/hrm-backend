const LeaveExport = require('../models/Leave');
const { validationResult } = require('express-validator');
const moment = require('moment');
const mongoose = require('mongoose');

// Resolve the Leave model in a tenant-aware manner. Some modules export a Schema
// (for tenant DB registration) while others expect a Model. Use `req.models` when
// available (set by tenant middleware), otherwise register/retrieve the model
// on the default mongoose connection.
const resolveLeaveModel = (req) => {
  if (req && req.models && req.models.Leave) return req.models.Leave;
  if (LeaveExport && typeof LeaveExport.create === 'function') return LeaveExport;

  const schema = LeaveExport && LeaveExport.schema ? LeaveExport.schema : LeaveExport;
  if (mongoose.models && mongoose.models.Leave) return mongoose.models.Leave;
  return mongoose.model('Leave', schema);
};

// @desc    Apply for leave
// @route   POST /api/leaves
// @access  Private
exports.applyForLeave = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { leaveType, startDate, endDate, reason } = req.body;

    const Leave = resolveLeaveModel(req);

    // Ensure the authenticated user is linked to an employee record
    if (!req.user || !req.user.employee) {
      return res.status(400).json({ message: 'Authenticated user is not linked to an employee record' });
    }

    // Check if end date is after start date
    if (moment(endDate).isBefore(moment(startDate))) {
      return res.status(400).json({ message: 'End date must be after start date' });
    }

    const leave = await Leave.create({
      employee: req.user.employee._id,
      leaveType,
      startDate,
      endDate,
      reason
    });

    // If the model is a mongoose document, populate for response
    if (leave && typeof leave.populate === 'function') {
      await leave.populate('employee', 'name email department');
    }

    res.status(201).json(leave);
  } catch (error) {
    console.error('Apply for leave error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get my leaves
// @route   GET /api/leaves/my-leaves
// @access  Private
exports.getMyLeaves = async (req, res) => {
  try {
    const Leave = resolveLeaveModel(req);
    const leaves = await Leave.find({ employee: req.user.employee._id })
      .populate('approvedBy', 'name')
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error) {
    console.error('Get my leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get all leaves (Admin)
// @route   GET /api/leaves
// @access  Private/Admin
exports.getAllLeaves = async (req, res) => {
  try {
    const { status } = req.query;
    let filter = {};

    if (status) {
      filter.status = status;
    }

    const Leave = resolveLeaveModel(req);
    const leaves = await Leave.find(filter)
      .populate('employee', 'name email department position')
      .populate('approvedBy', 'name')
      .sort({ createdAt: -1 });

    res.json(leaves);
  } catch (error) {
    console.error('Get all leaves error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update leave status
// @route   PUT /api/leaves/:id/status
// @access  Private/Admin
exports.updateLeaveStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const Leave = resolveLeaveModel(req);
    const leave = await Leave.findById(req.params.id);

    if (!leave) {
      return res.status(404).json({ message: 'Leave not found' });
    }

    leave.status = status;
    leave.approvedBy = req.user.employee._id;
    leave.approvedAt = new Date();

    await leave.save();
    if (typeof leave.populate === 'function') {
      await leave.populate('employee', 'name email department');
      await leave.populate('approvedBy', 'name');
    }

    res.json(leave);
  } catch (error) {
    console.error('Update leave status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get leave statistics
// @route   GET /api/leaves/stats
// @access  Private
exports.getLeaveStats = async (req, res) => {
  try {
    const currentYear = moment().year();

    const Leave = resolveLeaveModel(req);
    const stats = await Leave.aggregate([
      {
        $match: {
          employee: req.user.employee._id,
          startDate: {
            $gte: new Date(`${currentYear}-01-01`),
            $lte: new Date(`${currentYear}-12-31`)
          }
        }
      },
      {
        $group: {
          _id: '$leaveType',
          totalDays: { $sum: '$totalDays' },
          approvedDays: {
            $sum: {
              $cond: [{ $eq: ['$status', 'approved'] }, '$totalDays', 0]
            }
          },
          pendingDays: {
            $sum: {
              $cond: [{ $eq: ['$status', 'pending'] }, '$totalDays', 0]
            }
          }
        }
      }
    ]);

    res.json(stats);
  } catch (error) {
    console.error('Get leave stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};