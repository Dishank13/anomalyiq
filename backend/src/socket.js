const { verifyToken, bearerFrom, roomForUser } = require('./lib/token');
const logger = require('./lib/logger');

/**
 * Authenticate every Socket.io connection and confine it to its own room.
 *
 * Previously the server accepted any connection and used io.emit(), so every
 * connected browser received every user's anomalies; the frontend merely hid
 * the ones it did not recognise. Rows still crossed the wire. Joining a
 * per-user room means the server never sends them in the first place.
 */
function registerSocketAuth(io) {
  io.use((socket, next) => {
    const { token } = socket.handshake.auth || {};
    const decoded = verifyToken(token || bearerFrom(socket.handshake.headers.authorization));

    if (!decoded) {
      // Surfaces on the client as a connect_error rather than a silent no-op.
      return next(new Error('Unauthorized'));
    }

    socket.data.userId = decoded.id;
    next();
  });

  io.on('connection', (socket) => {
    const room = roomForUser(socket.data.userId);
    socket.join(room);
    logger.debug({ socketId: socket.id, room }, 'socket connected');

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, room, reason }, 'socket disconnected');
    });
  });
}

/** Emit an event to one user's room only. */
function emitToUser(io, userId, event, payload) {
  io.to(roomForUser(userId)).emit(event, payload);
}

module.exports = { registerSocketAuth, emitToUser };
