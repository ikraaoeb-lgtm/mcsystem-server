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

// ---- مسارات التخزين (ثابتة في Render، محلية في غيره) ----
const isRender = !!process.env.RENDER;

const uploadsDir = isRender
    ? '/opt/render/.data/uploads'
    : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `update-${req.body.version || uniqueSuffix}${ext}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- المفتاح الخاص (من متغير البيئة أو ملف محلي للتطوير فقط) ----
const privateKey = process.env.PRIVATE_KEY
    || (fs.existsSync('private.pem') ? fs.readFileSync('private.pem', 'utf8') : '');

if (!privateKey) {
    console.error('❌ PRIVATE_KEY غير موجود. يجب تعيينه في متغيرات البيئة أو ملف private.pem.');
    process.exit(1);
}

// ---- حماية لوحة الإدارة بكلمة مرور ----
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

// صفحة لوحة الإدارة (بعد الحماية)
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

// ---- طباعة الجداول الموجودة عند بدء التشغيل (للتشخيص) ----
db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) {
        console.error('❌ خطأ في قراءة الجداول:', err.message);
    } else {
        console.log('📋 الجداول الموجودة:', tables.map(t => t.name).join(', '));
    }
});

// ---- إنشاء الجداول (مع معالجة الأخطاء) ----
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
        license_signature TEXT
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
        version TEXT PRIMARY KEY,
        required INTEGER DEFAULT 0,
        notes TEXT,
        file_path TEXT,
        file_name TEXT,
        file_size INTEGER,
        created_at TEXT
    )`);

    // ---- جدول العروض الترويجية الجديد ----
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
    )`, (err) => {
        if (err) console.error('❌ فشل إنشاء جدول promotions:', err.message);
        else console.log('✅ جدول promotions جاهز');
    });

    // إعدادات افتراضية
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('trial_days', '14')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('sync_interval', '15')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('offline_grace_period', '90')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('subscription_prices', '{"monthly":1500,"quarterly":4000,"semiannual":7000,"annual":12000,"permanent":20000}')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('update_policy', 'optional')`);
});

// ---- دوال مساعدة ----
function signPayload(payload) {
    const sign = crypto.createSign('SHA256');
    sign.update(JSON.stringify(payload));
    return sign.sign(privateKey, 'base64');
}

// ====================== API Routes ======================

app.get('/', (req, res) => {
    res.send('✅ MCpos License Server is running.');
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// الحصول على جميع الأجهزة
app.get('/api/devices', (req, res) => {
    db.all('SELECT * FROM devices ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// تسجيل جهاز جديد
app.post('/api/devices/register', (req, res) => {
    const { hwid, shop_name, manager_name, email, phone, type, activation_type, discount_code } = req.body;
    if (!hwid) return res.status(400).json({ success: false, error: 'HWID required' });

    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            const payload = {
                status: row.status,
                trial_end: row.server_trial_end || row.trial_end,
                subscription_end: row.server_subscription_end || row.subscription_end,
                license_version: row.license_version,
                hwid
            };
            const signature = signPayload(payload);
            return res.json({ success: true, alreadyRegistered: true, data: { ...payload, signature } });
        }

        let status = 'trial';
        let trial_start = new Date().toISOString().split('T')[0];
        db.get('SELECT value FROM settings WHERE key = ?', ['trial_days'], (err, row) => {
            const trialDays = parseInt(row?.value || '14');
            const end = new Date();
            end.setDate(end.getDate() + trialDays);
            const trial_end = end.toISOString().split('T')[0];
            const now = new Date().toISOString();
            const secret = crypto.randomBytes(16).toString('hex');

            db.run(
                `INSERT INTO devices (hwid, device_secret, shop_name, manager_name, email, phone, status, activation_type, trial_start, trial_end, server_trial_end, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [hwid, secret, shop_name, manager_name, email, phone, status, activation_type || null, trial_start, trial_end, trial_end, now, now],
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

// التحقق من حالة التفعيل
app.post('/api/devices/check', (req, res) => {
    const { hwid } = req.body;
    if (!hwid) return res.status(400).json({ error: 'HWID required' });

    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Device not found' });

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
        db.run('UPDATE devices SET last_sync = ? WHERE hwid = ?', [new Date().toISOString(), hwid]);
        res.json({ success: true, data: { ...payload, signature } });
    });
});

// مزامنة
app.post('/api/devices/sync', (req, res) => {
    const { hwid } = req.body;
    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Device not found' });

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
        db.run('UPDATE devices SET last_sync = ?, last_seen = ? WHERE hwid = ?', [new Date().toISOString(), new Date().toISOString(), hwid]);
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

// نبضات القلب – تسجيل الأجهزة تلقائياً إذا لم تكن موجودة
app.post('/api/heartbeat/:hwid', (req, res) => {
    const { hwid } = req.params;
    const { status, details } = req.body;
    const now = new Date().toISOString();

    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (row) {
            db.run('UPDATE devices SET last_seen = ? WHERE hwid = ?', [now, hwid], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                db.run('INSERT INTO heartbeats (hwid, timestamp, status, details) VALUES (?,?,?,?)',
                    [hwid, now, status, details]);
                res.json({ success: true });
            });
        } else {
            const shopName = details ? details.replace('متجر: ', '') : 'جهاز غير مسجل';
            db.run(
                `INSERT INTO devices (hwid, shop_name, status, trial_start, trial_end, created_at, updated_at, last_seen)
                 VALUES (?, ?, ?, date('now'), date('now', '+14 days'), ?, ?, ?)`,
                [hwid, shopName, status || 'trial', now, now, now],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    db.run('INSERT INTO heartbeats (hwid, timestamp, status, details) VALUES (?,?,?,?)',
                        [hwid, now, status, details]);
                    res.json({ success: true, created: true });
                }
            );
        }
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
// الحصول على العروض النشطة حالياً
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

// إضافة عرض جديد (للاستخدام من لوحة الإدارة)
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

// الحصول على جميع العروض (للاستخدام الإداري)
app.get('/api/promotions', (req, res) => {
    db.all('SELECT * FROM promotions ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows || [] });
    });
});

// حذف عرض
app.delete('/api/promotions/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM promotions WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ================== نظام التحديثات ==================

app.post('/api/updates', upload.single('update_file'), (req, res) => {
    const { version, required, notes } = req.body;
    if (!version) return res.status(400).json({ success: false, error: 'رقم الإصدار مطلوب' });
    
    const file = req.file;
    const filePath = file ? file.path : null;
    const fileName = file ? file.originalname : null;
    const fileSize = file ? file.size : 0;

    db.run(
        `INSERT OR REPLACE INTO updates (version, required, notes, file_path, file_name, file_size, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [version, required ? 1 : 0, notes || '', filePath, fileName, fileSize, new Date().toISOString()],
        function (err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.get('/api/updates/latest', (req, res) => {
    db.get('SELECT version, required, notes, file_name, file_size, created_at FROM updates ORDER BY created_at DESC LIMIT 1', (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ success: true, data: null });
        row.download_url = `/api/updates/download/${row.version}`;
        res.json({ success: true, data: row });
    });
});

app.get('/api/updates/download/:version', (req, res) => {
    const { version } = req.params;
    db.get('SELECT * FROM updates WHERE version = ?', [version], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !row.file_path) return res.status(404).json({ error: 'الملف غير موجود' });
        const absolutePath = path.resolve(row.file_path);
        if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: 'الملف غير موجود على الخادم' });
        res.download(absolutePath, row.file_name || 'update.exe');
    });
});

app.delete('/api/updates/:version', (req, res) => {
    const { version } = req.params;
    db.get('SELECT * FROM updates WHERE version = ?', [version], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
        db.run('DELETE FROM updates WHERE version = ?', [version], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
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
    // إلغاء تنشيط العروض المنتهية تلقائياً
    db.run(`UPDATE promotions SET is_active = 0 WHERE end_date < ? AND is_active = 1`, [now.toISOString()]);
}, 60 * 1000);

// ---- تشغيل الخادم ----
app.listen(PORT, () => {
    console.log(`🚀 License Server running on port ${PORT}`);
});