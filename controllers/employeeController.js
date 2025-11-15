const { validationResult } = require('express-validator');

// @desc    Create new employee (Admin only)
// @route   POST /api/employees
// @access  Private/Admin
exports.createEmployee = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      name, 
      email, 
      password, 
      role, 
      department, 
      position, 
      salary,
      phone,
      dateOfBirth,
      gender,
      address,
      employmentType,
      workMode
    } = req.body;

    // Use tenant-specific models
    const Employee = req.models.Employee;
    const User = req.models.User;

    // Check if employee already exists
    const employeeExists = await Employee.findOne({ email });
    if (employeeExists) {
      return res.status(400).json({ message: 'Employee already exists with this email' });
    }

    // Create employee record
    const employee = await Employee.create({
      name,
      email,
      department,
      position,
      salary,
      phone,
      dateOfBirth,
      gender,
      address,
      employmentType,
      workMode: workMode || 'wfo',
      tenant: req.tenant._id // Add tenant reference
    });

    // Create user account for the employee
    const user = await User.create({
      email,
      password: password || 'default123',
      role: role || 'employee',
      employee: employee._id,
      tenant: req.tenant._id // Add tenant reference
    });

    res.status(201).json({
      _id: employee._id,
      employeeId: employee.employeeId,
      name: employee.name,
      email: employee.email,
      role: user.role,
      department: employee.department,
      position: employee.position,
      salary: employee.salary,
      employmentType: employee.employmentType,
      workMode: employee.workMode,
      joiningDate: employee.joiningDate,
      isActive: employee.isActive
    });
  } catch (error) {
    console.error('Create employee error:', error);
    
    // Clean up if employee was created but user creation failed
    if (error.name === 'MongoServerError' && error.code === 11000) {
      const Employee = req.models.Employee;
      await Employee.deleteOne({ email: req.body.email });
    }
    
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get all employees
// @route   GET /api/employees
// @access  Private/Admin
exports.getEmployees = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    const User = req.models.User;

    const filter = { isActive: true };
    // If tenant context is available and Employee has tenant field, scope queries
    if (req.tenant && req.tenant._id) {
      filter.tenant = req.tenant._id;
    }

    const employees = await Employee.find(filter)
      .populate('user', 'role isActive lastLogin')
      .select('-__v');

    res.json(employees);
  } catch (error) {
    console.error('Get employees error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get employee by ID
// @route   GET /api/employees/:id
// @access  Private
exports.getEmployee = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    const User = req.models.User;

    let employee;
    
    if (req.user.role === 'admin') {
      // Admin can view any employee
      employee = await Employee.findById(req.params.id)
        .populate('user', 'role isActive lastLogin email');
    } else {
      // Employee can only view their own profile
      const User = req.models.User;
      const userEmployee = await User.findById(req.user._id).select('employee');
      if (req.params.id !== userEmployee.employee.toString()) {
        return res.status(403).json({ message: 'Access denied' });
      }
      employee = await Employee.findById(req.params.id)
        .populate('user', 'role isActive lastLogin email');
    }

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // If employee belongs to a different tenant, block access
    if (employee.tenant && req.tenant && employee.tenant.toString() !== req.tenant._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(employee);
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update employee
// @route   PUT /api/employees/:id
// @access  Private/Admin
exports.updateEmployee = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    const User = req.models.User;

    const employee = await Employee.findById(req.params.id);

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const { 
      name, email, department, position, salary, isActive,
      phone, dateOfBirth, gender, address, employmentType, workMode
    } = req.body;

    // Update all fields including workMode
    employee.name = name || employee.name;
    employee.email = email || employee.email;
    employee.department = department || employee.department;
    employee.position = position || employee.position;
    employee.salary = salary || employee.salary;
    employee.phone = phone || employee.phone;
    employee.dateOfBirth = dateOfBirth || employee.dateOfBirth;
    employee.gender = gender || employee.gender;
    employee.address = address || employee.address;
    employee.employmentType = employmentType || employee.employmentType;
    employee.workMode = workMode || employee.workMode;
    employee.isActive = isActive !== undefined ? isActive : employee.isActive;

    // If email is updated, also update the user email
    if (email && email !== employee.email) {
      await User.findOneAndUpdate(
        { employee: employee._id },
        { email: email }
      );
    }

    const updatedEmployee = await employee.save();
    
    res.json({
      _id: updatedEmployee._id,
      name: updatedEmployee.name,
      email: updatedEmployee.email,
      department: updatedEmployee.department,
      position: updatedEmployee.position,
      salary: updatedEmployee.salary,
      workMode: updatedEmployee.workMode,
      isActive: updatedEmployee.isActive
    });
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Delete employee
// @route   DELETE /api/employees/:id
// @access  Private/Admin
exports.deleteEmployee = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    const User = req.models.User;

    console.log('🔧 DELETE request received for employee ID:', req.params.id);
    console.log('🔧 User making request:', req.user._id, req.user.role);

    const employee = await Employee.findById(req.params.id);

    if (!employee) {
      console.log('❌ Employee not found:', req.params.id);
      return res.status(404).json({ message: 'Employee not found' });
    }

    console.log('📝 Found employee to delete:', employee.name, employee.email);

    // Soft delete employee and user
    employee.isActive = false;
    await employee.save();
    console.log('✅ Employee marked as inactive');

    await User.findOneAndUpdate(
      { employee: employee._id },
      { isActive: false }
    );
    console.log('✅ User account marked as inactive');

    res.json({ 
      message: 'Employee removed successfully',
      employeeId: employee._id,
      employeeName: employee.name
    });
    
  } catch (error) {
    console.error('❌ Delete employee error:', error);
    res.status(500).json({ 
      message: 'Server error during deletion',
      error: error.message 
    });
  }
};

// @desc    Get employee profile (for current logged-in employee)
// @route   GET /api/employees/profile/me
// @access  Private
exports.getMyProfile = async (req, res) => {
  try {
    const User = req.models.User;
    const Employee = req.models.Employee;

    const user = await User.findById(req.user._id).populate('employee');
    
    if (!user || !user.employee) {
      return res.status(404).json({ message: 'Employee profile not found' });
    }

    res.json(user.employee);
  } catch (error) {
    console.error('Get my profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update employee profile (for current logged-in employee)
// @route   PUT /api/employees/profile/me
// @access  Private
exports.updateMyProfile = async (req, res) => {
  try {
    const User = req.models.User;
    const Employee = req.models.Employee;

    const user = await User.findById(req.user._id);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const employee = await Employee.findById(user.employee);
    
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Employees can only update certain fields
    const { phone, address, emergencyContact } = req.body;

    employee.phone = phone || employee.phone;
    employee.address = address || employee.address;
    employee.emergencyContact = emergencyContact || employee.emergencyContact;

    const updatedEmployee = await employee.save();

    res.json(updatedEmployee);
  } catch (error) {
    console.error('Update my profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};