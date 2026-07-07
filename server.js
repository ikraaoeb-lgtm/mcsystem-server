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

const storage = multer.memoryStorage();
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
        license_signature TEXT,
        applied_code TEXT
    )`, (err) => {
        if (err) console.error('❌ فشل إنشاء جدول devices:', err.message);
        else console.log('✅ جدول devices جاهز');
    });

    // إضافة عمود applied_code إذا كان الجدول موجود مسبقاً
    db.run(`ALTER TABLE devices ADD COLUMN applied_code TEXT`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS sub_devices (
        hwid TEXT PRIMARY KEY,
        parent_hwid TEXT NOT NULL,
        name TEXT,
        ip TEXT,
        approved_at TEXT
    )`);

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

    db.run(`CREATE TABLE IF NOT EXISTS activation_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        batch TEXT,
        created_at TEXT NOT NULL,
        used INTEGER DEFAULT 0,
        used_by_hwid TEXT,
        used_at TEXT
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

    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (row) {
            if (extraData) {
                db.run(
                    `UPDATE devices SET shop_name = ?, manager_name = ?, email = ?, phone = ?, last_seen = ?, updated_at = ? WHERE hwid = ?`,
                    [shopName, managerName, email, phone, now, now, hwid]
                );
            } else {
                db.run('UPDATE devices SET last_seen = ? WHERE hwid = ?', [now, hwid]);
            }
            db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err2, updatedRow) => {
                callback(err2, updatedRow);
            });
        } else {
            db.run(
                `INSERT INTO devices (hwid, shop_name, manager_name, email, phone, status, trial_start, trial_end, created_at, updated_at, last_seen)
                 VALUES (?, ?, ?, ?, ?, 'trial', date('now'), date('now', '+14 days'), ?, ?, ?)`,
                [hwid, shopName, managerName, email, phone, now, now, now],
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

function generateComplexCode(prefix = 'MC', segmentLength = 4, segments = 4) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const parts = [];
    for (let i = 0; i < segments; i++) {
        let segment = '';
        for (let j = 0; j < segmentLength; j++) {
            segment += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        parts.push(segment);
    }
    return `${prefix}-${parts.join('-')}`;
}

function applyDiscountToDevice(hwid, discountCode, callback) {
    if (!discountCode) return callback(null, { applied: false });

    db.get('SELECT * FROM discount_codes WHERE code = ?', [discountCode], (err, dc) => {
        if (err) return callback(err);
        if (!dc) return callback(null, { applied: false, error: 'كود غير صحيح' });
        if (dc.expires_at && new Date(dc.expires_at) < new Date())
            return callback(null, { applied: false, error: 'كود منتهي الصلاحية' });
        if (dc.max_uses && dc.used_count >= dc.max_uses)
            return callback(null, { applied: false, error: 'تم استنفاذ الاستخدام' });

        db.run('UPDATE discount_codes SET used_count = used_count + 1 WHERE code = ?', [discountCode]);

        db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, device) => {
            if (err) return callback(err);
            if (!device) return callback(null, { applied: false, error: 'جهاز غير موجود' });

            // تسجيل الكود المستخدم
            db.run('UPDATE devices SET applied_code = ? WHERE hwid = ?', [discountCode, hwid]);

            const now = new Date().toISOString();
            let updateFields = [];
            let params = [];

            switch (dc.type) {
                case 'trial_extend':
                    const days = dc.value || 14;
                    const newTrialEnd = new Date();
                    newTrialEnd.setDate(newTrialEnd.getDate() + days);
                    const trialEndStr = newTrialEnd.toISOString().split('T')[0];
                    updateFields.push('trial_end = ?', 'server_trial_end = ?', 'status = ?');
                    params.push(trialEndStr, trialEndStr, 'trial');
                    break;
                case 'subscription_extend':
                    const months = dc.value || 1;
                    const newSubEnd = new Date(device.subscription_end || now);
                    newSubEnd.setMonth(newSubEnd.getMonth() + months);
                    const subEndStr = newSubEnd.toISOString().split('T')[0];
                    updateFields.push('subscription_end = ?', 'server_subscription_end = ?', 'status = ?', 'activation_type = ?');
                    params.push(subEndStr, subEndStr, 'activated', 'subscription');
                    break;
                default:
                    break;
            }

            if (updateFields.length > 0) {
                updateFields.push('license_version = license_version + 1', 'updated_at = ?');
                params.push(now);
                params.push(hwid);
                db.run(`UPDATE devices SET ${updateFields.join(', ')} WHERE hwid = ?`, params, (err) => {
                    if (err) return callback(err);
                    callback(null, { applied: true, type: dc.type, value: dc.value });
                });
            } else {
                callback(null, { applied: true, type: dc.type, value: dc.value });
            }
        });
    });
}

// ====================== API Routes ======================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// الحصول على جميع الأجهزة (مع عدد الأجهزة الفرعية)
app.get('/api/devices', (req, res) => {
    db.all(`SELECT d.*, (SELECT COUNT(*) FROM sub_devices WHERE parent_hwid = d.hwid) as sub_count
            FROM devices d ORDER BY d.created_at DESC`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// الأجهزة الفرعية المرتبطة بجهاز رئيسي
app.get('/api/devices/:hwid/sub', (req, res) => {
    db.all('SELECT * FROM sub_devices WHERE parent_hwid = ?', [req.params.hwid], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

// تسجيل جهاز جديد
app.post('/api/devices/register', (req, res) => {
    const { hwid, shop_name, manager_name, email, phone, type, activation_type, discount_code } = req.body;
    if (!hwid) return res.status(400).json({ success: false, error: 'HWID required' });

    const now = new Date().toISOString();

    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            db.run(
                `UPDATE devices SET shop_name = ?, manager_name = ?, email = ?, phone = ?, last_seen = ?, updated_at = ? WHERE hwid = ?`,
                [shop_name || row.shop_name, manager_name || row.manager_name, email || row.email, phone || row.phone, now, now, hwid],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    if (discount_code) {
                        db.run('UPDATE devices SET applied_code = ? WHERE hwid = ?', [discount_code, hwid]);
                        applyDiscountToDevice(hwid, discount_code, (err, result) => {
                            if (err) console.error(err);
                        });
                    }

                    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err2, updatedRow) => {
                        if (err2) return res.status(500).json({ error: err2.message });
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
                }
            );
            return;
        }

        // جهاز جديد
        let status = 'trial';
        let trial_start = new Date().toISOString().split('T')[0];
        db.get('SELECT value FROM settings WHERE key = ?', ['trial_days'], (err, settingRow) => {
            const trialDays = parseInt(settingRow?.value || '14');
            const end = new Date();
            end.setDate(end.getDate() + trialDays);
            const trial_end = end.toISOString().split('T')[0];
            const secret = crypto.randomBytes(16).toString('hex');

            db.run(
                `INSERT INTO devices (hwid, device_secret, shop_name, manager_name, email, phone, status, activation_type, trial_start, trial_end, server_trial_end, created_at, updated_at, last_seen)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [hwid, secret, shop_name, manager_name, email, phone, status, activation_type || null, trial_start, trial_end, trial_end, now, now, now],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });

                    if (discount_code) {
                        db.run('UPDATE devices SET applied_code = ? WHERE hwid = ?', [discount_code, hwid]);
                        applyDiscountToDevice(hwid, discount_code, (err, result) => {
                            if (err) console.error(err);
                            db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, updatedDevice) => {
                                const payload = {
                                    status: updatedDevice.status,
                                    trial_end: updatedDevice.server_trial_end || updatedDevice.trial_end,
                                    subscription_end: updatedDevice.server_subscription_end || updatedDevice.subscription_end,
                                    license_version: updatedDevice.license_version,
                                    hwid
                                };
                                const signature = signPayload(payload);
                                res.json({ success: true, data: { ...payload, signature } });
                            });
                            return;
                        });
                    } else {
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
                }
            );
        });
    });
});

// التحقق من حالة التفعيل
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

// مزامنة
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

// تفعيل / حظر / تعديل
app.put('/api/devices/:hwid', (req, res) => {
    const { hwid } = req.params;
    const { status, activation_type, subscription_months, shop_name, phone, discount_code } = req.body;
    db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Not found' });
        const newVersion = row.license_version + 1;
        const now = new Date().toISOString();
        let updates = { status, license_version: newVersion, updated_at: now };
        
        if (shop_name !== undefined) updates.shop_name = shop_name;
        if (phone !== undefined) updates.phone = phone;

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

        if (discount_code) {
            updates.applied_code = discount_code;
        }

        const sql = `UPDATE devices SET ${Object.keys(updates).map(k => `${k}=?`).join(', ')} WHERE hwid=?`;
        const params = [...Object.values(updates), hwid];

        db.run(sql, params, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            if (discount_code) {
                applyDiscountToDevice(hwid, discount_code, (err, result) => {
                    if (err) console.error(err);
                });
            }
            
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
        // حذف الأجهزة الفرعية المرتبطة
        db.run('DELETE FROM sub_devices WHERE parent_hwid = ?', [hwid]);
        res.json({ success: true });
    });
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

app.delete('/api/discount-codes/:code', (req, res) => {
    const { code } = req.params;
    db.run('DELETE FROM discount_codes WHERE code = ?', [code], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ================== أكواد التفعيل الدائم ==================
app.post('/api/activation-codes/generate', (req, res) => {
    const { count, label } = req.body;
    const num = parseInt(count) || 1;
    const batch = label || null;
    const codes = [];
    const now = new Date().toISOString();

    for (let i = 0; i < num; i++) {
        const code = generateComplexCode();
        codes.push(code);
        db.run('INSERT INTO activation_codes (code, batch, created_at) VALUES (?, ?, ?)', [code, batch, now]);
    }

    res.json({ success: true, codes, batch });
});

app.post('/api/activation-codes/redeem', (req, res) => {
    const { hwid, code } = req.body;
    if (!hwid || !code) return res.status(400).json({ error: 'HWID and code required' });

    db.get('SELECT * FROM activation_codes WHERE code = ?', [code], (err, activationCode) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!activationCode) return res.json({ success: false, error: 'كود غير صحيح' });
        if (activationCode.used) return res.json({ success: false, error: 'الكود مستخدم مسبقاً' });

        db.get('SELECT * FROM devices WHERE hwid = ?', [hwid], (err, device) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!device) return res.json({ success: false, error: 'جهاز غير معروف' });

            const now = new Date().toISOString();
            const appliedLabel = activationCode.batch ? `تفعيل: ${activationCode.batch}` : `كود: ${code}`;
            db.run(
                `UPDATE devices SET status = 'activated', activation_type = 'permanent', subscription_end = NULL, server_subscription_end = NULL, applied_code = ?, activated_at = ?, license_version = license_version + 1, updated_at = ? WHERE hwid = ?`,
                [appliedLabel, now, now, hwid],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    db.run(
                        `UPDATE activation_codes SET used = 1, used_by_hwid = ?, used_at = ? WHERE code = ?`,
                        [hwid, now, code]
                    );

                    res.json({ success: true, message: 'تم التفعيل الدائم بنجاح' });
                }
            );
        });
    });
});

app.get('/api/activation-codes', (req, res) => {
    db.all('SELECT * FROM activation_codes ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.delete('/api/activation-codes/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM activation_codes WHERE id = ? AND used = 0', [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
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

// ================== نظام التحديثات ==================
app.post('/api/updates/sync', async (req, res) => {
    try {
        const result = await syncUpdateFromGitHub();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

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

app.post('/api/updates', (req, res) => {
    const { version, release_date, notes, file_url, file_size, mandatory, channel, min_version } = req.body;
    if (!version || !file_url) return res.status(400).json({ error: 'Version and file_url are required' });

    db.run(
        `INSERT INTO updates (version, release_date, notes, file_url, file_size, mandatory, channel, min_version) VALUES (?,?,?,?,?,?,?,?)`,
        [version, release_date || new Date().toISOString(), notes, file_url, file_size || 0, mandatory ? 1 : 0, channel || 'stable', min_version || '1.0.0'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.get('/api/updates', (req, res) => {
    db.all('SELECT * FROM updates ORDER BY release_date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, data: rows });
    });
});

app.delete('/api/updates/:version', (req, res) => {
    const { version } = req.params;
    db.run('DELETE FROM updates WHERE version = ?', [version], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ================== قاعدة البيانات ==================
app.get('/api/database/download', (req, res) => {
    if (fs.existsSync(dbPath)) {
        res.download(dbPath, 'mcpos.db');
    } else {
        res.status(404).json({ error: 'قاعدة البيانات غير موجودة' });
    }
});

app.post('/api/database/upload', upload.single('database'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم إرسال ملف' });

    try {
        const backupPath = dbPath + '.backup_' + Date.now();
        fs.copyFileSync(dbPath, backupPath);
        fs.writeFileSync(dbPath, req.file.buffer);
        db.close();
        const newDb = new sqlite3.Database(dbPath);
        newDb.run('PRAGMA journal_mode=WAL;');
        res.json({ success: true, message: 'تم استبدال قاعدة البيانات بنجاح' });
    } catch (e) {
        res.status(500).json({ error: 'فشل استبدال قاعدة البيانات: ' + e.message });
    }
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