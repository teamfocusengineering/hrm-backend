const mongoose = require('mongoose');
const moment = require('moment');

const approvalSchema = new mongoose.Schema({
  approver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  status: {
    type: String,
    enum: ['approved', 'rejected'],
    required: true
  },
  approverType: {
    type: String,
    enum: ['lead', 'admin'],
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

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
    type: Number,
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
  approvals: [approvalSchema],
  affectsAttendance: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Calculate duration before saving
permissionSchema.pre('save', function(next) {
  try {
    if (this.startTime && this.endTime) {
      const start = moment(this.startTime);
      const end = moment(this.endTime);
      if (start.isValid() && end.isValid()) {
        const diff = end.diff(start, 'hours', true);
        this.duration = parseFloat(diff.toFixed(2));
      }
    }
  } catch (error) {
    console.error('Error calculating permission duration:', error);
  }
  next();
});

// Update status based on approvals
permissionSchema.methods.updateStatusFromApprovals = function() {
  const leadApproval = this.approvals.find(a => a.approverType === 'lead' && a.status === 'approved');
  const adminApproval = this.approvals.find(a => a.approverType === 'admin' && a.status === 'approved');
  
  if (leadApproval && adminApproval) {
    this.status = 'approved';
  } else if (this.approvals.some(a => a.status === 'rejected')) {
    this.status = 'rejected';
  } else {
    this.status = 'pending';
  }
};

// Indexes
permissionSchema.index({ employee: 1, date: 1 });
permissionSchema.index({ status: 1 });
permissionSchema.index({ createdAt: -1 });

module.exports = permissionSchema;
