const express = require('express');
const { body } = require('express-validator');
const {
  createEmployee,
  getEmployees,
  getEmployee,
  updateEmployee,
  deleteEmployee,
  getMyProfile,
  updateMyProfile
} = require('../controllers/employeeController');
const { protect, authorize } = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.use(protect);
router.use(requireTenant);

// Admin routes
router.post('/', 
  authorize('admin'),
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Please include a valid email'),
    body('department').notEmpty().withMessage('Department is required'),
    body('position').notEmpty().withMessage('Position is required'),
    body('salary').isNumeric().withMessage('Salary must be a number')
  ],
  createEmployee
);

router.get('/', authorize('admin'), getEmployees);
router.delete('/:id', authorize('admin'), deleteEmployee);
router.put('/:id', authorize('admin'), updateEmployee);
router.get('/:id', getEmployee);

// Employee self-service routes
router.get('/profile/me', getMyProfile);
router.put('/profile/me', updateMyProfile);

module.exports = router;