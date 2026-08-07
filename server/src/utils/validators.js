const { createHttpError } = require('./http-error');

function validateCredentials(payload) {
  const email = payload?.email;
  const password = payload?.password;

  if (typeof email !== 'string' || !email.trim()) {
    throw createHttpError(400, 'Email is required');
  }

  if (typeof password !== 'string' || password.length < 8) {
    throw createHttpError(400, 'Password must be at least 8 characters long');
  }

  return {
    email,
    password,
  };
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

module.exports = {
  normalizeEmail,
  validateCredentials,
};