const bcrypt = require('bcryptjs');
const { UniqueConstraintError } = require('sequelize');
const jwt = require('jsonwebtoken');

const { User } = require('../db');
const { createHttpError } = require('../utils/http-error');
const { normalizeEmail, validateCredentials } = require('../utils/validators');

const jwtSecret = process.env.JWT_SECRET;

async function signupUser(payload) {
  const { email, password } = validateCredentials(payload);
  const normalizedEmail = normalizeEmail(email);

  const passwordHash = await bcrypt.hash(password, 12);

  let user;
  try {
    user = await User.create({
      email: normalizedEmail,
      passwordHash,
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      throw createHttpError(409, 'Email is already registered');
    }

    throw error;
  }

  return {
    token: signToken(user.id),
    user: serializeUser(user),
  };
}

async function loginUser(payload) {
  const { email, password } = validateCredentials(payload);
  const normalizedEmail = normalizeEmail(email);

  const user = await User.findOne({
    where: { email: normalizedEmail },
  });

  if (!user) {
    throw createHttpError(401, 'Invalid email or password');
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatches) {
    throw createHttpError(401, 'Invalid email or password');
  }

  return {
    token: signToken(user.id),
    user: serializeUser(user),
  };
}

function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, jwtSecret, { expiresIn: '7d' });
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    created_at: user.created_at || user.createdAt,
  };
}

module.exports = {
  loginUser,
  signupUser,
};