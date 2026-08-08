const { sequelize, ChatSession, ChatMessage } = require('../db');
const { createHttpError } = require('../utils/http-error');

const SESSION_LIST_MAX = Number(process.env.SESSION_INDEX_MAX || 30);

function normalizeExternalId(externalId) {
  const normalized = String(externalId || '').trim();
  if (!normalized) {
    throw createHttpError(400, 'sessionId is required');
  }

  return normalized;
}

async function ensureChatSession(userId, externalId) {
  const normalized = normalizeExternalId(externalId);
  const [session] = await ChatSession.findOrCreate({
    where: { userId, externalId: normalized },
    defaults: { userId, externalId: normalized },
  });

  return session;
}

async function appendChatTurn(userId, externalId, question, answer) {
  const session = await ensureChatSession(userId, externalId);

  await ChatMessage.bulkCreate([
    { sessionId: session.id, role: 'user', content: question },
    { sessionId: session.id, role: 'assistant', content: answer },
  ]);

  return session;
}

async function listChatSessions(userId, limit = SESSION_LIST_MAX) {
  const cappedLimit = Math.min(Math.max(Number(limit) || SESSION_LIST_MAX, 1), SESSION_LIST_MAX);

  const rows = await sequelize.query(
    `SELECT cs.external_id AS "externalId",
            cs.created_at AS "createdAt",
            latest.content AS preview,
            latest.created_at AS "updatedAt",
            COALESCE(counts.turn_count, 0) AS "turnCount"
       FROM chat_sessions cs
       LEFT JOIN LATERAL (
         SELECT content, created_at
           FROM chat_messages
          WHERE session_id = cs.id AND role = 'user'
          ORDER BY created_at DESC
          LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS turn_count
           FROM chat_messages
          WHERE session_id = cs.id AND role = 'user'
       ) counts ON true
      WHERE cs.user_id = :userId
      ORDER BY COALESCE(latest.created_at, cs.created_at) DESC
      LIMIT :limit`,
    {
      replacements: { userId, limit: cappedLimit },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  return rows.map((row) => ({
    id: row.externalId,
    preview: row.preview || 'New conversation',
    updatedAt: row.updatedAt || row.createdAt,
    turnCount: row.turnCount || 0,
  }));
}

async function getChatMessages(userId, externalId) {
  const normalized = normalizeExternalId(externalId);
  const session = await ChatSession.findOne({ where: { userId, externalId: normalized } });
  if (!session) {
    return [];
  }

  const messages = await ChatMessage.findAll({
    where: { sessionId: session.id },
    order: [['created_at', 'ASC']],
  });

  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    createdAt: message.created_at || message.createdAt,
  }));
}

async function deleteChatSession(userId, externalId) {
  const normalized = normalizeExternalId(externalId);
  const session = await ChatSession.findOne({ where: { userId, externalId: normalized } });
  if (!session) {
    return;
  }

  await ChatMessage.destroy({ where: { sessionId: session.id } });
  await ChatSession.destroy({ where: { id: session.id } });
}

module.exports = {
  ensureChatSession,
  appendChatTurn,
  listChatSessions,
  getChatMessages,
  deleteChatSession,
};
