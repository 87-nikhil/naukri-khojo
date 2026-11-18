require('dotenv').config();

const automation = require('./server');
automation.start({listen: true});