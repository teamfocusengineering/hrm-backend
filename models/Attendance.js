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
  checkInLat: {
    type: Number
  },
  checkInLng: {
    type: Number
  },
  checkInAccuracy: {
    type: Number
  },
  checkInPlace: {
    type: String
  },
  checkOut: {
    type: Date
  },
  checkOutLat: {
    type: Number
  },
  checkOutLng: {
    type: Number
  },
  checkOutAccuracy: {
    type: Number
  },
  checkOutPlace: {
    type: String
  },
  workingHours: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['present', 'absent', 'half-day', 'present-with-permission', 'on-permission'],
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
  },
   shift: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shift',
    default: null
  },
  shiftSource: {
    type: String,
    enum: ['user', 'role', 'department', 'default', 'requested', null],
    default: null
  },
  shiftName: {
    type: String,
    default: null
  },
  isLateCheckIn: {
    type: Boolean,
    default: false
  },
  isEarlyCheckOut: {
    type: Boolean,
    default: false
  },
  checkInStatus: {
    type: String,
    enum: ['on-time', 'late', 'early', null],
    default: null
  },
  checkOutStatus: {
    type: String,
    enum: ['on-time', 'early', 'late', null],
    default: null
  }
}, {
  timestamps: true
},

);

// Calculate working hours before saving (exclude permission overlaps)
attendanceSchema.pre('save', function(next) {
  try {
    if (this.checkIn && this.checkOut && this.permissions && this.permissions.length > 0) {
      const checkIn = moment(this.checkIn);
      const checkOut = moment(this.checkOut);
      const rawHours = checkOut.diff(checkIn, 'hours', true);
      this.workingHours = rawHours;
      
      let permissionOverlapHours = 0;
      
      // Calculate overlap between checkin-checkout and each permission
      this.permissions.forEach(p => {
        if (p.startTime && p.endTime) {
          const permStart = moment(p.startTime);
          const permEnd = moment(p.endTime);
          
          const overlapStart = moment.max(checkIn, permStart);
          const overlapEnd = moment.min(checkOut, permEnd);
          
          if (overlapStart.isBefore(overlapEnd)) {
            permissionOverlapHours += overlapEnd.diff(overlapStart, 'hours', true);
          }
        }
      });
      
      this.adjustedHours = Math.max(0, rawHours - permissionOverlapHours);
      
      // Updated status logic
      if (this.adjustedHours === 0 && permissionOverlapHours > 0) {
        this.status = 'on-permission';
      } else if (this.adjustedHours < 4) {
        this.status = 'half-day';
      } else if (permissionOverlapHours > 0) {
        this.status = 'present-with-permission';
      } else {
        this.status = 'present';
      }
    } else if (this.checkOut) {
      // No permissions, normal calculation
      const diff = this.checkOut - this.checkIn;
      const rawHours = (diff / (1000 * 60 * 60)).toFixed(2);
      this.workingHours = parseFloat(rawHours);
      this.adjustedHours = this.workingHours;
      
      if (this.adjustedHours < 4) {
        this.status = 'half-day';
      } else {
        this.status = 'present';
      }
    }
  } catch (error) {
    console.error('Error calculating attendance hours:', error);
  }
  next();
});

// Compound index to ensure one attendance per employee per day per shift (allows multiple shifts/day)
attendanceSchema.index({ employee: 1, date: 1, shift: 1 }, { unique: true });

module.exports = attendanceSchema;