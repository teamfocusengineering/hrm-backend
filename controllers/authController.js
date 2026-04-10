const DefaultUser = require('../models/User');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const generateToken = require('../utils/generateToken');
const { validationResult } = require('express-validator');
const mongoose = require('mongoose');

// Robust Tenant-Aware Model Resolver
const resolveUserModel = (req) => {
  if (
    req &&
    req.models &&
    req.models.User &&
    typeof req.models.User.findOne === 'function'
  ) {
    return req.models.User;
  }

  throw new Error(`❌ User model not initialized for tenant: ${req.headers['x-tenant-id']}`);
};

  // Optional strict mode (uncomment if you want hard failure instead of fallback)
  // throw new Error(`User model not initialized for tenant: ${req.headers['x-tenant-id']}`);

  return DefaultUser;
};

// @desc    User login
// @route   POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const UserModel = resolveUserModel(req);

    console.log("Tenant:", req.headers['x-tenant-id']);
    console.log("UserModel type:", typeof UserModel);
    console.log("Has findOne:", typeof UserModel.findOne);

   if (req.models && req.models.User) {
      console.log("UserModel type-L:", typeof req.models.User.findOne);
      console.log("Model name:", req.models.User.modelName);
  } else {
     console.log("⚠️ req.models not available");
}

    const user = await UserModel.findOne({ email, isActive: true })
      .populate({
        path: 'employee',
        select: 'name email department position salary employeeId isActive'
      });

    if (!user || !user.employee || !user.employee.isActive) {
      return res.status(401).json({ message: 'Invalid credentials or account inactive' });
    }

    const isPasswordMatch = await user.matchPassword(password);
    if (!isPasswordMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = generateToken(user._id, user.role);

    user.lastLogin = new Date();
    user.createLoginSession(token);
    await user.save();

    res.json({
      _id: user._id,
      employee: user.employee,
      role: user.role,
      mobileAllowed: user.mobileAllowed || false,
      tenant: user.tenant,
      token: token,
      loginTime: user.lastLogin
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Logout user
exports.logout = async (req, res) => {
  try {
    const UserModel = resolveUserModel(req);
    const user = await UserModel.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.invalidateSession();
    await user.save();

    // Auto check-out
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const attendance = await Attendance.findOne({
        employee: user.employee,
        date: {
          $gte: today,
          $lte: new Date(today.getTime() + 86400000)
        },
        checkOut: { $exists: false }
      });

      if (attendance) {
        attendance.checkOut = new Date();
        await attendance.save();
      }
    } catch (err) {
      console.log('Auto check-out failed:', err.message);
    }

    res.json({
      message: 'Logout successful',
      logoutTime: user.lastLogout
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Force logout user
exports.forceLogout = async (req, res) => {
  try {
    const UserModel = resolveUserModel(req);

    const userToLogout = await UserModel.findById(req.params.userId)
      .populate('employee', 'name email');

    if (!userToLogout) {
      return res.status(404).json({ message: 'User not found' });
    }

    userToLogout.invalidateSession();
    await userToLogout.save();

    res.json({
      message: `User ${userToLogout.employee.name} has been logged out successfully`,
      logoutTime: userToLogout.lastLogout,
      forcedBy: req.user.employee.name
    });
  } catch (error) {
    console.error('Force logout error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get current user
exports.getMe = async (req, res) => {
  try {
    const UserModel = resolveUserModel(req);

    const user = await UserModel.findById(req.user._id)
      .populate({
        path: 'employee',
        select: '-__v'
      });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      _id: user._id,
      employee: user.employee,
      role: user.role,
      mobileAllowed: user.mobileAllowed || false,
      lastLogin: user.lastLogin,
      lastLogout: user.lastLogout,
      isSessionValid: user.isSessionValid(req.headers.authorization?.split(' ')[1])
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Change password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const UserModel = resolveUserModel(req);
    const user = await UserModel.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    user.invalidateSession();
    await user.save();

    res.json({
      message: 'Password updated successfully. Please login again.',
      logoutTime: user.lastLogout
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get active sessions
exports.getActiveSessions = async (req, res) => {
  try {
    const UserModel = resolveUserModel(req);

    const activeUsers = await UserModel.find({
      'loginSession.isValid': true,
      'loginSession.expires': { $gt: new Date() }
    })
      .populate('employee', 'name email department position')
      .select('email role lastLogin loginSession');

    res.json({
      totalActiveSessions: activeUsers.length,
      activeSessions: activeUsers
    });
  } catch (error) {
    console.error('Get active sessions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Change employee password
exports.changeEmployeePassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    const { userId } = req.params;

    const UserModel = resolveUserModel(req);

    let user;
    if (mongoose.Types.ObjectId.isValid(userId)) {
      user = await UserModel.findById(userId).populate('employee', 'name email');

      if (!user) {
        user = await UserModel.findOne({ employee: userId }).populate('employee', 'name email');
      }
    } else {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.password = newPassword;
    user.invalidateSession();
    user.passwordChangedAt = Date.now();
    await user.save();

    res.json({
      message: `Password updated successfully for ${user.employee.name}`
    });
  } catch (error) {
    console.error('Change employee password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Reset employee password
exports.resetEmployeePassword = async (req, res) => {
  try {
    const { userId } = req.params;

    const UserModel = resolveUserModel(req);

    let user;
    if (mongoose.Types.ObjectId.isValid(userId)) {
      user = await UserModel.findById(userId).populate('employee', 'name email');

      if (!user) {
        user = await UserModel.findOne({ employee: userId }).populate('employee', 'name email');
      }
    } else {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const newPassword = Math.random().toString(36).slice(-8) + 'A1!';

    user.password = newPassword;
    user.invalidateSession();
    user.passwordChangedAt = Date.now();
    await user.save();

    res.json({
      message: `Password reset successfully for ${user.employee.name}`,
      newPassword
    });
  } catch (error) {
    console.error('Reset employee password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
