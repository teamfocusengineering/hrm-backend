const mongoose = require('mongoose');
const { getSuperAdminModels, connectTenantDB, getTenantModels } = require('../config/db');

// Get main models helper
const getMainModels = () => {
  return getSuperAdminModels();
};

// @desc    Get super admin analytics overview
// @route   GET /api/super-admin/analytics/overview
// @access  Private/SuperAdmin
exports.getAnalyticsOverview = async (req, res) => {
  try {
    const { Tenant } = getMainModels();

    // Total tenants and status breakdown
    const totalTenants = await Tenant.countDocuments();
    const activeTenants = await Tenant.countDocuments({ isActive: true });
    const inactiveTenants = await Tenant.countDocuments({ isActive: false });
    
    // Subscription plan breakdown
    const planStats = await Tenant.aggregate([
      {
        $group: {
          _id: '$subscription.plan',
          count: { $sum: 1 }
        }
      }
    ]);

    // Industry breakdown
    const industryStats = await Tenant.aggregate([
      {
        $group: {
          _id: '$industry',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Company size breakdown
    const sizeStats = await Tenant.aggregate([
      {
        $group: {
          _id: '$size',
          count: { $sum: 1 }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        totalTenants,
        activeTenants,
        inactiveTenants,
        planStats,
        industryStats,
        sizeStats
      }
    });
  } catch (error) {
    console.error('Analytics overview error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load analytics overview'
    });
  }
};

// @desc    Get tenant growth over time
// @route   GET /api/super-admin/analytics/tenants-growth
// @access  Private/SuperAdmin
exports.getTenantsGrowth = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { period = 'monthly' } = req.query;

    let groupFormat;
    if (period === 'daily') {
      groupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
    } else if (period === 'weekly') {
      groupFormat = { $dateToString: { format: '%Y-%U', date: '$createdAt' } };
    } else {
      groupFormat = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
    }

    const growthData = await Tenant.aggregate([
      {
        $group: {
          _id: groupFormat,
          count: { $sum: 1 },
          activeCount: {
            $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] }
          }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: 12 }
    ]);

    // Calculate cumulative growth
    let cumulative = 0;
    const growthWithCumulative = growthData.map(item => {
      cumulative += item.count;
      return {
        period: item._id,
        newTenants: item.count,
        activeTenants: item.activeCount,
        cumulativeTenants: cumulative
      };
    });

    res.json({
      success: true,
      data: growthWithCumulative
    });
  } catch (error) {
    console.error('Tenants growth analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load tenants growth data'
    });
  }
};

// @desc    Get top companies by employee count
// @route   GET /api/super-admin/analytics/top-companies
// @access  Private/SuperAdmin
exports.getTopCompanies = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { limit = 5 } = req.query;

    const tenants = await Tenant.find({ isActive: true })
      .select('name companyName subdomain industry size employeeCount')
      .sort({ employeeCount: -1 })
      .limit(parseInt(limit));

    // Get employee counts for each tenant
    const companiesWithEmployeeCount = await Promise.all(
      tenants.map(async (tenant) => {
        try {
          const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
          const models = await getTenantModels(tenantConnection);
          const employeeCount = await models.Employee.countDocuments({ isActive: true });
          
          return {
            _id: tenant._id,
            name: tenant.name,
            companyName: tenant.companyName,
            subdomain: tenant.subdomain,
            industry: tenant.industry,
            size: tenant.size,
            employeeCount: employeeCount
          };
        } catch (error) {
          console.error(`Error getting employee count for tenant ${tenant.companyName}:`, error);
          return {
            ...tenant.toObject(),
            employeeCount: 0
          };
        }
      })
    );

    // Sort by employee count
    companiesWithEmployeeCount.sort((a, b) => b.employeeCount - a.employeeCount);

    res.json({
      success: true,
      data: companiesWithEmployeeCount.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('Top companies analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load top companies data'
    });
  }
};

// @desc    Get daily active employees
// @route   GET /api/super-admin/analytics/daily-active-users
// @access  Private/SuperAdmin
exports.getDailyActiveUsers = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { days = 7 } = req.query;

    const activeTenants = await Tenant.find({ isActive: true }).select('_id companyName');

    const dailyActiveData = [];
    const today = new Date();
    
    for (let i = parseInt(days) - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateString = date.toISOString().split('T')[0];

      let totalActiveEmployees = 0;
      let tenantsWithActivity = 0;

      // For each tenant, check attendance for that day
      for (const tenant of activeTenants) {
        try {
          const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
          const models = await getTenantModels(tenantConnection);
          
          const activeEmployees = await models.Attendance.countDocuments({
            date: {
              $gte: new Date(dateString + 'T00:00:00.000Z'),
              $lte: new Date(dateString + 'T23:59:59.999Z')
            }
          });

          if (activeEmployees > 0) {
            tenantsWithActivity++;
            totalActiveEmployees += activeEmployees;
          }
        } catch (error) {
          console.error(`Error getting daily active for tenant ${tenant.companyName}:`, error);
          continue;
        }
      }

      dailyActiveData.push({
        date: dateString,
        activeEmployees: totalActiveEmployees,
        activeTenants: tenantsWithActivity
      });
    }

    res.json({
      success: true,
      data: dailyActiveData
    });
  } catch (error) {
    console.error('Daily active users analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load daily active users data'
    });
  }
};

// @desc    Get attendance rate comparison
// @route   GET /api/super-admin/analytics/attendance-rates
// @access  Private/SuperAdmin
exports.getAttendanceRates = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { period = 'month' } = req.query;

    const activeTenants = await Tenant.find({ isActive: true })
      .select('_id companyName industry size')
      .limit(20); // Limit to prevent too many database connections

    const attendanceRates = [];

    for (const tenant of activeTenants) {
      try {
        const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
        const models = await getTenantModels(tenantConnection);
        
        // Get total employees
        const totalEmployees = await models.Employee.countDocuments({ isActive: true });
        if (totalEmployees === 0) continue;

        // Calculate date range based on period
        const startDate = new Date();
        if (period === 'week') {
          startDate.setDate(startDate.getDate() - 7);
        } else if (period === 'month') {
          startDate.setMonth(startDate.getMonth() - 1);
        } else {
          startDate.setMonth(startDate.getMonth() - 3);
        }

        // Get attendance records in period
        const attendanceRecords = await models.Attendance.countDocuments({
          date: { $gte: startDate }
        });

        // Calculate attendance rate
        const workingDays = period === 'week' ? 5 : period === 'month' ? 22 : 66;
        const expectedAttendance = totalEmployees * workingDays;
        const attendanceRate = expectedAttendance > 0 
          ? (attendanceRecords / expectedAttendance) * 100 
          : 0;

        attendanceRates.push({
          tenantId: tenant._id,
          companyName: tenant.companyName,
          industry: tenant.industry,
          size: tenant.size,
          totalEmployees,
          attendanceRecords,
          attendanceRate: Math.round(attendanceRate * 100) / 100,
          period
        });
      } catch (error) {
        console.error(`Error getting attendance for tenant ${tenant.companyName}:`, error);
        continue;
      }
    }

    // Sort by attendance rate descending
    attendanceRates.sort((a, b) => b.attendanceRate - a.attendanceRate);

    res.json({
      success: true,
      data: attendanceRates
    });
  } catch (error) {
    console.error('Attendance rates analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load attendance rates data'
    });
  }
};

// @desc    Get comprehensive analytics dashboard
// @route   GET /api/super-admin/analytics/dashboard
// @access  Private/SuperAdmin
exports.getDashboardAnalytics = async (req, res) => {
  try {
    // Create mock response objects to avoid circular dependencies
    const mockRes = (data) => ({
      json: () => data
    });

    // Call each function directly instead of using exports
    const overview = await exports.getAnalyticsOverview(req, mockRes({ data: {} }));
    const growth = await exports.getTenantsGrowth(req, mockRes({ data: {} }));
    const topCompanies = await exports.getTopCompanies({ ...req, query: { limit: 5 } }, mockRes({ data: {} }));
    const dailyActive = await exports.getDailyActiveUsers({ ...req, query: { days: 7 } }, mockRes({ data: {} }));
    const attendanceRates = await exports.getAttendanceRates({ ...req, query: { period: 'month' } }, mockRes({ data: {} }));

    res.json({
      success: true,
      data: {
        overview: overview?.data || {},
        growth: growth?.data || {},
        topCompanies: topCompanies?.data || [],
        dailyActive: dailyActive?.data || [],
        attendanceRates: attendanceRates?.data || []
      }
    });
  } catch (error) {
    console.error('Dashboard analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load dashboard analytics'
    });
  }
};