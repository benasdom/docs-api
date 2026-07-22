// server.js - Full-text search API for your documentation
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const Fuse = require('fuse.js');
const natural = require('natural');

// ============================================
// 0. CONFIG
// ============================================
const PORT = parseInt(process.env.PORT, 10) || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DOCS_PATH = process.env.DOCS_PATH || path.join(__dirname, 'ue-repositories-docs.json');
const MAX_LIMIT = 100; // hard ceiling regardless of what a client requests
const DEFAULT_LIMIT = 50;

// Comma-separated list of allowed origins, e.g. "https://docs.example.com,https://app.example.com"
// If unset, CORS is disabled (same-origin only) rather than defaulting to wide open "*" in production.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// ============================================
// 1. LOAD DOCUMENTATION DATA (fail fast, with a clear error)
// ============================================
let documentation;
try {
  const raw = fs.readFileSync(DOCS_PATH, 'utf8');
  documentation = JSON.parse(raw);
  if (!documentation || !Array.isArray(documentation.repositories)) {
    throw new Error('Expected documentation JSON to contain a "repositories" array');
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`❌ Failed to load documentation data from ${DOCS_PATH}:`, err.message);
  process.exit(1);
}

// ============================================
// 2. SEARCH ENGINE (FUSE.JS)
// ============================================
class DocumentationSearch {
  constructor(data) {
    this.documents = this.flattenDocumentation(data);
    this.fuse = new Fuse(this.documents, {
      keys: [
        { name: 'name', weight: 0.3 },
        { name: 'description', weight: 0.25 },
        { name: 'overview', weight: 0.2 },
        { name: 'keyFeatures', weight: 0.15 },
        { name: 'techStack', weight: 0.1 },
        { name: 'fullName', weight: 0.05 }
      ],
      threshold: 0.3,
      includeScore: true,
      includeMatches: true,
      minMatchCharLength: 2
    });
  }

  flattenDocumentation(data) {
    const results = [];

    data.repositories.forEach(repo => {
      results.push({
        id: repo.name,
        type: 'repository',
        name: repo.name,
        fullName: repo.fullName,
        description: repo.description,
        language: repo.language,
        topics: repo.topics,
        overview: repo.documentation?.overview || '',
        keyFeatures: repo.documentation?.keyFeatures?.join(', ') || '',
        techStack: JSON.stringify(repo.documentation?.techStack || {}),
        productLine: repo.productLine,
        lastUpdated: repo.lastUpdated,
        visibility: repo.visibility
      });

      if (repo.documentation?.apiEndpoints) {
        Object.entries(repo.documentation.apiEndpoints).forEach(([key, value]) => {
          results.push({
            id: `${repo.name}-api-${key}`,
            type: 'api-endpoint',
            name: key,
            description: value,
            parentRepo: repo.name,
            fullName: `${repo.name} - API Endpoint`
          });
        });
      }
    });

    return results;
  }

  search(query, filters = {}) {
    const results = this.fuse.search(query);
    let filtered = results.map(r => r.item);

    if (filters.type) {
      filtered = filtered.filter(item => item.type === filters.type);
    }
    if (filters.language) {
      filtered = filtered.filter(item => item.language === filters.language);
    }
    if (filters.productLine) {
      filtered = filtered.filter(item => item.productLine === filters.productLine);
    }

    const limit = clampLimit(filters.limit);

    return {
      query,
      totalResults: filtered.length,
      results: filtered.slice(0, limit),
      filters: { ...filters, limit }
    };
  }
}

function clampLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// Small helper so every async route handler doesn't need its own try/catch
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const searchEngine = new DocumentationSearch(documentation);

// ============================================
// 3. APP + MIDDLEWARE
// ============================================
const app = express();

// Behind a reverse proxy (Heroku, Render, nginx, etc.) so rate limiting and
// req.ip work correctly. Set TRUST_PROXY=1 (or a specific value) via env.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY);
}

app.use(helmet());
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use(
  cors(
    ALLOWED_ORIGINS.length > 0
      ? { origin: ALLOWED_ORIGINS }
      : { origin: false } // same-origin only if no allowlist is configured
  )
);

// Reject oversized/malformed JSON bodies instead of crashing the process
app.use(express.json({ limit: '100kb' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Invalid or oversized request body' });
  }
  next(err);
});

// Basic rate limiting — tune per your traffic profile
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', apiLimiter);

// ============================================
// 4. ROUTES
// ============================================

// Health check for load balancers / uptime monitors
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: process.uptime() });
});

// Full-text search endpoint
app.get(
  '/api/search',
  asyncHandler(async (req, res) => {
    const { q, type, language, productLine, limit } = req.query;

    if (typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({
        error: 'Search query must be at least 2 characters'
      });
    }

    const results = searchEngine.search(q.trim(), {
      type,
      language,
      productLine,
      limit
    });

    res.json(results);
  })
);

// Get all repositories (paginated so a large dataset can't blow up a response)
app.get(
  '/api/repositories',
  asyncHandler(async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const page = documentation.repositories.slice(offset, offset + limit);

    res.json({
      total: documentation.repositories.length,
      limit,
      offset,
      results: page
    });
  })
);

// Get specific repository
app.get(
  '/api/repositories/:name',
  asyncHandler(async (req, res) => {
    const repo = documentation.repositories.find(r => r.name === req.params.name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    res.json(repo);
  })
);

// Get repository statistics
app.get(
  '/api/stats',
  asyncHandler(async (req, res) => {
    res.json({
      totalRepositories: documentation.repositories.length,
      totalStars: documentation.repositories.reduce((sum, r) => sum + (r.stars || 0), 0),
      languages: [...new Set(documentation.repositories.map(r => r.language).filter(Boolean))],
      productLines: documentation.repositories.map(r => r.productLine),
      lastUpdated: documentation.lastUpdated
    });
  })
);

// Advanced search with basic NLP tokenization
app.get(
  '/api/search/advanced',
  asyncHandler(async (req, res) => {
    const { q, type, language, productLine, topics, sortBy } = req.query;

    // Always work on a copy — never mutate documentation.repositories
    let results = [...documentation.repositories];

    if (type) {
      results = results.filter(r => r.type === type);
    }
    if (language) {
      results = results.filter(r => r.language === language);
    }
    if (productLine) {
      results = results.filter(r => r.productLine === productLine);
    }
    if (topics) {
      const topicList = topics.split(',').map(t => t.trim()).filter(Boolean);
      results = results.filter(r => r.topics?.some(t => topicList.includes(t)) ?? false);
    }

    if (typeof q === 'string' && q.trim().length > 0) {
      const tokenizer = new natural.WordTokenizer();
      const queryTokens = tokenizer.tokenize(q.toLowerCase());

      results = results.filter(r => {
        const searchText = `${r.name} ${r.description} ${r.documentation?.overview || ''}`.toLowerCase();
        return queryTokens.some(token => searchText.includes(token));
      });
    }

    if (sortBy === 'stars') {
      results.sort((a, b) => (b.stars || 0) - (a.stars || 0));
    } else if (sortBy === 'updated') {
      results.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
    }

    const limit = clampLimit(req.query.limit);

    res.json({
      query: q || 'all',
      totalResults: results.length,
      results: results.slice(0, limit)
    });
  })
);

// ============================================
// 5. 404 + ERROR HANDLING (must be registered last)
// ============================================
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ============================================
// 6. START SERVER + GRACEFUL SHUTDOWN
// ============================================
const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`📚 Documentation Search API running on port ${PORT} [${NODE_ENV}]`);
  // eslint-disable-next-line no-console
  console.log(`🔍 Search endpoint: http://localhost:${PORT}/api/search?q=your-query`);
});

function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`${signal} received: closing server gracefully`);
  server.close(err => {
    if (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
    process.exit(0);
  });
  // Force-exit if connections don't close in time
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

module.exports = app; // exported for testing (e.g. supertest)
