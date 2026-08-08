const bcrypt = require('bcryptjs');
const { UniqueConstraintError } = require('sequelize');
const jwt = require('jsonwebtoken');

const { User } = require('../db');
const { createHttpError } = require('../utils/http-error');
const { normalizeEmail, validateCredentials } = require('../utils/validators');

const { OAuth2Client } = require('google-auth-library');
const jwtSecret = process.env.JWT_SECRET;

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID
);
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
async function googleLogin(credential) {
  if (!credential) {
    throw createHttpError(400, 'Google credential is required');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  const googleId = payload.sub;
  const email = payload.email;
  const emailVerified = payload.email_verified;

  if (!email || !emailVerified) {
    throw createHttpError(401, 'Google email is not verified');
  }

  const normalizedEmail = normalizeEmail(email);

  // Find existing account
  let user = await User.findOne({
    where: {
      email: normalizedEmail,
    },
  });

  // Create account if it doesn't exist
  if (!user) {
    // Google users don't provide a password.
    // Generate an unusable random password hash so the
    // existing database structure continues to work.
    const randomPassword = `${googleId}-${Date.now()}-${Math.random()}`;
    const passwordHash = await bcrypt.hash(randomPassword, 12);

    try {
      user = await User.create({
        email: normalizedEmail,
        passwordHash,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        user = await User.findOne({
          where: {
            email: normalizedEmail,
          },
        });
      } else {
        throw error;
      }
    }
  }

  return {
    token: signToken(user.id),
    user: serializeUser(user),
  };
}
module.exports = {
  loginUser,
  signupUser,
  googleLogin,
};