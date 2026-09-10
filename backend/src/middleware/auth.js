const { verifyToken, bearerFrom } = require('../lib/token');

module.exports = (req, res, next) => {
  const token = bearerFrom(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  req.user = decoded;
  next();
};
