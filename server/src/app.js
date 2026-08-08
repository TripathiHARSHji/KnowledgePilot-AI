const path = require('path');
const compression = require('compression');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const busboy = require('busboy');

const { authMiddleware } = require('./middleware/auth');
const { loginUser, signupUser } = require('./services/auth-service');
const { getHealthSnapshot } = require('./services/health-service');

const {
    deleteDocumentForUser,
    listDocumentsForUser,
    reindexDocumentForUser,
    uploadDocument,
} = require('./services/document-service');

const {
    createSessionId,
    deleteSessionForUser,
    queryDocuments,
    assembleContext,
    ensureAnswerReferences,
    generateAnswer,
    loadSessionHistory,
    persistSessionTurn,
} = require('./services/query-service');

const {
    listChatSessions,
    getChatMessages,
    appendChatTurn,
    deleteChatSession,
} = require('./services/chat-history-service');


function createSyntheticFile(payload, fallbackName) {
    if (typeof payload === 'string') {
        const buffer = Buffer.from(payload, 'utf8');

        return {
            buffer,
            originalname: fallbackName || 'upload.txt',
            mimetype: 'text/plain',
            size: buffer.length,
        };
    }

    if (Buffer.isBuffer(payload)) {
        return {
            buffer: payload,
            originalname: fallbackName || 'upload.bin',
            mimetype: 'application/octet-stream',
            size: payload.length,
        };
    }

    if (payload && typeof payload === 'object') {
        if (Buffer.isBuffer(payload.buffer)) {
            return {
                buffer: payload.buffer,
                originalname:
                    payload.originalname ||
                    fallbackName ||
                    'upload.bin',
                mimetype:
                    payload.mimetype ||
                    'application/octet-stream',
                size: payload.buffer.length,
            };
        }

        if (typeof payload.base64 === 'string') {
            const buffer = Buffer.from(
                payload.base64,
                'base64'
            );

            return {
                buffer,
                originalname:
                    payload.originalname ||
                    fallbackName ||
                    'upload.bin',
                mimetype:
                    payload.mimetype ||
                    'application/octet-stream',
                size: buffer.length,
            };
        }
    }

    return null;
}


function getUploadedFile(request) {
    const payload =
        request.body?.file ||
        request.body?.document ||
        request.body?.upload ||
        request.body;

    if (!payload) {
        return null;
    }

    if (
        typeof payload === 'string' ||
        Buffer.isBuffer(payload) ||
        (payload && typeof payload === 'object')
    ) {
        return createSyntheticFile(
            payload,
            'upload.txt'
        );
    }

    return null;
}


function resolveBusboyFileInfo(
    fileInfoOrFilename,
    maybeEncoding,
    maybeMimeType
) {
    if (
        fileInfoOrFilename &&
        typeof fileInfoOrFilename === 'object'
    ) {
        return {
            filename: fileInfoOrFilename.filename,
            mimetype:
                fileInfoOrFilename.mimeType ||
                fileInfoOrFilename.mimetype,
        };
    }

    return {
        filename:
            typeof fileInfoOrFilename === 'string'
                ? fileInfoOrFilename
                : undefined,
        mimetype:
            maybeMimeType || maybeEncoding,
    };
}


function parseMultipartUpload(request) {
    return new Promise((resolve, reject) => {
        const contentType =
            request.headers['content-type'] || '';

        if (
            !contentType.includes(
                'multipart/form-data'
            )
        ) {
            resolve(getUploadedFile(request));
            return;
        }

        const parser = busboy({
            headers: request.headers,
        });

        let parsedFile = null;

        parser.on(
            'file',
            (
                _fieldName,
                stream,
                infoOrFilename,
                encoding,
                mimeType
            ) => {
                const fileBuffer = [];

                const {
                    filename,
                    mimetype,
                } = resolveBusboyFileInfo(
                    infoOrFilename,
                    encoding,
                    mimeType
                );

                stream.on('data', (chunk) => {
                    fileBuffer.push(chunk);
                });

                stream.on('end', () => {
                    if (!parsedFile) {
                        const buffer =
                            Buffer.concat(
                                fileBuffer
                            );

                        parsedFile = {
                            buffer,
                            originalname:
                                filename ||
                                'upload.bin',
                            mimetype:
                                mimetype ||
                                'application/octet-stream',
                            size: buffer.length,
                        };
                    }
                });
            }
        );

        parser.on('finish', () => {
            resolve(
                parsedFile ||
                getUploadedFile(request)
            );
        });

        parser.on('error', reject);

        request.pipe(parser);
    });
}


function buildApp() {
    const app = express();

    // Middleware
    app.use(helmet());
    app.use(compression());

    app.use(
        cors({
            origin:
                process.env.CORS_ORIGIN ||
                'http://localhost:5173',
        })
    );

    app.use(
        express.json({
            limit: '1mb',
        })
    );

    app.use(
        express.urlencoded({
            extended: true,
            limit: '1mb',
        })
    );

    app.use(morgan('dev'));


    // Health
    app.get(
        '/health',
        async (_request, response, next) => {
            try {
                const snapshot =
                    await getHealthSnapshot();

                response.json(snapshot);
            } catch (error) {
                next(error);
            }
        }
    );


    // Authentication
    app.post(
        '/auth/signup',
        async (request, response, next) => {
            try {
                const result =
                    await signupUser(
                        request.body
                    );

                response
                    .status(201)
                    .json(result);
            } catch (error) {
                next(error);
            }
        }
    );


    app.post(
        '/auth/login',
        async (request, response, next) => {
            try {
                const result =
                    await loginUser(
                        request.body
                    );

                response.json(result);
            } catch (error) {
                next(error);
            }
        }
    );


    // Current user
    app.get(
        '/me',
        authMiddleware,
        (request, response) => {
            response.json({
                user: {
                    id: request.user.id,
                    email: request.user.email,
                },
            });
        }
    );


    // Documents
    app.post(
        '/documents/upload',
        authMiddleware,
        async (request, response, next) => {
            try {
                const uploadedFile =
                    await parseMultipartUpload(
                        request
                    );

                const result =
                    await uploadDocument(
                        request.user.id,
                        uploadedFile
                    );

                response
                    .status(201)
                    .json(result);
            } catch (error) {
                next(error);
            }
        }
    );


    app.get(
        '/documents',
        authMiddleware,
        async (request, response, next) => {
            try {
                const documents =
                    await listDocumentsForUser(
                        request.user.id
                    );

                response.json({
                    documents,
                });
            } catch (error) {
                next(error);
            }
        }
    );


    app.delete(
        '/documents/:documentId',
        authMiddleware,
        async (request, response, next) => {
            try {
                const result =
                    await deleteDocumentForUser(
                        request.user.id,
                        request.params.documentId
                    );

                response.json(result);
            } catch (error) {
                next(error);
            }
        }
    );


    app.post(
        '/documents/:documentId/reindex',
        authMiddleware,
        async (request, response, next) => {
            try {
                const result =
                    await reindexDocumentForUser(
                        request.user.id,
                        request.params.documentId
                    );

                response.json(result);
            } catch (error) {
                next(error);
            }
        }
    );


    // Chat sessions
    app.get(
        '/sessions',
        authMiddleware,
        async (request, response, next) => {
            try {
                const sessions =
                    await listChatSessions(
                        request.user.id
                    );

                response.json({
                    sessions,
                });
            } catch (error) {
                next(error);
            }
        }
    );


    app.get(
        '/sessions/:sessionId/messages',
        authMiddleware,
        async (request, response, next) => {
            try {
                const history =
                    await getChatMessages(
                        request.user.id,
                        request.params.sessionId
                    );

                response.json({
                    sessionId:
                        request.params.sessionId,
                    messages: history,
                });
            } catch (error) {
                next(error);
            }
        }
    );


    app.delete(
        '/sessions/:sessionId',
        authMiddleware,
        async (request, response, next) => {
            try {
                await Promise.all([
                    deleteSessionForUser(
                        request.user.id,
                        request.params.sessionId
                    ),

                    deleteChatSession(
                        request.user.id,
                        request.params.sessionId
                    ),
                ]);

                response
                    .status(204)
                    .send();
            } catch (error) {
                next(error);
            }
        }
    );


    // RAG Query
    app.post(
        '/query',
        authMiddleware,
        async (request, response, next) => {
            try {
                const {
                    question,
                    topK,
                    documentId,
                    sessionId,
                } = request.body || {};

                if (
                    !question ||
                    typeof question !== 'string'
                ) {
                    throw new Error(
                        'A text question is required'
                    );
                }

                if (
                    sessionId != null &&
                    typeof sessionId !== 'string'
                ) {
                    throw new Error(
                        'sessionId must be a string when provided'
                    );
                }

                const resolvedSessionId =
                    sessionId ||
                    createSessionId();

                const result =
                    await queryDocuments(
                        request.user.id,
                        question,
                        {
                            topK,
                            documentId,
                        }
                    );

                const context =
                    assembleContext(
                        result.chunks || []
                    );

                const history =
                    await loadSessionHistory(
                        request.user.id,
                        resolvedSessionId
                    );

                console.debug(
                    'RAG: retrieved sources count=',
                    (result.chunks || []).length
                );

                const answer =
                    await generateAnswer(
                        question,
                        context,
                        {
                            maxOutputTokens: 512,
                            history,
                        }
                    );

                const answerWithReferences =
                    ensureAnswerReferences(
                        answer,
                        result.chunks || []
                    );

                await Promise.all([
                    persistSessionTurn(
                        request.user.id,
                        resolvedSessionId,
                        question,
                        answerWithReferences
                    ),

                    appendChatTurn(
                        request.user.id,
                        resolvedSessionId,
                        question,
                        answerWithReferences
                    ).catch((error) => {
                        console.error(
                            'Failed to persist chat turn to Postgres',
                            error
                        );
                    }),
                ]);

                console.info(
                    'RAG: sources=',
                    (result.chunks || []).map(
                        (c) => ({
                            id: c.id,
                            position:
                                c.metadata
                                    ?.position,
                        })
                    )
                );

                response.json({
                    question,
                    embeddingModel:
                        result.embeddingModel,
                    retrievedCount:
                        (
                            result.chunks ||
                            []
                        ).length,
                    context,
                    sources:
                        result.chunks || [],
                    session: {
                        id:
                            resolvedSessionId,
                        memoryTurnCount:
                            history.length,
                    },
                    answer:
                        answerWithReferences,
                });
            } catch (error) {
                next(error);
            }
        }
    );


    // ==========================================
    // React Frontend
    // ==========================================

    const clientPath = path.join(
        __dirname,
        '../../client/dist'
    );

    // Serve React static files
    app.use(
        express.static(clientPath)
    );

    // React SPA fallback
    app.get(
        '/{*splat}',
        (_request, response) => {
            response.sendFile(
                path.join(
                    clientPath,
                    'index.html'
                )
            );
        }
    );


    // ==========================================
    // Error Handler
    // ==========================================

    app.use(
        (
            error,
            _request,
            response,
            _next
        ) => {
            const statusCode =
                error.statusCode || 500;

            const payload = {
                error:
                    error.message ||
                    'Internal server error',
            };

            if (
                process.env.NODE_ENV !==
                    'production' &&
                error.details
            ) {
                payload.details =
                    error.details;
            }

            response
                .status(statusCode)
                .json(payload);
        }
    );


    return app;
}


module.exports = {
    buildApp,
};