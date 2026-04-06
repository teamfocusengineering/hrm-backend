const mongoose = require('mongoose');
const DefaultShift = require('../models/Shift');
const DefaultEmployee = require('../models/Employee');

const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

const getModels = (req) => ({
  Shift: resolveModel(req, 'Shift', DefaultShift),
  Employee: resolveModel(req, 'Employee', DefaultEmployee),
});

// ==================== SHIFT CRUD OPERATIONS ====================

// @desc    Create new shift
// @route   POST /api/shifts
// @access  Private/Admin
exports.createShift = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const {
      name,
      displayName,
      startTime,
      endTime,
      gracePeriod,
      lateMarkingAfter,
      halfDayMarkingAfter,
      assignedDepartments,
      assignedRoles,
      assignedEmployees,
      isNightShift
    } = req.body;

    // Validate required fields
    if (!name || !displayName || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, displayName, startTime, endTime'
      });
    }

    // Check tenant exists
    if (!req.tenant || !req.tenant._id) {
      return res.status(400).json({
        success: false,
        message: 'Tenant not found. Please login again.'
      });
    }

    // Check if shift already exists for this tenant (case-insensitive, trim whitespace)
    const trimmedName = name.trim().toLowerCase();
    const existingShift = await Shift.findOne({ 
      name: trimmedName,
      tenant: req.tenant._id 
    });

    if (existingShift) {
      return res.status(400).json({ 
        success: false, 
        message: `Shift "${trimmedName}" already exists. Use a different name.` 
      });
    }

    const shift = await Shift.create({
      name,
      displayName,
      startTime,
      endTime,
      gracePeriod: gracePeriod || 15,
      lateMarkingAfter: lateMarkingAfter || 15,
      halfDayMarkingAfter: halfDayMarkingAfter || 120,
      assignedDepartments: assignedDepartments || [],
      assignedRoles: assignedRoles || [],
      assignedEmployees: assignedEmployees || [],
      isNightShift: isNightShift || false,
      tenant: req.tenant._id,
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      data: shift,
      message: 'Shift created successfully'
    });
  } catch (error) {
    console.error('Create shift error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
};

// @desc    Get all shifts with statistics
// @route   GET /api/shifts
// @access  Private/Admin
exports.getShifts = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    const { isActive, includeStats } = req.query;
    
    let filter = { tenant: req.tenant._id };
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    let shifts = await Shift.find(filter).sort({ createdAt: -1 });

    // Include employee count statistics if requested
    if (includeStats === 'true') {
      shifts = await Promise.all(shifts.map(async (shift) => {
        const shiftObj = shift.toObject();
        
        // Count employees by department assignment
        const deptEmployees = shift.assignedDepartments.length > 0 
          ? await Employee.countDocuments({
              department: { $in: shift.assignedDepartments },
              isActive: true,
              tenant: req.tenant._id
            })
          : 0;
        
        // Count employees by role assignment
        const roleEmployees = shift.assignedRoles.length > 0
          ? await Employee.countDocuments({
              position: { $in: shift.assignedRoles },
              isActive: true,
              tenant: req.tenant._id
            })
          : 0;
        
        // Direct assigned employees count
        const directEmployees = shift.assignedEmployees.length;
        
        shiftObj.stats = {
          byDepartment: deptEmployees,
          byRole: roleEmployees,
          directAssigned: directEmployees,
          totalCovered: deptEmployees + roleEmployees + directEmployees
        };
        
        return shiftObj;
      }));
    }

    res.json({
      success: true,
      data: shifts,
      total: shifts.length
    });
  } catch (error) {
    console.error('Get shifts error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Get single shift
// @route   GET /api/shifts/:id
// @access  Private/Admin
exports.getShift = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    
    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    res.json({
      success: true,
      data: shift
    });
  } catch (error) {
    console.error('Get shift error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Update shift
// @route   PUT /api/shifts/:id
// @access  Private/Admin
exports.updateShift = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    
    const shift = await Shift.findOneAndUpdate(
      {
        _id: req.params.id,
        tenant: req.tenant._id
      },
      req.body,
      { new: true, runValidators: true }
    );

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    res.json({
      success: true,
      data: shift,
      message: 'Shift updated successfully'
    });
  } catch (error) {
    console.error('Update shift error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Delete shift (soft delete)
// @route   DELETE /api/shifts/:id
// @access  Private/Admin
exports.deleteShift = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    
    // Check if any employees are directly assigned to this shift
    const employeesWithShift = await Employee.countDocuments({
      assignedShift: req.params.id,
      isActive: true
    });

    if (employeesWithShift > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete shift. ${employeesWithShift} employees are directly assigned to this shift. Please reassign them first.` 
      });
    }

    const shift = await Shift.findOneAndUpdate(
      {
        _id: req.params.id,
        tenant: req.tenant._id
      },
      { isActive: false },
      { new: true }
    );

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    res.json({
      success: true,
      message: 'Shift deactivated successfully'
    });
  } catch (error) {
    console.error('Delete shift error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// ==================== SHIFT ASSIGNMENT OPERATIONS ====================

// @desc    Assign shift to departments
// @route   POST /api/shifts/:id/assign/departments
// @access  Private/Admin
exports.assignToDepartments = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const { departments } = req.body;
    
    if (!departments || !departments.length) {
      return res.status(400).json({ 
        success: false, 
        message: 'Departments array is required' 
      });
    }

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    // Add new departments without duplicates
    const newDepartments = departments.filter(dept => !shift.assignedDepartments.includes(dept));
    shift.assignedDepartments.push(...newDepartments);
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Shift assigned to ${newDepartments.length} departments`,
      newDepartments: newDepartments
    });
  } catch (error) {
    console.error('Assign to departments error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Assign shift to roles
// @route   POST /api/shifts/:id/assign/roles
// @access  Private/Admin
exports.assignToRoles = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const { roles } = req.body;
    
    if (!roles || !roles.length) {
      return res.status(400).json({ 
        success: false, 
        message: 'Roles array is required' 
      });
    }

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    // Add new roles without duplicates
    const newRoles = roles.filter(role => !shift.assignedRoles.includes(role));
    shift.assignedRoles.push(...newRoles);
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Shift assigned to ${newRoles.length} roles`,
      newRoles: newRoles
    });
  } catch (error) {
    console.error('Assign to roles error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Assign shift to specific employees
// @route   POST /api/shifts/:id/assign/employees
// @access  Private/Admin
exports.assignToEmployees = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    const { employeeIds } = req.body;
    
    if (!employeeIds || !employeeIds.length) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee IDs array is required' 
      });
    }

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    // Update employees with direct shift assignment
    const result = await Employee.updateMany(
      {
        _id: { $in: employeeIds },
        tenant: req.tenant._id
      },
      {
        assignedShift: shift._id,
        shiftSource: 'admin',
        shiftAssignedAt: new Date(),
        shiftAssignedBy: req.user._id
      }
    );

    // Also add to shift's assignedEmployees array (avoid duplicates)
    const existingAssignments = shift.assignedEmployees.map(id => id.toString());
    const newAssignments = employeeIds.filter(id => !existingAssignments.includes(id));
    shift.assignedEmployees.push(...newAssignments);
    await shift.save();

    res.json({
      success: true,
      data: {
        shift,
        modifiedCount: result.modifiedCount,
        newAssignments: newAssignments.length
      },
      message: `Shift assigned to ${result.modifiedCount} employees`
    });
  } catch (error) {
    console.error('Assign to employees error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Remove departments from shift
// @route   DELETE /api/shifts/:id/assign/departments
// @access  Private/Admin
exports.removeDepartments = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const { departments } = req.body;

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    shift.assignedDepartments = shift.assignedDepartments.filter(
      dept => !departments.includes(dept)
    );
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Removed ${departments.length} departments from shift`
    });
  } catch (error) {
    console.error('Remove departments error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Remove roles from shift
// @route   DELETE /api/shifts/:id/assign/roles
// @access  Private/Admin
exports.removeRoles = async (req, res) => {
  try {
    const { Shift } = getModels(req);
    const { roles } = req.body;

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    shift.assignedRoles = shift.assignedRoles.filter(
      role => !roles.includes(role)
    );
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Removed ${roles.length} roles from shift`
    });
  } catch (error) {
    console.error('Remove roles error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Remove employees from shift
// @route   DELETE /api/shifts/:id/assign/employees
// @access  Private/Admin
exports.removeEmployees = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    const { employeeIds } = req.body;

    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    // Remove direct assignment from employees
    await Employee.updateMany(
      {
        _id: { $in: employeeIds },
        tenant: req.tenant._id
      },
      {
        assignedShift: null,
        shiftSource: null,
        shiftAssignedAt: null
      }
    );

    // Remove from shift's assignedEmployees array
    shift.assignedEmployees = shift.assignedEmployees.filter(
      id => !employeeIds.includes(id.toString())
    );
    await shift.save();

    res.json({
      success: true,
      data: shift,
      message: `Removed ${employeeIds.length} employees from shift`
    });
  } catch (error) {
    console.error('Remove employees error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// ==================== QUERY OPERATIONS ====================

// @desc    Get employee's effective shift (priority resolution)
// @route   GET /api/shifts/employee/:employeeId
// @access  Private/Admin
exports.getEmployeeShift = async (req, res) => {
  try {
    const { Employee } = getModels(req);
    
    const employee = await Employee.findById(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Employee not found' 
      });
    }

    const result = await employee.getEffectiveShift(getModels(req));
    
    res.json({
      success: true,
      data: {
        employee: {
          _id: employee._id,
          name: employee.name,
          department: employee.department,
          position: employee.position
        },
        shift: result.shift,
        source: result.source,
        priority: result.priority
      }
    });
  } catch (error) {
    console.error('Get employee shift error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Get my current shift (for logged-in employee)
// @route   GET /api/shifts/my-shift
// @access  Private
exports.getMyShift = async (req, res) => {
  try {
    const { Employee } = getModels(req);
    
    const employee = await Employee.findById(req.user.employee._id);
    if (!employee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Employee not found' 
      });
    }

    const result = await employee.getEffectiveShift(getModels(req));
    const now = new Date();
    
    let shiftStatus = null;
    let canCheckIn = false;
    let canCheckOut = false;
    
    if (result.shift) {
      const checkInStatus = result.shift.getShiftStatus(now, 'checkin');
      const checkOutStatus = result.shift.getShiftStatus(now, 'checkout');
      shiftStatus = {
        checkIn: checkInStatus,
        checkOut: checkOutStatus
      };
      canCheckIn = checkInStatus.canCheckIn;
      canCheckOut = checkOutStatus.canCheckOut;
    }
    
    res.json({
      success: true,
      data: {
        shift: result.shift,
        source: result.source,
        priority: result.priority,
        currentTime: now,
        canCheckIn,
        canCheckOut,
        shiftStatus
      }
    });
  } catch (error) {
    console.error('Get my shift error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Get my shifts for today (for multi-shift support)
// @route   GET /api/shifts/today
// @access  Private
exports.getMyShiftsToday = async (req, res) => {
  try {
    const { Employee, Shift, Attendance } = getModels(req);
    
    const employee = await Employee.findById(req.user.employee._id);
    if (!employee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Employee not found' 
      });
    }

    const today = moment().startOf('day').toDate();
    const todayEnd = moment().endOf('day').toDate();

    // Get today's completed shifts for this employee
    const completedToday = await Attendance.find({
      employee: req.user.employee._id,
      date: {
        $gte: today,
        $lte: todayEnd
      },
      checkOut: { $exists: true, $ne: null }
    }).select('shift').lean();

    const completedShiftIds = completedToday.map(a => a.shift).filter(Boolean);

    // Get effective shift matching (could match multiple)
    const shiftResult = await employee.getEffectiveShift(getModels(req));
    
    // Find all applicable shifts for today (department/role/direct)
    const applicableShifts = await Shift.find({
      tenant: req.tenant._id,
      isActive: true,
      $or: [
        { assignedDepartments: { $in: [employee.department] } },
        { assignedRoles: { $in: [employee.position] } },
        { assignedEmployees: employee._id }
      ]
    }).lean();

    // Filter out completed shifts and add status
    const todayShifts = applicableShifts
      .filter(s => !completedShiftIds.includes(s._id))
      .map(shift => ({
        ...shift,
        status: 'pending',
        canCheckIn: shiftResult.shift?._id.toString() === shift._id.toString()
      }));

    res.json({
      success: true,
      data: {
        todayShifts,
        completedToday: completedShiftIds.length,
        totalApplicable: applicableShifts.length,
        nextShift: todayShifts[0] || null
      }
    });
  } catch (error) {
    console.error('Get my shifts today error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};


// @desc    Get employees by shift
// @route   GET /api/shifts/:id/employees
// @access  Private/Admin
exports.getShiftEmployees = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    
    const shift = await Shift.findOne({
      _id: req.params.id,
      tenant: req.tenant._id
    });

    if (!shift) {
      return res.status(404).json({ 
        success: false, 
        message: 'Shift not found' 
      });
    }

    // Get employees from different assignment types
    const deptEmployees = shift.assignedDepartments.length > 0
      ? await Employee.find({
          department: { $in: shift.assignedDepartments },
          isActive: true,
          tenant: req.tenant._id
        }).select('name email department position assignedShift')
      : [];

    const roleEmployees = shift.assignedRoles.length > 0
      ? await Employee.find({
          position: { $in: shift.assignedRoles },
          isActive: true,
          tenant: req.tenant._id
        }).select('name email department position assignedShift')
      : [];

    const directEmployees = shift.assignedEmployees.length > 0
      ? await Employee.find({
          _id: { $in: shift.assignedEmployees },
          isActive: true
        }).select('name email department position assignedShift')
      : [];

    // Combine and deduplicate
    const allEmployees = [...deptEmployees, ...roleEmployees, ...directEmployees];
    const uniqueEmployees = Array.from(new Map(allEmployees.map(emp => [emp._id.toString(), emp])).values());

    res.json({
      success: true,
      data: {
        shift,
        employees: uniqueEmployees,
        counts: {
          fromDepartments: deptEmployees.length,
          fromRoles: roleEmployees.length,
          directAssigned: directEmployees.length,
          totalUnique: uniqueEmployees.length
        }
      }
    });
  } catch (error) {
    console.error('Get shift employees error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Get all available departments (for dropdown)
// @route   GET /api/shifts/departments
// @access  Private/Admin
exports.getDepartments = async (req, res) => {
  try {
    const { Employee } = getModels(req);
    
    const departments = await Employee.distinct('department', {
      tenant: req.tenant._id,
      isActive: true
    });
    
    res.json({
      success: true,
      data: departments.filter(d => d && d.trim())
    });
  } catch (error) {
    console.error('Get departments error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Get all available roles (for dropdown)
// @route   GET /api/shifts/roles
// @access  Private/Admin
exports.getRoles = async (req, res) => {
  try {
    const { Employee } = getModels(req);
    
    const roles = await Employee.distinct('position', {
      tenant: req.tenant._id,
      isActive: true
    });
    
    res.json({
      success: true,
      data: roles.filter(r => r && r.trim())
    });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Get shift assignment summary for dashboard
// @route   GET /api/shifts/summary
// @access  Private/Admin
exports.getShiftSummary = async (req, res) => {
  try {
    const { Shift, Employee } = getModels(req);
    
    const totalEmployees = await Employee.countDocuments({
      tenant: req.tenant._id,
      isActive: true
    });
    
    const shifts = await Shift.find({
      tenant: req.tenant._id,
      isActive: true
    });
    
    let coveredEmployees = 0;
    const shiftDetails = await Promise.all(shifts.map(async (shift) => {
      // Count unique employees covered by this shift
      const deptEmployees = shift.assignedDepartments.length > 0
        ? await Employee.countDocuments({
            department: { $in: shift.assignedDepartments },
            isActive: true,
            tenant: req.tenant._id
          })
        : 0;
      
      const roleEmployees = shift.assignedRoles.length > 0
        ? await Employee.countDocuments({
            position: { $in: shift.assignedRoles },
            isActive: true,
            tenant: req.tenant._id
          })
        : 0;
      
      const directCount = shift.assignedEmployees.length;
      
      // Simple sum (may have overlaps, but that's fine for summary)
      const shiftTotal = deptEmployees + roleEmployees + directCount;
      coveredEmployees += shiftTotal;
      
      return {
        _id: shift._id,
        name: shift.name,
        displayName: shift.displayName,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isNightShift: shift.isNightShift,
        assignedDepartmentsCount: shift.assignedDepartments.length,
        assignedRolesCount: shift.assignedRoles.length,
        assignedEmployeesCount: shift.assignedEmployees.length,
        estimatedCoverage: shiftTotal
      };
    }));
    
    res.json({
      success: true,
      data: {
        totalEmployees,
        totalShifts: shifts.length,
        coveredEmployees: Math.min(coveredEmployees, totalEmployees),
        uncoveredEmployees: Math.max(0, totalEmployees - coveredEmployees),
        shifts: shiftDetails
      }
    });
  } catch (error) {
    console.error('Get shift summary error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};