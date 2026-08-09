const { User } = require('../db');

async function findUserById(userId) {
  const user = await User.findByPk(userId);
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    // NEW: expose display name + avatar so the UI can show
    // "who you're logged in as" without a second round trip.
    name: user.name || null,
    avatarUrl: user.avatarUrl || null,
    created_at: user.created_at || user.createdAt,
  };
}

module.exports = {
  findUserById,
};