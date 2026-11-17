const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { JWT_SECRET } = require('../authSecret');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    User.findById(decoded.userId).select('-password').then(user => {
      if (!user) return res.status(401).json({ success: false, error: 'User not found' });
      req.user = user;
      next();
    }).catch(() => res.status(401).json({ success: false, error: 'Invalid token' }));
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = { authenticate, signToken, JWT_SECRET };
