const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { query } = require('../db');
const { createHttpError } = require('../utils/http-error');
const { normalizeEmail, validateCredentials } = require('../utils/validators');

const jwtSecret = process.env.JWT_SECRET;

async function signupUser(payload) {
  const { email, password } = validateCredentials(payload);
  const normalizedEmail = normalizeEmail(email);

  const existingUser = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existingUser.rowCount > 0) {
    throw createHttpError(409, 'Email is already registered');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, created_at`,
    [normalizedEmail, passwordHash]
  );

  return {
    token: signToken(result.rows[0].id),
    user: result.rows[0],
  };
}

async function loginUser(payload) {
  const { email, password } = validateCredentials(payload);
  const normalizedEmail = normalizeEmail(email);

  const result = await query(
    'SELECT id, email, password_hash, created_at FROM users WHERE email = $1',
    [normalizedEmail]
  );

  if (result.rowCount === 0) {
    throw createHttpError(401, 'Invalid email or password');
  }

  const user = result.rows[0];
  const passwordMatches = await bcrypt.compare(password, user.password_hash);

  if (!passwordMatches) {
    throw createHttpError(401, 'Invalid email or password');
  }

  return {
    token: signToken(user.id),
    user: {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
    },
  };
}

function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, jwtSecret, { expiresIn: '7d' });
}

module.exports = {
  loginUser,
  signupUser,
};