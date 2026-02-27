import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database("compta.db");

// Initialize Database
try {
  console.log("Initializing database...");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      address TEXT,
      siret TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prestations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      unit_price REAL,
      type TEXT, -- 'service' or 'vente'
      tva_rate REAL
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT UNIQUE NOT NULL,
      client_id INTEGER,
      object TEXT NOT NULL,
      date TEXT,
      expiry_date TEXT,
      status TEXT DEFAULT 'Brouillon', -- 'Brouillon', 'Envoyé', 'Accepté', 'Refusé'
      items TEXT, -- JSON array
      total_ht REAL,
      total_tva REAL,
      total_ttc REAL,
      sent_at TEXT,
      accepted_at TEXT,
      refused_at TEXT,
      invoice_id INTEGER,
      FOREIGN KEY(client_id) REFERENCES clients(id),
      FOREIGN KEY(invoice_id) REFERENCES invoices(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT UNIQUE NOT NULL,
      quote_id INTEGER,
      client_id INTEGER,
      object TEXT NOT NULL,
      date TEXT,
      status TEXT DEFAULT 'Brouillon', -- 'Brouillon', 'Envoyée', 'Payée'
      items TEXT, -- JSON array
      total_ht REAL,
      total_tva REAL,
      total_ttc REAL,
      sent_at TEXT,
      paid_at TEXT,
      payment_method TEXT,
      type_operation TEXT,
      nature_operation TEXT,
      pays_client TEXT,
      date_encaissement TEXT,
      statut_transmission TEXT DEFAULT 'Non transmis',
      date_transmission TEXT,
      reference_pdp TEXT,
      FOREIGN KEY(client_id) REFERENCES clients(id),
      FOREIGN KEY(quote_id) REFERENCES quotes(id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      description TEXT,
      amount_ht REAL,
      amount_tva REAL,
      category TEXT,
      receipt_path TEXT,
      client_id INTEGER, -- optional association
      supplier_name TEXT,
      invoice_number TEXT,
      payment_method TEXT,
      type TEXT DEFAULT 'frais', -- 'achat' or 'frais'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoice_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER,
      action TEXT, -- 'creation', 'modification', 'emission', 'paiement', 'suppression'
      date DATETIME DEFAULT CURRENT_TIMESTAMP,
      user TEXT,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id)
    );
  `);
  console.log("Database tables initialized.");

  // Add columns if they don't exist (migration)
  try { 
    console.log("Running migrations...");
    db.exec("ALTER TABLE quotes ADD COLUMN accepted_at TEXT"); 
    console.log("Added accepted_at column");
  } catch (e) {
    // Column likely exists
  }
  try { 
    db.exec("ALTER TABLE quotes ADD COLUMN refused_at TEXT"); 
    console.log("Added refused_at column");
  } catch (e) {
    // Column likely exists
  }
  try { 
    db.exec("ALTER TABLE quotes ADD COLUMN invoice_id INTEGER REFERENCES invoices(id)"); 
    console.log("Added invoice_id column");
  } catch (e) {
    // Column likely exists
  }
  try { 
    db.exec("ALTER TABLE invoices ADD COLUMN payment_method TEXT"); 
    console.log("Added payment_method column");
  } catch (e) {
    // Column likely exists
  }
  try { db.exec("ALTER TABLE expenses ADD COLUMN supplier_name TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE expenses ADD COLUMN invoice_number TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE expenses ADD COLUMN payment_method TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE expenses ADD COLUMN type TEXT DEFAULT 'frais'"); } catch (e) {}
  try { db.exec("ALTER TABLE clients ADD COLUMN typology TEXT DEFAULT 'particulier'"); } catch (e) {}
  try { db.exec("ALTER TABLE clients ADD COLUMN tva_intracom TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE clients ADD COLUMN country TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE invoices ADD COLUMN type_operation TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE invoices ADD COLUMN nature_operation TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE invoices ADD COLUMN pays_client TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE invoices ADD COLUMN date_encaissement TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE invoices ADD COLUMN statut_transmission TEXT DEFAULT 'Non transmis'"); } catch (e) {}
  try { db.exec("ALTER TABLE invoices ADD COLUMN date_transmission TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE invoices ADD COLUMN reference_pdp TEXT"); } catch (e) {}
  console.log("Migrations complete.");

} catch (error) {
  console.error("Database initialization failed:", error);
  process.exit(1);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  const UPLOADS_DIR = path.join(__dirname, "uploads");
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
  }
  app.use("/uploads", express.static(UPLOADS_DIR));

  const saveFile = (dataUri: string): string => {
    if (!dataUri || !dataUri.startsWith('data:')) return dataUri;
    
    const matches = dataUri.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return dataUri;
    
    const type = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    // Basic extension mapping
    let extension = 'bin';
    if (type === 'image/jpeg') extension = 'jpg';
    else if (type === 'image/png') extension = 'png';
    else if (type === 'application/pdf') extension = 'pdf';
    
    const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.${extension}`;
    const filepath = path.join(UPLOADS_DIR, filename);
    
    fs.writeFileSync(filepath, buffer);
    return `/uploads/${filename}`;
  };

  // API Routes
  app.get("/api/settings", (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM settings").all();
      const settings = rows.reduce((acc: any, row: any) => {
        try {
          // Try to parse JSON values (arrays, objects, numbers, booleans)
          acc[row.key] = JSON.parse(row.value);
        } catch (e) {
          // If parsing fails, keep as string
          acc[row.key] = row.value;
        }
        return acc;
      }, {});
      res.json(settings);
    } catch (error) {
      console.error("Error fetching settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.post("/api/settings", (req, res) => {
    const settings = req.body;
    const insert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    const transaction = db.transaction((data) => {
      for (const [key, value] of Object.entries(data)) {
        insert.run(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    });
    transaction(settings);
    res.json({ success: true });
  });

  // Clients
  app.get("/api/clients", (req, res) => {
    const rows = db.prepare("SELECT * FROM clients ORDER BY name ASC").all();
    res.json(rows);
  });

  app.post("/api/clients", (req, res) => {
    const { name, email, address, siret, typology, tva_intracom, country } = req.body;
    const result = db.prepare("INSERT INTO clients (name, email, address, siret, typology, tva_intracom, country) VALUES (?, ?, ?, ?, ?, ?, ?)").run(name, email, address, siret, typology || 'particulier', tva_intracom, country);
    res.json({ id: result.lastInsertRowid });
  });

  app.put("/api/clients/:id", (req, res) => {
    const { name, email, address, siret, typology, tva_intracom, country } = req.body;
    const fields = [];
    const values = [];
    if (name) { fields.push("name = ?"); values.push(name); }
    if (email) { fields.push("email = ?"); values.push(email); }
    if (address) { fields.push("address = ?"); values.push(address); }
    if (siret !== undefined) { fields.push("siret = ?"); values.push(siret); }
    if (typology) { fields.push("typology = ?"); values.push(typology); }
    if (tva_intracom !== undefined) { fields.push("tva_intracom = ?"); values.push(tva_intracom); }
    if (country !== undefined) { fields.push("country = ?"); values.push(country); }

    if (fields.length > 0) {
      values.push(req.params.id);
      db.prepare(`UPDATE clients SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    res.json({ success: true });
  });

  app.delete("/api/clients/:id", (req, res) => {
    db.prepare("DELETE FROM clients WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // Prestations
  app.get("/api/prestations", (req, res) => {
    const rows = db.prepare("SELECT * FROM prestations").all();
    res.json(rows);
  });

  app.post("/api/prestations", (req, res) => {
    const { name, description, unit_price, type, tva_rate } = req.body;
    const result = db.prepare("INSERT INTO prestations (name, description, unit_price, type, tva_rate) VALUES (?, ?, ?, ?, ?)").run(name, description, unit_price, type, tva_rate);
    res.json({ id: result.lastInsertRowid });
  });

  // Quotes
  app.get("/api/quotes", (req, res) => {
    const rows = db.prepare(`
      SELECT q.*, c.name as client_name 
      FROM quotes q 
      LEFT JOIN clients c ON q.client_id = c.id 
      ORDER BY q.number DESC
    `).all();
    res.json(rows.map((r: any) => ({ ...r, items: JSON.parse(r.items || '[]') })));
  });

  app.post("/api/quotes", (req, res) => {
    const { number, client_id, object, date, expiry_date, status, items, total_ht, total_tva, total_ttc } = req.body;
    const result = db.prepare(`
      INSERT INTO quotes (number, client_id, object, date, expiry_date, status, items, total_ht, total_tva, total_ttc) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(number, client_id, object, date, expiry_date, status, JSON.stringify(items), total_ht, total_tva, total_ttc);
    res.json({ id: result.lastInsertRowid });
  });

  app.put("/api/quotes/:id", (req, res) => {
    const { status, sent_at, accepted_at, refused_at, object, items, total_ht, total_tva, total_ttc, date, expiry_date, client_id } = req.body;
    // Simple update for now
    const fields = [];
    const values = [];
    if (status) { fields.push("status = ?"); values.push(status); }
    if (sent_at) { fields.push("sent_at = ?"); values.push(sent_at); }
    if (accepted_at) { fields.push("accepted_at = ?"); values.push(accepted_at); }
    if (refused_at) { fields.push("refused_at = ?"); values.push(refused_at); }
    if (object) { fields.push("object = ?"); values.push(object); }
    if (items) { fields.push("items = ?"); values.push(JSON.stringify(items)); }
    if (total_ht !== undefined) { fields.push("total_ht = ?"); values.push(total_ht); }
    if (total_tva !== undefined) { fields.push("total_tva = ?"); values.push(total_tva); }
    if (total_ttc !== undefined) { fields.push("total_ttc = ?"); values.push(total_ttc); }
    if (date) { fields.push("date = ?"); values.push(date); }
    if (expiry_date) { fields.push("expiry_date = ?"); values.push(expiry_date); }
    if (client_id) { fields.push("client_id = ?"); values.push(client_id); }

    if (fields.length > 0) {
      values.push(req.params.id);
      db.prepare(`UPDATE quotes SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    res.json({ success: true });
  });

  app.delete("/api/quotes/:id", (req, res) => {
    db.prepare("DELETE FROM quotes WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // Invoices
  app.get("/api/invoices", (req, res) => {
    const rows = db.prepare(`
      SELECT i.*, c.name as client_name 
      FROM invoices i 
      LEFT JOIN clients c ON i.client_id = c.id 
      ORDER BY i.number DESC
    `).all();
    res.json(rows.map((r: any) => ({ ...r, items: JSON.parse(r.items || '[]') })));
  });

  app.post("/api/invoices", (req, res) => {
    const { number, quote_id, client_id, object, date, status, items, total_ht, total_tva, total_ttc, type_operation, nature_operation, pays_client, date_encaissement, statut_transmission, date_transmission, reference_pdp } = req.body;
    
    // Check if invoice already exists for this quote
    if (quote_id) {
      const existing = db.prepare("SELECT id FROM invoices WHERE quote_id = ?").get(quote_id);
      if (existing) {
        return res.status(400).json({ error: "Une facture existe déjà pour ce devis." });
      }
    }

    const insert = db.prepare(`
      INSERT INTO invoices (number, quote_id, client_id, object, date, status, items, total_ht, total_tva, total_ttc, type_operation, nature_operation, pays_client, date_encaissement, statut_transmission, date_transmission, reference_pdp) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
      const result = insert.run(number, quote_id, client_id, object, date, status, JSON.stringify(items), total_ht, total_tva, total_ttc, type_operation, nature_operation, pays_client, date_encaissement, statut_transmission || 'Non transmis', date_transmission, reference_pdp);
      const invoiceId = result.lastInsertRowid;

      if (quote_id) {
        db.prepare("UPDATE quotes SET invoice_id = ? WHERE id = ?").run(invoiceId, quote_id);
      }

      // Log creation event
      db.prepare("INSERT INTO invoice_events (invoice_id, action, user) VALUES (?, ?, ?)").run(invoiceId, 'creation', 'system');
      
      return invoiceId;
    });

    try {
      const invoiceId = transaction();
      res.json({ id: invoiceId });
    } catch (error) {
      console.error("Failed to create invoice:", error);
      res.status(500).json({ error: "Failed to create invoice" });
    }
  });

  app.put("/api/invoices/:id", (req, res) => {
    const invoiceId = req.params.id;
    const currentInvoice = db.prepare("SELECT status FROM invoices WHERE id = ?").get(invoiceId) as any;

    if (!currentInvoice) {
      return res.status(404).json({ error: "Facture non trouvée" });
    }

    // Immutability check
    if (currentInvoice.status !== 'Brouillon') {
      // Allow only specific updates (e.g. payment status, payment method, date_encaissement)
      // If trying to change fiscal data, reject
      const { items, total_ht, total_tva, total_ttc, client_id, number } = req.body;
      if (items || total_ht !== undefined || total_tva !== undefined || total_ttc !== undefined || client_id || (req.body.number && req.body.number !== currentInvoice.number)) {
        return res.status(403).json({ error: "Impossible de modifier une facture émise. Veuillez créer un avoir." });
      }
    }

    const { status, sent_at, paid_at, payment_method, object, items, total_ht, total_tva, total_ttc, date, client_id, type_operation, nature_operation, pays_client, date_encaissement, statut_transmission, date_transmission, reference_pdp } = req.body;
    const fields = [];
    const values = [];
    let action = 'modification';

    if (status) { 
      fields.push("status = ?"); values.push(status); 
      if (status === 'Envoyée' && currentInvoice.status === 'Brouillon') action = 'emission';
      if (status === 'Payée' && currentInvoice.status !== 'Payée') action = 'paiement';
    }
    if (sent_at) { fields.push("sent_at = ?"); values.push(sent_at); }
    if (paid_at) { fields.push("paid_at = ?"); values.push(paid_at); }
    if (payment_method) { fields.push("payment_method = ?"); values.push(payment_method); }
    if (object) { fields.push("object = ?"); values.push(object); }
    if (items) { fields.push("items = ?"); values.push(JSON.stringify(items)); }
    if (total_ht !== undefined) { fields.push("total_ht = ?"); values.push(total_ht); }
    if (total_tva !== undefined) { fields.push("total_tva = ?"); values.push(total_tva); }
    if (total_ttc !== undefined) { fields.push("total_ttc = ?"); values.push(total_ttc); }
    if (date) { fields.push("date = ?"); values.push(date); }
    if (client_id) { fields.push("client_id = ?"); values.push(client_id); }
    if (type_operation) { fields.push("type_operation = ?"); values.push(type_operation); }
    if (nature_operation) { fields.push("nature_operation = ?"); values.push(nature_operation); }
    if (pays_client) { fields.push("pays_client = ?"); values.push(pays_client); }
    if (date_encaissement) { fields.push("date_encaissement = ?"); values.push(date_encaissement); }
    if (statut_transmission) { fields.push("statut_transmission = ?"); values.push(statut_transmission); }
    if (date_transmission) { fields.push("date_transmission = ?"); values.push(date_transmission); }
    if (reference_pdp) { fields.push("reference_pdp = ?"); values.push(reference_pdp); }

    if (fields.length > 0) {
      values.push(invoiceId);
      const transaction = db.transaction(() => {
        db.prepare(`UPDATE invoices SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        db.prepare("INSERT INTO invoice_events (invoice_id, action, user) VALUES (?, ?, ?)").run(invoiceId, action, 'system');
      });
      transaction();
    }
    res.json({ success: true });
  });

  app.delete("/api/invoices/:id", (req, res) => {
    const invoiceId = req.params.id;
    const currentInvoice = db.prepare("SELECT status FROM invoices WHERE id = ?").get(invoiceId) as any;

    if (!currentInvoice) {
      return res.status(404).json({ error: "Facture non trouvée" });
    }

    if (currentInvoice.status !== 'Brouillon') {
      return res.status(403).json({ error: "Impossible de supprimer une facture émise." });
    }

    db.prepare("DELETE FROM invoices WHERE id = ?").run(invoiceId);
    res.json({ success: true });
  });

  // Expenses
  app.get("/api/expenses", (req, res) => {
    const rows = db.prepare("SELECT * FROM expenses ORDER BY date DESC").all();
    res.json(rows);
  });

  app.post("/api/expenses", (req, res) => {
    const { date, description, amount_ht, amount_tva, category, receipt_path, client_id, supplier_name, invoice_number, payment_method, type } = req.body;
    
    let savedReceiptPath = receipt_path;
    if (receipt_path && receipt_path.startsWith('data:')) {
      savedReceiptPath = saveFile(receipt_path);
    }

    const result = db.prepare(`
      INSERT INTO expenses (date, description, amount_ht, amount_tva, category, receipt_path, client_id, supplier_name, invoice_number, payment_method, type) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(date, description, amount_ht, amount_tva, category, savedReceiptPath, client_id, supplier_name, invoice_number, payment_method, type || 'frais');
    res.json({ id: result.lastInsertRowid });
  });

  app.put("/api/expenses/:id", (req, res) => {
    const { date, description, amount_ht, amount_tva, category, receipt_path, client_id, supplier_name, invoice_number, payment_method, type } = req.body;
    const fields = [];
    const values = [];
    if (date) { fields.push("date = ?"); values.push(date); }
    if (description) { fields.push("description = ?"); values.push(description); }
    if (amount_ht !== undefined) { fields.push("amount_ht = ?"); values.push(amount_ht); }
    if (amount_tva !== undefined) { fields.push("amount_tva = ?"); values.push(amount_tva); }
    if (category) { fields.push("category = ?"); values.push(category); }
    if (receipt_path) { 
      let savedPath = receipt_path;
      if (receipt_path.startsWith('data:')) {
        savedPath = saveFile(receipt_path);
      }
      fields.push("receipt_path = ?"); 
      values.push(savedPath); 
    }
    if (client_id) { fields.push("client_id = ?"); values.push(client_id); }
    if (supplier_name) { fields.push("supplier_name = ?"); values.push(supplier_name); }
    if (invoice_number) { fields.push("invoice_number = ?"); values.push(invoice_number); }
    if (payment_method) { fields.push("payment_method = ?"); values.push(payment_method); }
    if (type) { fields.push("type = ?"); values.push(type); }

    if (fields.length > 0) {
      values.push(req.params.id);
      db.prepare(`UPDATE expenses SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    res.json({ success: true });
  });

  app.delete("/api/expenses/:id", (req, res) => {
    db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
