const jwt = require('jsonwebtoken');

/**
 * Verify a JWT and return its payload, or null if it is missing/invalid.
 *
 * Shared deliberately: the HTTP middleware and the Socket.io handshake must
 * agree on what counts as an authenticated user. They did not before — the
 * socket layer accepted every connection without looking at the token the
 * client was already sending, which is how anomalies ended up broadcast to
 * every browser on the site.
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/** Pull a bearer token out of an Authorization header. */
function bearerFrom(header) {
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  return scheme && /^Bearer$/i.test(scheme) && value ? value : null;
}

/** The Socket.io room carrying one user's events, and nobody else's. */
const roomForUser = (userId) => `user:${userId}`;

module.exports = { verifyToken, bearerFrom, roomForUser };
