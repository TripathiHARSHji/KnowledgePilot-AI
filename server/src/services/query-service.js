const { Chunk, sequelize } = require('../db');
const { createHttpError } = require('../utils/http-error');

const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 768);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';
const GEMINI_EMBEDDING_URL =
  process.env.GEMINI_EMBEDDING_URL ||
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent`;
const EMBEDDING_FALLBACK =
  String(process.env.EMBEDDING_FALLBACK || 'local-hash').trim().toLowerCase() !== 'none';

function simpleHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function buildLocalEmbedding(text, dimensions = EMBEDDING_DIMENSIONS) {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const values = Array.from({ length: dimensions }, () => 0);

  tokens.forEach((token) => {
    const hash = simpleHash(token);
    const index = hash % dimensions;
    values[index] += 1;
  });

  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return values;
  }

  return values.map((value) => Number((value / magnitude).toFixed(6)));
}

function normalizeEmbedding(values, dimensions = EMBEDDING_DIMENSIONS) {
  const numericValues = Array.isArray(values)
    ? values.map((value) => Number(value) || 0)
    : [];

  if (numericValues.length >= dimensions) {
    return numericValues.slice(0, dimensions);
  }

  return numericValues.concat(Array.from({ length: dimensions - numericValues.length }, () => 0));
}

function toPgVectorLiteral(values) {
  return `[${values.join(',')}]`;
}

async function buildGeminiEmbedding(text) {
  const response = await fetch(`${GEMINI_EMBEDDING_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: {
        parts: [{ text }],
      },
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini embedding request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  return normalizeEmbedding(payload?.embedding?.values);
}

async function buildEmbedding(text) {
  if (!GEMINI_API_KEY) {
    return {
      values: buildLocalEmbedding(text),
      model: 'local-hash',
    };
  }

  try {
    const values = await buildGeminiEmbedding(text);
    return {
      values,
      model: `gemini:${GEMINI_EMBEDDING_MODEL}`,
    };
  } catch (error) {
    if (!EMBEDDING_FALLBACK) {
      throw createHttpError(502, 'Failed to generate embeddings from Gemini API', {
        cause: error.message,
      });
    }

    return {
      values: buildLocalEmbedding(text),
      model: 'local-hash',
    };
  }
}

async function queryDocuments(userId, text, options = {}) {
  const topK = Number(options.topK || 4);
  const embedding = await buildEmbedding(text);
  const literal = toPgVectorLiteral(embedding.values);

  const rows = await sequelize.query(
    'SELECT id, content, metadata FROM chunks WHERE user_id = :userId ORDER BY embedding_vector <-> CAST(:q AS vector) LIMIT :limit',
    {
      replacements: {
        userId,
        q: literal,
        limit: topK,
      },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  return {
    embeddingModel: embedding.model,
    chunks: rows,
  };
}

function assembleContext(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';

  return chunks
    .map((chunk, index) => `SOURCE ${index + 1}: ${chunk.metadata?.position || ''}\n${chunk.content}`)
    .join('\n\n---\n\n');
}

const GEMINI_LLM_MODEL = process.env.GEMINI_LLM_MODEL || 'chat-bison-001';
const GEMINI_LLM_URL =
  process.env.GEMINI_LLM_URL ||
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_LLM_MODEL}:generate`;

async function buildGeminiGeneration(prompt, options = {}) {
  const body = {
    prompt: { text: prompt },
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
    maxOutputTokens: options.maxOutputTokens || 512,
  };

  const response = await fetch(`${GEMINI_LLM_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Gemini generation failed (${response.status}): ${bodyText}`);
  }

  const payload = await response.json();
  // Attempt to extract text from payload
  const candidates = payload?.candidates || payload?.outputs || [];
  if (Array.isArray(candidates) && candidates.length > 0) {
    // Some payload formats have `candidates[0].output` or `candidates[0].content` or `candidates[0].text`
    const first = candidates[0];
    return (
      first.output || first.content || first.text || (typeof first === 'string' ? first : '')
    );
  }

  // Fallback: try top-level `output` or `content`
  return payload?.output || payload?.content || '';
}

async function generateAnswer(question, context, options = {}) {
  const system = options.system ||
    'You are a helpful assistant. Answer concisely using only the provided sources. When referencing information, cite the source like "(SOURCE 1)".';

  const prompt = `${system}\n\nCONTEXT:\n${context}\n\nQUESTION:\n${question}\n\nAnswer:`;

  try {
    if (!GEMINI_API_KEY) {
      // No external LLM key - return a safe local fallback that includes retrieved context
      return `No LLM key configured. Retrieved context:\n\n${context}`;
    }

    const text = await buildGeminiGeneration(prompt, options);
    return String(text || '').trim();
  } catch (error) {
    // On failure, return the context as a fallback and include error in details
    return `Error generating answer: ${error.message}. Retrieved context:\n\n${context}`;
  }
}

module.exports = {
  queryDocuments,
  assembleContext,
  generateAnswer,
};
