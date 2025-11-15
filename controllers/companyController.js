const { getSuperAdminModels } = require('../config/db');
const { validationResult } = require('express-validator');

// @desc    Get company information
// @route   GET /api/company
// @access  Private
exports.getCompanyInfo = async (req, res) => {
  try {
  const { Company } = getSuperAdminModels();
  const company = await Company.getCompany();
    res.json(company);
  } catch (error) {
    console.error('Get company info error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update company information
// @route   PUT /api/company
// @access  Private/Admin
exports.updateCompanyInfo = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, logo, address, contact, settings } = req.body;

    // Get the company document (there should only be one)
    let company = await Company.findOne();
    
    if (!company) {
      // Create new company if doesn't exist
      company = new Company();
    }

    // Update fields
    if (name) company.name = name;
    if (logo) company.logo = logo;
    if (address) company.address = address;
    if (contact) company.contact = contact;
    if (settings) company.settings = { ...company.settings, ...settings };

    await company.save();

    res.json({
      _id: company._id,
      name: company.name,
      logo: company.logo,
      address: company.address,
      contact: company.contact,
      settings: company.settings,
      updatedAt: company.updatedAt
    });
  } catch (error) {
    console.error('Update company info error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Upload company logo
// @route   POST /api/company/logo
// @access  Private/Admin
exports.uploadLogo = async (req, res) => {
  try {
    // For base64 image upload
    const { logo } = req.body;

    if (!logo) {
      return res.status(400).json({ message: 'Logo data is required' });
    }

  const { Company } = getSuperAdminModels();
  const company = await Company.getCompany();
    company.logo = logo;
    await company.save();

    res.json({
      message: 'Logo uploaded successfully',
      logo: company.logo
    });
  } catch (error) {
    console.error('Upload logo error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get public company information (for login page)
// @route   GET /api/company/public
// @access  Public
exports.getPublicCompanyInfo = async (req, res) => {
  try {
  const { Company } = getSuperAdminModels();
  const company = await Company.getCompany();
    
    // Return only public information (no sensitive data)
    res.json({
      _id: company._id,
      name: company.name,
      logo: company.logo,
      contact: {
        email: company.contact?.email,
        phone: company.contact?.phone,
        website: company.contact?.website
      }
    });
  } catch (error) {
    console.error('Get public company info error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

