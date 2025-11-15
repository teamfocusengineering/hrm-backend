const mongoose = require('mongoose');
const moment = require('moment'); // Add this import

const permissionSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  permissionType: {
    type: String,
    enum: ['half-day', 'short-leave', 'late-arrival', 'early-departure', 'break-extension'],
    required: true
  },
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    required: true
  },
  duration: {
    type: Number, // in hours
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
  },
  approvedAt: {
    type: Date
  },
  affectsAttendance: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Calculate duration before saving - more robust version
permissionSchema.pre('save', function(next) {
  try {
    if (this.startTime && this.endTime) {
      const start = moment(this.startTime);
      const end = moment(this.endTime);
      
      if (start.isValid() && end.isValid()) {
        const diff = end.diff(start, 'hours', true);
        this.duration = parseFloat(diff.toFixed(2));
      } else {
        console.error('Invalid dates in permission:', { startTime: this.startTime, endTime: this.endTime });
      }
    }
  } catch (error) {
    console.error('Error calculating permission duration:', error);
  }
  next();
});

// Index for efficient queries
permissionSchema.index({ employee: 1, date: 1 });
permissionSchema.index({ status: 1 });
permissionSchema.index({ createdAt: -1 });

// Export the schema (not a registered model) so it can be used to create
// tenant-scoped models dynamically via mongoose.model(name, schema)
module.exports = permissionSchema;