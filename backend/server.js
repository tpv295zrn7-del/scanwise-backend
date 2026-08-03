const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'scanwise.db');
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  : '*';

// CORS — explicit allowlist in production, wildcard in dev
app.use(
  cors({
    origin: ALLOWED_ORIGINS === '*' ? true : ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })
);
app.use(express.json({ limit: '10mb' }));

// Lightweight request log so we can see traffic in production
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// Database setup
const dbPath = DB_PATH;
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    barcode TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    brand TEXT,
    nutrition TEXT,
    ingredients TEXT,
    category_subtype TEXT,
    estimated_price REAL,
    confidence TEXT DEFAULT 'verified',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT NOT NULL,
    nutrition TEXT,
    source TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT,
    confidence TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed data — fetch from a URL on first boot so we don't need a copy
// step in the Dockerfile. The default URL is the team's published
// site; in production set SEED_URL to your own CDN/static host.
const SEED_URL = process.env.SEED_URL || 'https://8e6e9aa6adc696da46f425f555186f1b.ctonew.app/seed-data.json';
const insertProduct = db.prepare(`
  INSERT OR IGNORE INTO products (barcode, name, category, brand, nutrition, ingredients, category_subtype, estimated_price, confidence)
  VALUES (@barcode, @name, @category, @brand, @nutrition, @ingredients, @category_subtype, @estimated_price, @confidence)
`);
const seedFromArray = (products) => {
  const tx = db.transaction((arr) => {
    for (const p of arr) {
      insertProduct.run({
        barcode: p.barcode,
        name: p.name,
        category: p.category,
        brand: p.brand,
        nutrition: JSON.stringify(p.nutrition),
        ingredients: JSON.stringify(p.ingredients),
        category_subtype: p.category_subtype,
        estimated_price: p.estimated_price,
        confidence: p.confidence
      });
    }
  });
  tx(products);
  console.log(`Seeded ${products.length} products`);
};
const seedFromFile = (filePath) => {
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    seedFromArray(data);
    return true;
  }
  return false;
};
const seedFromUrl = async (url) => {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      console.warn(`Seed fetch returned ${res.status} from ${url}`);
      return false;
    }
    const data = await res.json();
    seedFromArray(data);
    return true;
  } catch (err) {
    console.warn(`Seed fetch failed: ${err.message}`);
    return false;
  }
};
const localSeedPath = path.join(__dirname, 'seed-data.json');
const count = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
if (count === 0) {
  // Try local file first (dev), then the URL (production).
  if (!seedFromFile(localSeedPath)) {
    seedFromUrl(SEED_URL).then((ok) => {
      if (!ok) console.warn('No seed data loaded; /api/alternatives will return empty until data is added.');
    });
  }
}

// Available categories in the seed data.
const SEED_CATEGORIES = ['cereal', 'drink', 'lunchbox', 'snack', 'yogurt'];

// Map verbose / Open Food Facts style category strings to a
// short, seed-compatible category. The matcher is case-insensitive
// and tries substrings in order; the first hit wins.
const CATEGORY_KEYWORDS = [
  { match: ['cereal', 'oat', 'granola', 'muesli'], category: 'cereal' },
  { match: ['yogurt', 'yoghurt', 'kefir', 'skyr'], category: 'yogurt' },
  { match: ['lunch', 'sandwich', 'wrap', 'pita'], category: 'lunchbox' },
  { match: ['juice', 'drink', 'beverage', 'soda', 'water', 'tea', 'kombucha'], category: 'drink' },
  { match: ['snack', 'chip', 'cracker', 'bar', 'cookie', 'fruit', 'nut'], category: 'snack' }
];
function normaliseCategory(raw) {
  if (!raw) return null;
  const haystack = String(raw).toLowerCase();
  // Already a seed category?
  if (SEED_CATEGORIES.includes(haystack)) return haystack;
  for (const { match, category } of CATEGORY_KEYWORDS) {
    if (match.some((kw) => haystack.includes(kw))) {
      return category;
    }
  }
  return null; // unknown — caller will get 404 with helpful message
}
// Available goals
const GOALS = [
  { id: 'lower_sugar', name: 'Lower Sugar', field: 'sugar_g', lower_is_better: true, weight: 1.0 },
  { id: 'higher_protein', name: 'Higher Protein', field: 'protein_g', lower_is_better: false, weight: 1.0 },
  { id: 'budget_friendly', name: 'Budget Friendly', field: 'estimated_price', lower_is_better: true, weight: 1.0 },
  { id: 'lower_sodium', name: 'Lower Sodium', field: 'sodium_mg', lower_is_better: true, weight: 1.0 },
  { id: 'higher_fiber', name: 'Higher Fiber', field: 'fiber_g', lower_is_better: false, weight: 1.0 },
  { id: 'lower_fat', name: 'Lower Fat', field: 'total_fat_g', lower_is_better: true, weight: 1.0 },
  { id: 'lower_calories', name: 'Lower Calories', field: 'calories', lower_is_better: true, weight: 1.0 },
];

// Helper: compute match score for a product against goals
function computeScore(product, goals) {
  let totalScore = 0;
  let totalWeight = 0;
  const nut = typeof product.nutrition === 'string' ? JSON.parse(product.nutrition) : product.nutrition;
  const price = product.estimated_price || 0;

  for (const goalId of goals) {
    const goal = GOALS.find(g => g.id === goalId);
    if (!goal) continue;

    let value;
    if (goal.field === 'estimated_price') {
      value = price;
    } else {
      value = nut[goal.field];
    }
    if (value === undefined || value === null) continue;

    // Normalize to 0-100 using a simple max-value scaling
    const maxVal = goal.field === 'estimated_price' ? 15 : 
                  goal.field === 'sugar_g' ? 40 :
                  goal.field === 'protein_g' ? 20 :
                  goal.field === 'sodium_mg' ? 1000 :
                  goal.field === 'fiber_g' ? 10 :
                  goal.field === 'total_fat_g' ? 30 :
                  goal.field === 'calories' ? 500 : 100;

    let score = Math.max(0, Math.min(100, (value / maxVal) * 100));
    if (goal.lower_is_better) score = 100 - score;

    totalScore += score * goal.weight;
    totalWeight += goal.weight;
  }

  return totalWeight > 0 ? Math.round(totalScore / totalWeight) : 50;
}

// ===== API Routes =====

// GET /api/goals
app.get('/api/goals', (req, res) => {
  res.json({ goals: GOALS });
});

// POST /api/scans
app.post('/api/scans', async (req, res) => {
  const { barcode, image } = req.body;
  if (!barcode && !image) {
    return res.status(400).json({ error: 'barcode or image required' });
  }

  // Look up by barcode (sync fast path)
  if (barcode && !image) {
    const product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
    if (product) {
      db.prepare('INSERT INTO scans (barcode, confidence) VALUES (?, ?)').run(barcode, product.confidence);
      return res.json({
        found: true,
        product: {
          ...product,
          nutrition: JSON.parse(product.nutrition),
          ingredients: JSON.parse(product.ingredients)
        },
        confidence: product.confidence,
        source: 'verified'
      });
    }
    return res.json({
      found: false,
      confidence: 'incomplete',
      message: 'Product not found in database'
    });
  }

  // If barcode provided, check DB first even with image
  if (barcode) {
    const product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
    if (product) {
      db.prepare('INSERT INTO scans (barcode, confidence) VALUES (?, ?)').run(barcode, product.confidence);
      return res.json({
        found: true,
        product: {
          ...product,
          nutrition: JSON.parse(product.nutrition),
          ingredients: JSON.parse(product.ingredients)
        },
        confidence: product.confidence,
        source: 'verified'
      });
    }
  }

  // If image provided, attempt OCR
  if (image) {
    try {
      const tesseract = require('tesseract.js');
      const buf = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const tmpPath = `/tmp/scan_${Date.now()}.png`;
      require('fs').writeFileSync(tmpPath, buf);

      const { data: { text } } = await tesseract.recognize(tmpPath, 'eng', { logger: m => {} });
      try { fs.unlinkSync(tmpPath); } catch(e) {}

      // Parse basic nutrition info from OCR text
      const estimated = extractNutritionFromText(text);

      if (barcode) {
        return res.json({
          found: true,
          product: {
            barcode,
            name: `Product ${barcode}`,
            category: 'unknown',
            brand: 'Unknown',
            nutrition: estimated,
            ingredients: [],
            category_subtype: 'unknown',
            estimated_price: null,
            confidence: 'estimated'
          },
          confidence: 'estimated',
          source: 'ocr',
          raw_text: text
        });
      }

      return res.json({
        found: false,
        message: 'No barcode provided, OCR attempted',
        estimated_nutrition: estimated,
        confidence: 'incomplete',
        source: 'ocr',
        raw_text: text
      });
    } catch (e) {
      return res.json({
        found: false,
        confidence: 'incomplete',
        source: 'ocr_failed',
        error: e.message
      });
    }
  }

  return res.json({
    found: false,
    confidence: 'incomplete',
    message: 'Product not found in database'
  });
});

// GET /api/products/:barcode
app.get('/api/products/:barcode', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(req.params.barcode);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json({
    ...product,
    nutrition: JSON.parse(product.nutrition),
    ingredients: JSON.parse(product.ingredients)
  });
});

// GET /api/alternatives?barcode=...&category=...&name=...&goals=lower_sugar
//   or
// POST /api/alternatives  body: { barcode, category, goals, name }
//
// Two ways the seed data is used:
//   1. Exact barcode match: a product we know about by its UPC.
//   2. Category fallback: a freshly-scanned product whose barcode
//      we don't have. The caller passes the category (and ideally
//      name) from Open Food Facts, and we recommend seed products
//      in the same category ranked against the caller's goals.
app.get('/api/alternatives', (req, res) => {
  const goals = req.query.goals ? String(req.query.goals).split(',') : ['lower_sugar'];
  return handleAlternatives({
    barcode: req.query.barcode,
    category: req.query.category,
    name: req.query.name,
    goals,
    res
  });
});
app.post('/api/alternatives', (req, res) => {
  const { barcode, category, name, goals } = req.body || {};
  return handleAlternatives({
    barcode,
    category,
    name,
    goals: Array.isArray(goals) && goals.length ? goals : ['lower_sugar'],
    res
  });
});
function handleAlternatives({ barcode, category, name, goals, res }) {
  let product = barcode
    ? db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode)
    : null;
  if (!product) {
    const normalised = normaliseCategory(category);
    if (!normalised) {
      return res.status(404).json({
        error: category
          ? 'Unknown category. Add it to CATEGORY_KEYWORDS in server.js to enable recommendations.'
          : 'Product not found in seed; pass ?category=... so we can fall back to category-based recommendations.',
        original_barcode: barcode || null,
        original_category: category || null
      });
    }
    product = {
      barcode: barcode || 'unknown-' + Date.now(),
      name: name || 'Scanned product',
      category: normalised,
      brand: null,
      nutrition: JSON.stringify({}),
      ingredients: JSON.stringify([]),
      category_subtype: null,
      estimated_price: null,
      confidence: 'unknown',
      is_virtual: 1
    };
  }
  const sameCategory = db.prepare('SELECT * FROM products WHERE category = ? AND barcode != ?').all(product.category, product.barcode);
  const scored = sameCategory.map(p => ({
    ...p,
    nutrition: JSON.parse(p.nutrition),
    ingredients: JSON.parse(p.ingredients),
    match_score: computeScore(p, goals),
    tradeoffs: computeTradeoffs(product, p, goals)
  }));
  scored.sort((a, b) => b.match_score - a.match_score);
  const top3 = scored.slice(0, 3);
  res.json({
    original_barcode: product.barcode,
    original_name: product.name,
    original_category: product.category,
    is_virtual: product.is_virtual === 1,
    goals,
    alternatives: top3,
    total_considered: sameCategory.length
  });
}

  scored.sort((a, b) => b.match_score - a.match_score);
  const top3 = scored.slice(0, 3);

  res.json({
    original_barcode: product.barcode,
    original_name: product.name,
   

function computeTradeoffs(original, alternative, goals) {
  const origNut = typeof original.nutrition === 'string' ? JSON.parse(original.nutrition) : original.nutrition;
  const altNut = typeof alternative.nutrition === 'string' ? JSON.parse(alternative.nutrition) : alternative.nutrition;
  const tradeoffs = [];

  for (const goalId of goals) {
    const goal = GOALS.find(g => g.id === goalId);
    if (!goal) continue;
    
    const origField = goal.field === 'estimated_price' ? original.estimated_price : origNut[goal.field];
    const altField = goal.field === 'estimated_price' ? alternative.estimated_price : altNut[goal.field];
    if (origField === undefined || altField === undefined || origField === 0) continue;

    const diff = ((altField - origField) / origField) * 100;
    const fieldLabel = goal.field === 'sugar_g' ? 'sugar' : 
                       goal.field === 'protein_g' ? 'protein' :
                       goal.field === 'sodium_mg' ? 'sodium' :
                       goal.field === 'fiber_g' ? 'fiber' :
                       goal.field === 'total_fat_g' ? 'fat' :
                       goal.field === 'calories' ? 'calories' :
                       goal.field === 'estimated_price' ? 'price' : goal.field;

    if (Math.abs(diff) >= 5) {
      const direction = diff > 0 ? (goal.lower_is_better ? 'more' : 'more') : (goal.lower_is_better ? 'less' : 'less');
      tradeoffs.push({
        field: fieldLabel,
        difference: `${Math.round(Math.abs(diff))}% ${direction}`,
        absolute: `${Math.round(Math.abs(altField - origField))} ${goal.field.replace('_g', 'g').replace('_mg', 'mg')}`
      });
    }
  }
  return tradeoffs.slice(0, 3);
}

function extractNutritionFromText(text) {
  const extract = (pattern) => {
    const match = text.match(pattern);
    return match ? parseFloat(match[1]) : undefined;
  };

  return {
    serving_size: extract(/(\d+\s*g)/i) || extract(/(\d+\s*oz)/i) || 'unknown',
    calories: extract(/calories?\s*:?\s*(\d+)/i) || extract(/(\d+)\s*cal/i),
    total_fat_g: extract(/total\s*fat\s*:?\s*([\d.]+)\s*g/i) || extract(/([\d.]+)\s*g\s*fat/i),
    saturated_fat_g: extract(/saturated\s*fat\s*:?\s*([\d.]+)/i),
    trans_fat_g: extract(/trans\s*fat\s*:?\s*([\d.]+)/i),
    cholesterol_mg: extract(/cholesterol\s*:?\s*([\d.]+)/i),
    sodium_mg: extract(/sodium\s*:?\s*([\d.]+)/i),
    total_carbs_g: extract(/total\s*carbohydrate\s*:?\s*([\d.]+)\s*g/i) || extract(/total\s*carbs?\s*:?\s*([\d.]+)/i),
    fiber_g: extract(/fiber\s*:?\s*([\d.]+)/i) || extract(/dietary\s*fiber\s*:?\s*([\d.]+)/i),
    sugar_g: extract(/sugars?\s*:?\s*([\d.]+)/i),
    protein_g: extract(/protein\s*:?\s*([\d.]+)/i)
  };
}

// POST /api/corrections
app.post('/api/corrections', (req, res) => {
  const { barcode, nutrition, source } = req.body;
  if (!barcode || !nutrition) {
    return res.status(400).json({ error: 'barcode and nutrition required' });
  }

  // Simple sanity check
  const nut = typeof nutrition === 'string' ? JSON.parse(nutrition) : nutrition;
  if (!nut.calories || nut.calories > 2000) {
    return res.status(400).json({ error: 'Nutrition data failed sanity check' });
  }

  db.prepare('INSERT INTO corrections (barcode, nutrition, source) VALUES (?, ?, ?)').run(
    barcode, JSON.stringify(nut), source || 'user'
  );

  res.json({ status: 'submitted', message: 'Correction stored for review' });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    products: db.prepare('SELECT COUNT(*) as c FROM products').get().c,
    scans: db.prepare('SELECT COUNT(*) as c FROM scans').get().c,
    corrections: db.prepare('SELECT COUNT(*) as c FROM corrections').get().c,
    uptime_seconds: Math.round(process.uptime()),
  });
});

// Lightweight stats endpoint — feeds the KPI dashboard once we have one
app.get('/api/stats', (req, res) => {
  const totalScans = db.prepare('SELECT COUNT(*) as c FROM scans').get().c;
  const last7DaysScans = db
    .prepare("SELECT COUNT(*) as c FROM scans WHERE created_at >= datetime('now', '-7 days')")
    .get().c;
  const totalCorrections = db.prepare('SELECT COUNT(*) as c FROM corrections').get().c;
  const totalProducts = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  const verifiedProducts = db
    .prepare("SELECT COUNT(*) as c FROM products WHERE confidence = 'verified'")
    .get().c;
  const estimatedProducts = db
    .prepare("SELECT COUNT(*) as c FROM products WHERE confidence = 'estimated'")
    .get().c;
  res.json({
    total_scans: totalScans,
    scans_last_7_days: last7DaysScans,
    total_corrections: totalCorrections,
    total_products: totalProducts,
    verified_products: verifiedProducts,
    estimated_products: estimatedProducts,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`ScanWise API running on http://${HOST}:${PORT}`);
  console.log(`Health: http://${HOST}:${PORT}/api/health`);
  console.log(`Stats:  http://${HOST}:${PORT}/api/stats`);
});
