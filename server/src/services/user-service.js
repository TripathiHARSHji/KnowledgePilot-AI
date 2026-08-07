const { query } = require('../db');

async function findUserById(userId) {
  const result = await query(
    'SELECT id, email, created_at FROM users WHERE id = $1',
    [userId]
  );

  return result.rows[0] || null;
}

module.exports = {
  findUserById,
};