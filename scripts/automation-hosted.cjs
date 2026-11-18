require('dotenv').config();
const automation = require('../src/automation/index');
automation.start({ listen: true });
