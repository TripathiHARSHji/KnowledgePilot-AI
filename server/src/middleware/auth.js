const jwt = require('jsonwebtoken');

const { findUserById } = require('../services/user-service');
const { createHttpError } = require('../utils/http-error');

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required');
}

async function authMiddleware(request, _response, next) {
  try {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw createHttpError(401, 'Authorization token is required');
    }

    const token = header.slice('Bearer '.length);
    const payload = jwt.verify(token, jwtSecret);
    const user = await findUserById(payload.sub);

    if (!user) {
      throw createHttpError(401, 'Invalid authorization token');
    }

    request.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      next(createHttpError(401, 'Invalid authorization token'));
      return;
    }

    next(error);
  }
}

module.exports = {
  authMiddleware,
};