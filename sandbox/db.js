// db.js
require('dotenv').config({ path: '../.env' });

const pool = require('../lib/db');

module.exports = pool;
