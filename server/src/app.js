const compression = require('compression');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { authMiddleware } = require('./middleware/auth');
const { loginUser, signupUser } = require('./services/auth-service');
const { getHealthSnapshot } = require('./services/health-service');

function buildApp() {
  const app = express();

  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('dev'));

  app.get('/health', async (_request, response, next) => {
    try {
      const snapshot = await getHealthSnapshot();
      response.json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/signup', async (request, response, next) => {
    try {
      const result = await signupUser(request.body);
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/login', async (request, response, next) => {
    try {
      const result = await loginUser(request.body);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get('/me', authMiddleware, (request, response) => {
    response.json({
      user: {
        id: request.user.id,
        email: request.user.email,
      },
    });
  });

  app.use((error, _request, response, _next) => {
    const statusCode = error.statusCode || 500;
    const payload = {
      error: error.message || 'Internal server error',
    };

    if (process.env.NODE_ENV !== 'production' && error.details) {
      payload.details = error.details;
    }

    response.status(statusCode).json(payload);
  });

  return app;
}

module.exports = {
  buildApp,
};