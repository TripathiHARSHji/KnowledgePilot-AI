const path = require('path');
const pdfParseModule = require('pdf-parse');
const mammoth = require('mammoth');

const { Chunk, Document, sequelize } = require('../db');
const { createHttpError } = require('../utils/http-error');

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 768);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';
const GEMINI_EMBEDDING_URL =
  process.env.GEMINI_EMBEDDING_URL ||
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent`;
const EMBEDDING_FALLBACK =
  String(process.env.EMBEDDING_FALLBACK || 'local-hash').trim().toLowerCase() !== 'none';
const pdfParse =
  typeof pdfParseModule === 'function' ? pdfParseModule : pdfParseModule?.default;
const PDFParseClass =
  typeof pdfParseModule?.PDFParse === 'function' ? pdfParseModule.PDFParse : null;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.pdf', '.docx']);
const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const MIME_TO_EXTENSION = {
  'text/plain': '.txt',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

function validateUpload(file) {
  if (!file) {
    throw createHttpError(400, 'A file is required');
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw createHttpError(413, 'File is too large. Maximum size is 10MB');
  }

  const extension = path.extname(file.originalname || '').toLowerCase();
  const mimeType = String(file.mimetype || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const effectiveExtension = extension || MIME_TO_EXTENSION[mimeType] || '';

  if (!ALLOWED_EXTENSIONS.has(effectiveExtension) && !ALLOWED_MIME_TYPES.has(mimeType)) {
    throw createHttpError(400, 'Unsupported file type. Please upload a PDF, DOCX, or TXT file');
  }

  return { extension: effectiveExtension, mimeType };
}

function normalizeText(text) {
  const normalized = text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^page\s+\d+(\s+of\s+\d+)?$/i.test(line))
    .filter((line) => !/^\d+\s*\/\s*\d+$/.test(line))
    .filter((line) => !/^[-_\s]{6,}$/.test(line));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractText(fileBuffer, extension) {
  if (extension === '.pdf') {
    if (typeof pdfParse === 'function') {
      const parsed = await pdfParse(fileBuffer);
      return normalizeText(parsed.text || '');
    }

    if (PDFParseClass) {
      const parser = new PDFParseClass({ data: fileBuffer });
      try {
        const parsed = await parser.getText();
        return normalizeText(parsed.text || '');
      } finally {
        await parser.destroy().catch(() => {});
      }
    }

    throw createHttpError(500, 'PDF parser is not available on this server build');
  }

  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return normalizeText(result.value || '');
  }

  return normalizeText(fileBuffer.toString('utf8'));
}

function chunkText(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const targetWords = 120;
  const overlapWords = 20;
  const chunks = [];

  for (let index = 0; index < words.length; index += targetWords - overlapWords) {
    const slice = words.slice(index, index + targetWords);
    if (!slice.length) {
      break;
    }

    const chunkText = slice.join(' ');
    if (chunkText.trim()) {
      chunks.push(chunkText);
    }
  }

  return chunks;
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

function simpleHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

async function uploadDocument(userId, file) {
  const { extension } = validateUpload(file);
  const extractedText = await extractText(file.buffer, extension);

  if (!extractedText) {
    throw createHttpError(400, 'No text could be extracted from the uploaded file');
  }

  const chunks = chunkText(extractedText);
  if (!chunks.length) {
    throw createHttpError(400, 'The uploaded file did not produce usable content');
  }

  const transaction = await sequelize.transaction();

  try {
    const document = await Document.create(
      {
        userId,
        filename: file.originalname,
        status: 'processing',
      },
      { transaction }
    );

    const chunkPayload = await Promise.all(chunks.map(async (chunkContent, index) => {
      const embedding = await buildEmbedding(chunkContent);
      return {
        documentId: document.id,
        userId,
        content: chunkContent,
        metadata: {
          position: index + 1,
          chunkSize: chunkContent.length,
          embedding: embedding.values,
          embeddingModel: embedding.model,
        },
        embeddingId: `local-${document.id}-${index + 1}`,
        vectorRef: `local-hash:${document.id}:${index + 1}`,
      };
    }));

    const createdChunks = await Chunk.bulkCreate(chunkPayload, { transaction, returning: true });
    await Promise.all(
      createdChunks.map((chunk, index) =>
        sequelize.query(
          'UPDATE chunks SET embedding_vector = CAST(:embeddingVector AS vector) WHERE id = :id',
          {
            transaction,
            replacements: {
              id: chunk.id,
              embeddingVector: toPgVectorLiteral(chunkPayload[index].metadata.embedding),
            },
          }
        )
      )
    );
    await Document.update(
      { status: 'ready' },
      { where: { id: document.id }, transaction }
    );

    await transaction.commit();

    return {
      document: {
        id: document.id,
        filename: document.filename,
        status: 'ready',
        uploaded_at: document.uploaded_at || document.createdAt,
      },
      chunkCount: chunkPayload.length,
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function listDocumentsForUser(userId) {
  const documents = await Document.findAll({
    where: { userId },
    order: [['uploaded_at', 'DESC']],
  });

  return documents.map((document) => ({
    id: document.id,
    filename: document.filename,
    status: document.status,
    uploaded_at: document.uploaded_at || document.createdAt,
  }));
}

module.exports = {
  listDocumentsForUser,
  uploadDocument,
};
