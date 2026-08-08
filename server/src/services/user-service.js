const { User } = require('../db');

async function findUserById(userId) {
  const user = await User.findByPk(userId);
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    created_at: user.created_at || user.createdAt,
  };
}

module.exports = {
  findUserById,
};