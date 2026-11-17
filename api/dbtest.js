const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { getMongoOptions } = require('../src/mongoOptions');
const { JWT_SECRET } = require('../src/authSecret');
const { User } = require('../src/models');

module.exports = async (req, res) => {
  try {
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required.' });
    let claims;
    try { claims = jwt.verify(authorization.slice(7), JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Invalid authentication token.' }); }

    const uri = process.env.MONGODB_URI;
    if (!uri) return res.status(503).json({ error: 'Database diagnostics are unavailable.' });

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(uri, getMongoOptions());
    }
    const user = await User.findById(claims.userId).select('isAdmin').lean();
    if (!user) return res.status(401).json({ error: 'Account not found.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });

    const collections = await mongoose.connection.db.listCollections().toArray();
    res.json({ ok: true, collections: collections.map(c => c.name) });
  } catch (err) {
    console.error('Database diagnostic request failed:', err.message);
    res.status(500).json({ ok: false, error: 'Database diagnostics failed.' });
  }
};
