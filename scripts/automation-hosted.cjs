require('dotenv').config();
const automation = require('../src/automation/server');
automation.start({ listen: true });
