const mongoose = require('mongoose');
const moment = require('moment'); // Add this import

const attendanceSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  checkIn: {
    type: Date,
    required: true
  },
  checkOut: {
    type: Date
  },
  workingHours: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['present', 'absent', 'half-day', 'present-with-permission'],
    default: 'present'
  },
  permissions: [{
    permission: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Permission'
    },
    type: {
      type: String,
      enum: ['half-day', 'short-leave', 'late-arrival', 'early-departure', 'break-extension']
    },
    duration: {
      type: Number
    }
  }],
  adjustedHours: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Calculate working hours before saving
attendanceSchema.pre('save', function(next) {
  try {
    if (this.checkOut) {
      const diff = this.checkOut - this.checkIn;
      const rawHours = (diff / (1000 * 60 * 60)).toFixed(2);
      this.workingHours = parseFloat(rawHours);
      
      // Calculate adjusted hours considering permissions
      let totalPermissionHours = 0;
      if (this.permissions && this.permissions.length > 0) {
        this.permissions.forEach(p => {
          if (p.duration) {
            totalPermissionHours += p.duration;
          }
        });
      }
      
      this.adjustedHours = this.workingHours + totalPermissionHours;
      
      // Update status based on adjusted hours
      if (this.adjustedHours < 4) {
        this.status = 'half-day';
      } else if (this.adjustedHours >= 4 && this.adjustedHours < 8) {
        this.status = 'present-with-permission';
      } else {
        this.status = 'present';
      }
    }
  } catch (error) {
    console.error('Error calculating attendance hours:', error);
  }
  next();
});

// Compound index to ensure one attendance per employee per day
attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = attendanceSchema;