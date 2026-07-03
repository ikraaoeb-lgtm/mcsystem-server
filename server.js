// server.js – License Server لـ MCpos (إصدار آمن للإنتاج)
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- إعدادات GitHub ----
const GITHUB_REPO_OWNER = 'ikraaoeb-lgtm';
const GITHUB_REPO_NAME = 'MCpos';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;

// ---- مسارات التخزين (ثابتة في Render، محلية في غيره) ----
const isRender = process.env.RENDER === 'true';

const uploadsDir = isRender
    ? '/opt/render/.data/uploads'
    : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// تخزين الملفات المؤقتة (للاستيراد)
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// تخزين ملفات الرفع (للاستيراد)
const deviceUpload = multer({ dest: uploadsDir });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- المفتاح الخاص ----
const privateKey = process.env.PRIVATE_KEY
    || (fs.existsSync('private.pem') ? fs.readFileSync('private.pem', 'utf8') : '');

if (!privateKey) {
    console.error('❌ PRIVATE_KEY غير موجود. يجب تعيينه في متغيرات البيئة أو ملف private.pem.');
    process.exit(1);
}

// ---- حماية لوحة الإدارة ----
const ADMIN_USER = process.env.ADMIN_USER || 'mcpos';
const ADMIN_PASS = process.env.ADMIN_PASS || 'mcpos2025';

app.use('/admin', (req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login === ADMIN_USER && password === ADMIN_PASS) {
        return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="MCpos Admin"');
    res.status(401).send('Authentication required.');
});

// صفحة لوحة الإدارة
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---- قاعدة البيانات ----
const dbPath = isRender
    ? '/opt/render/.data/mcpos.db'
    : path.join(__dirname, 'database', 'mcpos.db');
console.log('📁 مسار قاعدة البيانات:', dbPath);

if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
const db = new sqlite3.Database(dbPath);

// تفعيل WAL
db.run('PRAGMA journal_mode=WAL;');

// طباعة الجداول
db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) console.error('❌ خطأ في قراءة الجداول:', err.message);
    else console.log('📋 الجداول الموجودة:', tables.map(t => t.name).join(', '));
});

// ---- إنشاء الجداول (بدون بطاقات الدفع المسبق) ----
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hwid TEXT UNIQUE NOT NULL,
        device_secret TEXT,
        shop_name TEXT,
        manager_name TEXT,
        email TEXT,
        phone TEXT,
        status TEXT DEFAULT 'trial',
        activation_type TEXT,
        trial_start TEXT,
        trial_end TEXT,
        server_trial_end TEXT,
        subscription_start TEXT,
        subscription_end TEXT,
        server_subscription_end TEXT,
        activated_at TEXT,
        blocked_at TEXT,
        license_version INTEGER DEFAULT 1,
        last_sync TEXT,
        last_seen TEXT,
        created_at TEXT,
        updated_at TEXT,
        license_signature TEXT,
        code_promo TEXT          -- حقل جديد للكود الترويجي
    )`, (err) => {
        if (err) console.error('❌ فشل إنشاء جدول devices:', err.message);
        else console.log('✅ جدول devices جاهز');
    });

    db.run(`CREATE TABLE IF NOT EXISTS heartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hwid TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT,
        details TEXT,
        FOREIGN KEY (hwid) REFERENCES devices(hwid)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS discount_codes (
        code TEXT PRIMARY KEY,
        type TEXT,
        value REAL,
        expires_at TEXT,
        max_uses INTEGER,
        used_count INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL,
        release_date TEXT,
        notes TEXT,
        file_url TEXT,
        file_size INTEGER DEFAULT 0,
        mandatory INTEGER DEFAULT 0,
        channel TEXT DEFAULT 'stable',
        min_version TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        discount_type TEXT NOT NULL,
        discount_value REAL NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT
    )`);

    // إضافة عمود code_promo إذا لم يكن موجوداً (للترقية)
    db.run(`ALTER TABLE devices ADD COLUMN code_promo TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) console.warn('⚠️ ALTER TABLE devices code_promo:', err.message);
    });

    // إعدادات افتراضية
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('trial_days', '14')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('sync_interval', '15')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('offline_grace_period', '90')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('subscription_prices', '{"quarterly":4000,"semiannual":7000,"annual":12000,"permanent":20000}')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('update_policy', 'optional')`);
});

// ---- دوال مساعدة ----
function signPayload(payload) {
    const sign = crypto.createSign('SHA256');
    sign.update(JSON.stringify(payload));
    return sign.sign(privateKey, 'base64');
}

function ensureDeviceExists(hwid, extraData, callback) {
    const now = new Date().toISOString();
    const shopName = extraData?.shop_name || 'جهاز غير مسجل';
    const phone = extraData?.phone || '';
    const managerName = extraData?.manager_name || '';
    const email = extraData?.email || '';
    const codePromo = extraData?.code_promo || '';

    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (row) {
            if (extraData) {
                db.run(
                    `UPDATE devices SET shop_name = ?, manager_name = ?, email = ?, phone = ?, code_promo = ?, last_seen = ?, updated_at = ? WHERE hwid = ?`,
                    [shopName, managerName, email, phone, codePromo, now, now, hwid]
                );
            } else {
                db.run('UPDATE devices SET last_seen = ? WHERE hwid = ?', [now, hwid]);
            }
            db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err2, updatedRow) => {
                callback(err2, updatedRow);
            });
        } else {
            db.run(
                `INSERT INTO devices (hwid, shop_name, manager_name, email, phone, code_promo, status, trial_start, trial_end, created_at, updated_at, last_seen)
                 VALUES (?, ?, ?, ?, ?, ?, 'trial', date('now'), date('now', '+14 days'), ?, ?, ?)`,
                [hwid, shopName, managerName, email, phone, codePromo, now, now, now],
                function(err) {
                    if (err) return callback(err);
                    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err2, newRow) => {
                        callback(err2, newRow);
                    });
                }
            );
        }
    });
}

// دالة جلب أحدث إصدار من GitHub
async function fetchLatestGitHubRelease() {
    try {
        const response = await fetch(GITHUB_API_URL, {
            headers: {
                'User-Agent': 'MCpos-Server',
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
        const release = await response.json();
        return {
            version: release.tag_name.replace('v', ''),
            releaseDate: release.published_at,
            notes: release.body || '',
            fileUrl: release.assets?.[0]?.browser_download_url || release.html_url,
            fileSize: release.assets?.[0]?.size || 0,
            prerelease: release.prerelease || false
        };
    } catch (error) {
        console.error('فشل جلب بيانات GitHub:', error);
        return null;
    }
}

// دالة مزامنة آخر إصدار إلى قاعدة البيانات
async function syncUpdateFromGitHub() {
    const release = await fetchLatestGitHubRelease();
    if (!release) return { success: false, error: 'تعذر جلب بيانات الإصدار من GitHub' };

    return new Promise((resolve, reject) => {
        db.get('SELECT id FROM updates WHERE version = ?', [release.version], (err, existing) => {
            if (err) return reject(err);
            if (existing) {
                db.run(
                    `UPDATE updates SET release_date=?, notes=?, file_url=?, file_size=?, updated_at=CURRENT_TIMESTAMP WHERE version=?`,
                    [release.releaseDate, release.notes, release.fileUrl, release.fileSize, release.version],
                    (err) => {
                        if (err) return reject(err);
                        resolve({ success: true, version: release.version });
                    }
                );
            } else {
                db.run(
                    `INSERT INTO updates (version, release_date, notes, file_url, file_size, mandatory, channel, min_version) VALUES (?,?,?,?,?,?,?,?)`,
                    [release.version, release.releaseDate, release.notes, release.fileUrl, release.fileSize, 0, 'stable', '1.0.0'],
                    function(err) {
                        if (err) return reject(err);
                        resolve({ success: true, version: release.version });
                    }
                );
            }
        });
    });
}

// ====================== API Routes ======================

// الصفحة الرئيسية
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// الحصول على جميع الأجهزة
app.get('/api/devices', (req, res) => {
    db.all('SELECT * FROM devices ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// تسجيل جهاز جديد (مع تحديث البيانات إذا كان موجوداً)
app.post('/api/devices/register', (req, res) => {
    const { hwid, shop_name, manager_name, email, phone, type, activation_type, discount_code, code_promo } = req.body;
    if (!hwid) return res.status(400).json({ success: false, error: 'HWID required' });

    const now = new Date().toISOString();

    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            db.run(
                `UPDATE devices SET shop_name = ?, manager_name = ?, email = ?, phone = ?, code_promo = ?, last_seen = ?, updated_at = ? WHERE hwid = ?`,
                [shop_name || row.shop_name, manager_name || row.manager_name, email || row.email, phone || row.phone, code_promo || row.code_promo, now, now, hwid]
            );
            db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err2, updatedRow) => {
                const payload = {
                    status: updatedRow.status,
                    trial_end: updatedRow.server_trial_end || updatedRow.trial_end,
                    subscription_end: updatedRow.server_subscription_end || updatedRow.subscription_end,
                    license_version: updatedRow.license_version,
                    hwid
                };
                const signature = signPayload(payload);
                return res.json({ success: true, alreadyRegistered: true, data: { ...payload, signature } });
            });
            return;
        }

        let status = 'trial';
        let trial_start = new Date().toISOString().split('T')[0];
        db.get('SELECT value FROM settings WHERE key = ?', ['trial_days'], (err, row) => {
            const trialDays = parseInt(row?.value || '14');
            const end = new Date();
            end.setDate(end.getDate() + trialDays);
            const trial_end = end.toISOString().split('T')[0];
            const secret = crypto.randomBytes(16).toString('hex');

            db.run(
                `INSERT INTO devices (hwid, device_secret, shop_name, manager_name, email, phone, code_promo, status, activation_type, trial_start, trial_end, server_trial_end, created_at, updated_at, last_seen)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [hwid, secret, shop_name, manager_name, email, phone, code_promo || null, status, activation_type || null, trial_start, trial_end, trial_end, now, now, now],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });

                    if (discount_code) {
                        db.get('SELECT * FROM discount_codes WHERE code = ?', [discount_code], (err, dc) => {
                            if (dc && dc.expires_at && new Date(dc.expires_at) > new Date() && dc.used_count < dc.max_uses) {
                                db.run('UPDATE discount_codes SET used_count = used_count + 1 WHERE code = ?', [discount_code]);
                            }
                        });
                    }

                    const payload = {
                        status,
                        trial_end,
                        subscription_end: null,
                        license_version: 1,
                        hwid
                    };
                    const signature = signPayload(payload);
                    res.json({ success: true, data: { ...payload, signature } });
                }
            );
        });
    });
});

// التحقق من حالة التفعيل (مع التسجيل التلقائي)
app.post('/api/devices/check', (req, res) => {
    const { hwid } = req.body;
    if (!hwid) return res.status(400).json({ error: 'HWID required' });

    ensureDeviceExists(hwid, null, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        const payload = {
            status: row.status,
            trial_start: row.trial_start,
            trial_end: row.server_trial_end || row.trial_end,
            activation_type: row.activation_type,
            subscription_end: row.server_subscription_end || row.subscription_end,
            license_version: row.license_version,
            hwid
        };
        const signature = signPayload(payload);
        const now = new Date().toISOString();
        db.run('UPDATE devices SET last_sync = ?, last_seen = ? WHERE hwid = ?', [now, now, hwid]);
        res.json({ success: true, data: { ...payload, signature } });
    });
});

// مزامنة (مع التسجيل التلقائي)
app.post('/api/devices/sync', (req, res) => {
    const { hwid, shop_name, phone } = req.body;
    if (!hwid) return res.status(400).json({ error: 'HWID required' });

    const extraData = shop_name || phone ? { shop_name, phone } : null;
    ensureDeviceExists(hwid, extraData, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        const payload = {
            status: row.status,
            trial_start: row.trial_start,
            trial_end: row.server_trial_end || row.trial_end,
            activation_type: row.activation_type,
            subscription_end: row.server_subscription_end || row.subscription_end,
            license_version: row.license_version,
            hwid
        };
        const signature = signPayload(payload);
        const now = new Date().toISOString();
        db.run('UPDATE devices SET last_sync = ?, last_seen = ? WHERE hwid = ?', [now, now, hwid]);
        res.json({ success: true, data: { ...payload, signature } });
    });
});

// تفعيل / حظر من لوحة الإدارة
app.put('/api/devices/:hwid', (req, res) => {
    const { hwid } = req.params;
    const { status, activation_type, subscription_months } = req.body;
    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Not found' });
        const newVersion = row.license_version + 1;
        const now = new Date().toISOString();
        let updates = { status, license_version: newVersion, updated_at: now };
        if (status === 'activated') {
            updates.activated_at = now;
            if (activation_type === 'subscription' && subscription_months) {
                const end = new Date();
                end.setMonth(end.getMonth() + subscription_months);
                updates.subscription_end = end.toISOString().split('T')[0];
                updates.server_subscription_end = updates.subscription_end;
            } else if (activation_type === 'permanent') {
                updates.subscription_end = null;
                updates.server_subscription_end = null;
            }
        } else if (status === 'blocked') {
            updates.blocked_at = now;
        }
        const sql = `UPDATE devices SET ${Object.keys(updates).map(k => `${k}=?`).join(', ')} WHERE hwid=?`;
        db.run(sql, [...Object.values(updates), hwid], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// تعديل معلومات الجهاز (اسم المحل + رقم الهاتف + code_promo)
app.put('/api/devices/:hwid/info', (req, res) => {
    const { hwid } = req.params;
    const { shop_name, phone, code_promo } = req.body;
    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Device not found' });
        const updates = {};
        if (shop_name !== undefined) updates.shop_name = shop_name;
        if (phone !== undefined) updates.phone = phone;
        if (code_promo !== undefined) updates.code_promo = code_promo;
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' });
        updates.updated_at = new Date().toISOString();
        const sql = `UPDATE devices SET ${Object.keys(updates).map(k => `${k}=?`).join(', ')} WHERE hwid=?`;
        db.run(sql, [...Object.values(updates), hwid], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// تمديد التجربة
app.post('/api/devices/:hwid/extend-trial', (req, res) => {
    const { hwid } = req.params;
    const { days } = req.body;
    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Not found' });
        const currentEnd = row.trial_end ? new Date(row.trial_end) : new Date();
        currentEnd.setDate(currentEnd.getDate() + (days || 14));
        const newTrialEnd = currentEnd.toISOString().split('T')[0];
        const newVersion = row.license_version + 1;
        db.run('UPDATE devices SET trial_end=?, server_trial_end=?, license_version=?, updated_at=? WHERE hwid=?',
            [newTrialEnd, newTrialEnd, newVersion, new Date().toISOString(), hwid],
            (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
        );
    });
});

// حذف جهاز
app.delete('/api/devices/:hwid', (req, res) => {
    const { hwid } = req.params;
    db.run('DELETE FROM devices WHERE hwid = ?', [hwid], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// تصدير قائمة الأجهزة إلى JSON
app.get('/api/devices/export', (req, res) => {
    db.all('SELECT * FROM devices', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.setHeader('Content-Disposition', 'attachment; filename=devices_export.json');
        res.json(rows);
    });
});

// استيراد قائمة أجهزة من ملف JSON
app.post('/api/devices/import', deviceUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        const data = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
        if (!Array.isArray(data)) return res.status(400).json({ error: 'Invalid JSON format: array expected' });
        let imported = 0;
        const stmt = db.prepare(`INSERT OR REPLACE INTO devices (hwid, shop_name, phone, code_promo, status, trial_start, trial_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
        db.serialize(() => {
            data.forEach(device => {
                const { hwid, shop_name, phone, code_promo, status, trial_start, trial_end } = device;
                stmt.run(hwid, shop_name, phone, code_promo, status || 'trial', trial_start, trial_end, new Date().toISOString(), new Date().toISOString());
                imported++;
            });
            stmt.finalize();
            fs.unlinkSync(req.file.path); // حذف الملف المؤقت
            res.json({ success: true, imported });
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// نبضات القلب
app.post('/api/heartbeat/:hwid', (req, res) => {
    const { hwid } = req.params;
    const { status, details } = req.body;
    const now = new Date().toISOString();

    ensureDeviceExists(hwid, null, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE devices SET last_seen = ? WHERE hwid = ?', [now, hwid]);
        db.run('INSERT INTO heartbeats (hwid, timestamp, status, details) VALUES (?,?,?,?)',
            [hwid, now, status || row.status, details || '']);
        res.json({ success: true });
    });
});

// إعدادات النظام
app.get('/api/settings', (req, res) => {
    db.all('SELECT * FROM settings', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });
        settings.subscription_prices = JSON.parse(settings.subscription_prices || '{}');
        res.json({ success: true, data: settings });
    });
});

app.put('/api/settings', (req, res) => {
    const data = req.body;
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)');
    for (const [key, value] of Object.entries(data)) {
        stmt.run(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    stmt.finalize();
    res.json({ success: true });
});

// الحصول على الأسعار
app.get('/api/prices', (req, res) => {
    db.get('SELECT value FROM settings WHERE key = ?', ['subscription_prices'], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const prices = row ? JSON.parse(row.value) : {};
        res.json({ success: true, data: prices });
    });
});

// أكواد الخصم
app.post('/api/discount-codes', (req, res) => {
    const { code, type, value, expires_at, max_uses } = req.body;
    db.run('INSERT OR REPLACE INTO discount_codes (code, type, value, expires_at, max_uses, used_count) VALUES (?,?,?,?,?,0)',
        [code, type, value, expires_at, max_uses],
        (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
    );
});

app.get('/api/discount-codes', (req, res) => {
    db.all('SELECT * FROM discount_codes', (err, rows) => { res.json({ success: true, data: rows }); });
});

app.post('/api/discount-codes/validate', (req, res) => {
    const { code } = req.body;
    db.get('SELECT * FROM discount_codes WHERE code = ?', [code], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ valid: false, error: 'كود غير صحيح' });
        if (row.expires_at && new Date(row.expires_at) < new Date()) return res.json({ valid: false, error: 'منتهي الصلاحية' });
        if (row.max_uses && row.used_count >= row.max_uses) return res.json({ valid: false, error: 'تم استنفاذ الاستخدام' });
        res.json({ valid: true, discount: { type: row.type, value: row.value } });
    });
});

// ================== نظام العروض الترويجية ==================
app.get('/api/promotions/active', (req, res) => {
    const now = new Date().toISOString();
    db.all(
        `SELECT * FROM promotions 
         WHERE is_active = 1 
           AND start_date <= ? 
           AND end_date >= ? 
         ORDER BY end_date ASC`,
        [now, now],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, data: rows || [] });
        }
    );
});

app.post('/api/promotions', (req, res) => {
    const { title, description, discount_type, discount_value, start_date, end_date } = req.body;
    if (!title || !discount_type || !discount_value || !start_date || !end_date) {
        return res.status(400).json({ error: 'جميع الحقول المطلوبة مفقودة' });
    }
    db.run(
        `INSERT INTO promotions (title, description, discount_type, discount_value, start_date, end_date, is_active, created_at)
         VALUES (?,?,?,?,?,?,1,?)`,
        [title, description, discount_type, discount_value, start_date, end_date, new Date().toISOString()],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.get('/api/promotions', (req, res) => {
    db.all('SELECT * FROM promotions ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows || [] });
    });
});

app.delete('/api/promotions/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM promotions WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ================== نظام بطاقات الدفع المسبق (محذوف) ==================
// تمت إزالة جميع routes المتعلقة بـ prepaid_cards

// ================== نظام التحديثات (من GitHub) ==================
// مزامنة التحديثات من GitHub
app.post('/api/updates/sync', async (req, res) => {
    try {
        const result = await syncUpdateFromGitHub();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// الحصول على جميع التحديثات (للوحة)
app.get('/api/updates', (req, res) => {
    db.all('SELECT * FROM updates ORDER BY release_date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows || [] });
    });
});

// الحصول على أحدث إصدار (مع التوقيع)
app.get('/api/updates/latest', (req, res) => {
    db.get('SELECT * FROM updates ORDER BY release_date DESC LIMIT 1', (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ success: true, data: null });

        const payload = {
            version: row.version,
            release_date: row.release_date,
            notes: row.notes,
            file_url: row.file_url,
            file_size: row.file_size,
            mandatory: row.mandatory === 1,
            channel: row.channel,
            min_version: row.min_version
        };
        const signature = signPayload(payload);
        res.json({ success: true, data: { ...payload, signature } });
    });
});

// حذف إصدار
app.delete('/api/updates/:version', (req, res) => {
    const { version } = req.params;
    db.run('DELETE FROM updates WHERE version = ?', [version], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ---- المهام الدورية ----
setInterval(() => {
    const now = new Date();
    db.all('SELECT * FROM devices WHERE status = "trial" AND trial_end IS NOT NULL', (err, rows) => {
        if (rows) {
            rows.forEach(device => {
                if (new Date(device.trial_end) < now) {
                    db.run('UPDATE devices SET status = "expired", license_version = license_version + 1 WHERE hwid = ?', [device.hwid]);
                }
            });
        }
    });
    db.all('SELECT * FROM devices WHERE status = "activated" AND subscription_end IS NOT NULL', (err, rows) => {
        if (rows) {
            rows.forEach(device => {
                if (new Date(device.subscription_end) < now) {
                    db.run('UPDATE devices SET status = "expired", license_version = license_version + 1 WHERE hwid = ?', [device.hwid]);
                }
            });
        }
    });
    db.run(`UPDATE promotions SET is_active = 0 WHERE end_date < ? AND is_active = 1`, [now.toISOString()]);
}, 60 * 1000);

// ---- تشغيل الخادم ----
app.listen(PORT, () => {
    console.log(`🚀 License Server running on port ${PORT}`);
});