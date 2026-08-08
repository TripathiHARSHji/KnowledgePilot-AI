const { Sequelize, DataTypes, Model } = require('sequelize');

const connectionString = process.env.DATABASE_URL;
const embeddingDimensions = Number(process.env.EMBEDDING_DIMENSIONS || 768);

if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const sequelize = new Sequelize(connectionString, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: shouldUseSsl(connectionString)
    ? {
        ssl: {
          rejectUnauthorized: false,
        },
      }
    : undefined,
});

class User extends Model {}

User.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    email: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'password_hash',
    },
  },
  {
    sequelize,
    modelName: 'User',
    tableName: 'users',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  }
);

class Document extends Model {}

Document.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: 'user_id',
    },
    filename: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: 'processing',
    },
  },
  {
    sequelize,
    modelName: 'Document',
    tableName: 'documents',
    timestamps: true,
    createdAt: 'uploaded_at',
    updatedAt: false,
  }
);

class Chunk extends Model {}

Chunk.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    documentId: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: 'document_id',
    },
    userId: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: 'user_id',
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    embeddingId: {
      type: DataTypes.TEXT,
      field: 'embedding_id',
    },
    vectorRef: {
      type: DataTypes.TEXT,
      field: 'vector_ref',
    },
    embeddingVector: {
      type: DataTypes.TEXT,
      field: 'embedding_vector',
    },
  },
  {
    sequelize,
    modelName: 'Chunk',
    tableName: 'chunks',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  }
);

class ChatSession extends Model {}

ChatSession.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: 'user_id',
    },
    externalId: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'external_id',
    },
  },
  {
    sequelize,
    modelName: 'ChatSession',
    tableName: 'chat_sessions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  }
);

class ChatMessage extends Model {}

ChatMessage.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    sessionId: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: 'session_id',
    },
    role: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: 'ChatMessage',
    tableName: 'chat_messages',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  }
);

User.hasMany(Document, { foreignKey: 'userId' });
Document.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Chunk, { foreignKey: 'userId' });
Document.hasMany(Chunk, { foreignKey: 'documentId' });
Chunk.belongsTo(User, { foreignKey: 'userId' });
Chunk.belongsTo(Document, { foreignKey: 'documentId' });

User.hasMany(ChatSession, { foreignKey: 'userId' });
ChatSession.belongsTo(User, { foreignKey: 'userId' });

ChatSession.hasMany(ChatMessage, { foreignKey: 'sessionId' });
ChatMessage.belongsTo(ChatSession, { foreignKey: 'sessionId' });

async function initDatabase() {
  await sequelize.authenticate();
  await sequelize.query('CREATE EXTENSION IF NOT EXISTS vector;');
  await sequelize.sync();
  await sequelize.query(
    `ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_vector vector(${embeddingDimensions});`
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS chunks_embedding_vector_ivfflat_idx ON chunks USING ivfflat (embedding_vector vector_cosine_ops) WITH (lists = 100);'
  );
  await sequelize.query(
    'ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS external_id TEXT;'
  );
  await sequelize.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_user_external_idx ON chat_sessions (user_id, external_id);'
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON chat_messages (session_id, created_at);'
  );
}

async function closeDatabase() {
  await sequelize.close();
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === 'disable') {
    return false;
  }

  if (process.env.DATABASE_SSL === 'true') {
    return true;
  }

  return !databaseUrl.includes('localhost') && !databaseUrl.includes('@postgres:');
}

module.exports = {
  closeDatabase,
  initDatabase,
  sequelize,
  User,
  Document,
  Chunk,
  ChatSession,
  ChatMessage,
};