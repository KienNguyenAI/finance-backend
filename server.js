const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Connect to PostgreSQL via DATABASE_URL environment variable (set on Render)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Create tables if they don't exist on startup
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
 
        await pool.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS last_sync_time TIMESTAMP,
            ADD COLUMN IF NOT EXISTS last_sync_type VARCHAR(50)
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER NOT NULL,
                account_id INTEGER NOT NULL,
                title VARCHAR(255) NOT NULL,
                amount DOUBLE PRECISION NOT NULL,
                type VARCHAR(50) NOT NULL,
                category VARCHAR(255) NOT NULL,
                date BIGINT NOT NULL,
                note TEXT DEFAULT '',
                PRIMARY KEY (id, account_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER NOT NULL,
                account_id INTEGER NOT NULL,
                name VARCHAR(255) NOT NULL,
                color VARCHAR(50) NOT NULL,
                icon_name VARCHAR(255) NOT NULL,
                budget_limit BIGINT NOT NULL,
                PRIMARY KEY (id, account_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS savings_goals (
                id INTEGER NOT NULL,
                account_id INTEGER NOT NULL,
                title VARCHAR(255) NOT NULL,
                target_amount DOUBLE PRECISION NOT NULL,
                current_amount DOUBLE PRECISION NOT NULL,
                color VARCHAR(50) NOT NULL,
                icon_name VARCHAR(255) NOT NULL,
                PRIMARY KEY (id, account_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS monthly_budgets (
                id INTEGER NOT NULL,
                account_id INTEGER NOT NULL,
                month_year VARCHAR(50) NOT NULL,
                limit_amount DOUBLE PRECISION NOT NULL,
                PRIMARY KEY (id, account_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS recurring_transactions (
                id INTEGER NOT NULL,
                account_id INTEGER NOT NULL,
                title VARCHAR(255) NOT NULL,
                amount DOUBLE PRECISION NOT NULL,
                type VARCHAR(50) NOT NULL,
                category VARCHAR(255) NOT NULL,
                note TEXT DEFAULT '',
                frequency VARCHAR(50) NOT NULL,
                day_of_week INTEGER NOT NULL,
                day_of_month INTEGER NOT NULL,
                next_execution_date BIGINT NOT NULL,
                is_enabled BOOLEAN NOT NULL,
                created_date BIGINT NOT NULL,
                PRIMARY KEY (id, account_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS deleted_items (
                account_id INTEGER NOT NULL,
                entity_type VARCHAR(50) NOT NULL,
                entity_id VARCHAR(255) NOT NULL,
                deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (account_id, entity_type, entity_id)
            )
        `);
 
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sync_history (
                id SERIAL PRIMARY KEY,
                account_id INTEGER NOT NULL,
                sync_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                sync_type VARCHAR(50) NOT NULL,
                tx_count INTEGER DEFAULT 0,
                cat_count INTEGER DEFAULT 0,
                sg_count INTEGER DEFAULT 0,
                mb_count INTEGER DEFAULT 0,
                rt_count INTEGER DEFAULT 0
            )
        `);

        // Alter tables to add last_modified if not exists
        const tables = ['transactions', 'categories', 'savings_goals', 'monthly_budgets', 'recurring_transactions'];
        for (const table of tables) {
            await pool.query(`
                ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_modified BIGINT DEFAULT 0
            `);
        }

        console.log('Database tables initialized successfully.');
    } catch (err) {
        console.error('Failed to initialize database:', err.message);
    }
}

// Logger middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

const path = require('path');

// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Base Route - Admin Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 1. API Đăng ký
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Thiếu thông tin đăng ký' });
    }

    try {
        // Check if email already exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
            [email]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ message: 'Email này đã được đăng ký' });
        }

        // Insert new user
        const result = await pool.query(
            'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
            [name, email.toLowerCase(), password]
        );

        const newUser = result.rows[0];
        console.log(`Registered user: ${email} -> ID: ${newUser.id}`);

        // Return response matching RegisterResponse.kt DTO
        res.status(200).json({
            id: newUser.id,
            name: newUser.name,
            email: newUser.email
        });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ message: 'Lỗi hệ thống: ' + err.message });
    }
});

// 2. API Đăng nhập
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Thiếu email hoặc mật khẩu' });
    }

    try {
        const result = await pool.query(
            'SELECT id, name, email, password FROM users WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Email không tồn tại trên hệ thống' });
        }

        const user = result.rows[0];
        if (user.password !== password) {
            return res.status(401).json({ message: 'Mật khẩu không chính xác' });
        }

        console.log(`User logged in: ${email} -> ID: ${user.id}`);

        // Return response matching LoginResponse.kt DTO
        res.status(200).json({
            id: user.id,
            name: user.name,
            email: user.email,
            token: 'jwt-token-' + user.id
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ message: 'Lỗi hệ thống: ' + err.message });
    }
});

// 3. API Đồng bộ dữ liệu (Sync Comprehensive Data)
app.post('/api/sync/transactions', async (req, res) => {
    const { accountId, transactions, categories, savingsGoals, monthlyBudgets, recurringTransactions, isFirstSync, lastSyncTimestamp } = req.body;
    if (accountId === undefined) {
        return res.status(400).json({ message: 'Thiếu accountId hợp lệ' });
    }

    const clientLastSync = lastSyncTimestamp ? parseInt(lastSyncTimestamp) : 0;

    function normalizeString(str) {
        if (!str) return '';
        return str.toString().toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/[^a-z0-9]/g, '');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ==========================================
        // 1. Synchronize Categories
        // ==========================================
        const serverCatResult = await client.query('SELECT * FROM categories WHERE account_id = $1', [accountId]);
        const serverCats = serverCatResult.rows;
        const clientCats = categories || [];

        const deletedCatIds = new Set();
        if (clientLastSync > 0) {
            serverCats.forEach(sc => {
                const isSent = clientCats.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedCatIds.add(sc.id);
                }
            });
        }

        let maxCatId = Math.max(0, ...serverCats.map(r => r.id), ...clientCats.map(c => c.id));
        const clientCatIdMap = new Map();
        const activeCats = [];

        const serverCatById = new Map();
        serverCats.forEach(sc => {
            if (!deletedCatIds.has(sc.id)) {
                serverCatById.set(sc.id, sc);
            }
        });

        clientCats.forEach(cc => {
            const serverCat = serverCatById.get(cc.id);
            if (serverCat) {
                if (parseInt(serverCat.last_modified || 0) > clientLastSync) {
                    // ID Collision
                    maxCatId++;
                    const targetId = maxCatId;
                    activeCats.push({
                        id: targetId,
                        account_id: accountId,
                        name: cc.name,
                        color: cc.color,
                        icon_name: cc.iconName,
                        budget_limit: cc.budgetLimit || 0,
                        last_modified: Date.now()
                    });
                    clientCatIdMap.set(cc.id, targetId);
                } else {
                    // Update
                    const isChanged = serverCat.name !== cc.name ||
                                      serverCat.color !== cc.color ||
                                      serverCat.icon_name !== cc.iconName ||
                                      parseInt(serverCat.budget_limit) !== parseInt(cc.budgetLimit);
                    activeCats.push({
                        id: serverCat.id,
                        account_id: accountId,
                        name: cc.name,
                        color: cc.color,
                        icon_name: cc.iconName,
                        budget_limit: cc.budgetLimit || 0,
                        last_modified: isChanged ? Date.now() : parseInt(serverCat.last_modified || 0)
                    });
                    clientCatIdMap.set(cc.id, serverCat.id);
                    serverCatById.delete(cc.id);
                }
            } else {
                // New category
                activeCats.push({
                    id: cc.id,
                    account_id: accountId,
                    name: cc.name,
                    color: cc.color,
                    icon_name: cc.iconName,
                    budget_limit: cc.budgetLimit || 0,
                    last_modified: Date.now()
                });
                clientCatIdMap.set(cc.id, cc.id);
            }
        });

        serverCatById.forEach(sc => {
            activeCats.push({
                id: sc.id,
                account_id: accountId,
                name: sc.name,
                color: sc.color,
                icon_name: sc.icon_name,
                budget_limit: parseInt(sc.budget_limit || 0),
                last_modified: parseInt(sc.last_modified || 0)
            });
        });

        // Pass 2: Deduplicate by name
        const finalCats = [];
        const catByName = new Map();
        activeCats.forEach(cat => {
            const normName = normalizeString(cat.name);
            const existing = catByName.get(normName);
            if (existing) {
                existing.budget_limit = Math.max(existing.budget_limit, cat.budget_limit);
                if (cat.name !== normName && existing.name === normName) {
                    existing.name = cat.name;
                }
                clientCatIdMap.forEach((val, key) => {
                    if (val === cat.id) {
                        clientCatIdMap.set(key, existing.id);
                    }
                });
            } else {
                catByName.set(normName, cat);
                finalCats.push(cat);
            }
        });

        await client.query('DELETE FROM categories WHERE account_id = $1', [accountId]);
        for (const cat of finalCats) {
            await client.query(
                `INSERT INTO categories (id, account_id, name, color, icon_name, budget_limit, last_modified)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [cat.id, cat.account_id, cat.name, cat.color, cat.icon_name, cat.budget_limit, cat.last_modified]
            );
        }

        // ==========================================
        // 2. Synchronize Savings Goals
        // ==========================================
        const serverSgResult = await client.query('SELECT * FROM savings_goals WHERE account_id = $1', [accountId]);
        const serverSgs = serverSgResult.rows;
        const clientSgs = savingsGoals || [];

        const deletedSgIds = new Set();
        if (clientLastSync > 0) {
            serverSgs.forEach(sc => {
                const isSent = clientSgs.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedSgIds.add(sc.id);
                }
            });
        }

        let maxSgId = Math.max(0, ...serverSgs.map(r => r.id), ...clientSgs.map(s => s.id));
        const clientSgIdMap = new Map();
        const activeSgs = [];

        const serverSgById = new Map();
        serverSgs.forEach(sc => {
            if (!deletedSgIds.has(sc.id)) {
                serverSgById.set(sc.id, sc);
            }
        });

        clientSgs.forEach(csg => {
            const serverSg = serverSgById.get(csg.id);
            if (serverSg) {
                if (parseInt(serverSg.last_modified || 0) > clientLastSync) {
                    // ID Collision
                    maxSgId++;
                    const targetId = maxSgId;
                    activeSgs.push({
                        id: targetId,
                        account_id: accountId,
                        title: csg.title,
                        target_amount: csg.targetAmount,
                        current_amount: csg.currentAmount || 0,
                        color: csg.color,
                        icon_name: csg.iconName,
                        last_modified: Date.now()
                    });
                    clientSgIdMap.set(csg.id, targetId);
                } else {
                    // Update
                    const isChanged = serverSg.title !== csg.title ||
                                      serverSg.color !== csg.color ||
                                      serverSg.icon_name !== csg.iconName ||
                                      parseFloat(serverSg.target_amount) !== parseFloat(csg.targetAmount) ||
                                      parseFloat(serverSg.current_amount) !== parseFloat(csg.currentAmount);

                    activeSgs.push({
                        id: serverSg.id,
                        account_id: accountId,
                        title: csg.title,
                        target_amount: csg.targetAmount,
                        current_amount: csg.currentAmount || 0,
                        color: csg.color,
                        icon_name: csg.iconName,
                        last_modified: isChanged ? Date.now() : parseInt(serverSg.last_modified || 0)
                    });
                    clientSgIdMap.set(csg.id, serverSg.id);
                    serverSgById.delete(csg.id);
                }
            } else {
                // New goal
                activeSgs.push({
                    id: csg.id,
                    account_id: accountId,
                    title: csg.title,
                    target_amount: csg.targetAmount,
                    current_amount: csg.currentAmount || 0,
                    color: csg.color,
                    icon_name: csg.iconName,
                    last_modified: Date.now()
                });
                clientSgIdMap.set(csg.id, csg.id);
            }
        });

        serverSgById.forEach(sc => {
            activeSgs.push({
                id: sc.id,
                account_id: accountId,
                title: sc.title,
                target_amount: parseFloat(sc.target_amount),
                current_amount: parseFloat(sc.current_amount),
                color: sc.color,
                icon_name: sc.icon_name,
                last_modified: parseInt(sc.last_modified || 0)
            });
        });

        // Pass 2: Deduplicate by title
        const finalSgs = [];
        const sgByTitle = new Map();
        activeSgs.forEach(sg => {
            const normTitle = normalizeString(sg.title);
            const existing = sgByTitle.get(normTitle);
            if (existing) {
                const progressExisting = (existing.current_amount || 0) / (existing.target_amount || 1);
                const progressCurrent = (sg.current_amount || 0) / (sg.target_amount || 1);
                if (progressCurrent >= progressExisting) {
                    existing.title = sg.title;
                    existing.target_amount = sg.target_amount;
                    existing.current_amount = sg.current_amount;
                    existing.color = sg.color;
                    existing.icon_name = sg.icon_name;
                    existing.last_modified = Math.max(existing.last_modified, sg.last_modified);
                }
                clientSgIdMap.forEach((val, key) => {
                    if (val === sg.id) {
                        clientSgIdMap.set(key, existing.id);
                    }
                });
            } else {
                sgByTitle.set(normTitle, sg);
                finalSgs.push(sg);
            }
        });

        await client.query('DELETE FROM savings_goals WHERE account_id = $1', [accountId]);
        for (const sg of finalSgs) {
            await client.query(
                `INSERT INTO savings_goals (id, account_id, title, target_amount, current_amount, color, icon_name, last_modified)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [sg.id, sg.account_id, sg.title, sg.target_amount, sg.current_amount, sg.color, sg.icon_name, sg.last_modified]
            );
        }

        // ==========================================
        // 3. Synchronize Monthly Budgets
        // ==========================================
        const serverMbResult = await client.query('SELECT * FROM monthly_budgets WHERE account_id = $1', [accountId]);
        const serverMbs = serverMbResult.rows;
        const clientMbs = monthlyBudgets || [];

        const deletedMbIds = new Set();
        if (clientLastSync > 0) {
            serverMbs.forEach(sc => {
                const isSent = clientMbs.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedMbIds.add(sc.id);
                }
            });
        }

        let maxMbId = Math.max(0, ...serverMbs.map(r => r.id), ...clientMbs.map(b => b.id));
        const clientMbIdMap = new Map();
        const activeMbs = [];

        const serverMbById = new Map();
        serverMbs.forEach(sc => {
            if (!deletedMbIds.has(sc.id)) {
                serverMbById.set(sc.id, sc);
            }
        });

        clientMbs.forEach(cmb => {
            const serverMb = serverMbById.get(cmb.id);
            if (serverMb) {
                if (parseInt(serverMb.last_modified || 0) > clientLastSync) {
                    // ID Collision
                    maxMbId++;
                    const targetId = maxMbId;
                    activeMbs.push({
                        id: targetId,
                        account_id: accountId,
                        month_year: cmb.monthYear,
                        limit_amount: cmb.limitAmount,
                        last_modified: Date.now()
                    });
                    clientMbIdMap.set(cmb.id, targetId);
                } else {
                    // Update
                    const isChanged = serverMb.month_year !== cmb.monthYear ||
                                      parseFloat(serverMb.limit_amount) !== parseFloat(cmb.limitAmount);
                    activeMbs.push({
                        id: serverMb.id,
                        account_id: accountId,
                        month_year: cmb.monthYear,
                        limit_amount: cmb.limitAmount,
                        last_modified: isChanged ? Date.now() : parseInt(serverMb.last_modified || 0)
                    });
                    clientMbIdMap.set(cmb.id, serverMb.id);
                    serverMbById.delete(cmb.id);
                }
            } else {
                // New budget
                activeMbs.push({
                    id: cmb.id,
                    account_id: accountId,
                    month_year: cmb.monthYear,
                    limit_amount: cmb.limitAmount,
                    last_modified: Date.now()
                });
                clientMbIdMap.set(cmb.id, cmb.id);
            }
        });

        serverMbById.forEach(sc => {
            activeMbs.push({
                id: sc.id,
                account_id: accountId,
                month_year: sc.month_year,
                limit_amount: parseFloat(sc.limit_amount),
                last_modified: parseInt(sc.last_modified || 0)
            });
        });

        // Pass 2: Deduplicate by month_year
        const finalMbs = [];
        const mbByMonth = new Map();
        activeMbs.forEach(mb => {
            const existing = mbByMonth.get(mb.month_year);
            if (existing) {
                existing.limit_amount = mb.limit_amount;
                existing.last_modified = Math.max(existing.last_modified, mb.last_modified);
                clientMbIdMap.forEach((val, key) => {
                    if (val === mb.id) {
                        clientMbIdMap.set(key, existing.id);
                    }
                });
            } else {
                mbByMonth.set(mb.month_year, mb);
                finalMbs.push(mb);
            }
        });

        await client.query('DELETE FROM monthly_budgets WHERE account_id = $1', [accountId]);
        for (const mb of finalMbs) {
            await client.query(
                `INSERT INTO monthly_budgets (id, account_id, month_year, limit_amount, last_modified)
                 VALUES ($1, $2, $3, $4, $5)`,
                [mb.id, mb.account_id, mb.month_year, mb.limit_amount, mb.last_modified]
            );
        }

        // ==========================================
        // 4. Synchronize Recurring Transactions
        // ==========================================
        const serverRtResult = await client.query('SELECT * FROM recurring_transactions WHERE account_id = $1', [accountId]);
        const serverRts = serverRtResult.rows;
        const clientRts = recurringTransactions || [];

        const deletedRtIds = new Set();
        if (clientLastSync > 0) {
            serverRts.forEach(sc => {
                const isSent = clientRts.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedRtIds.add(sc.id);
                }
            });
        }

        let maxRtId = Math.max(0, ...serverRts.map(r => r.id), ...clientRts.map(r => r.id));
        const clientRtIdMap = new Map();
        const activeRts = [];

        const serverRtById = new Map();
        serverRts.forEach(sc => {
            if (!deletedRtIds.has(sc.id)) {
                serverRtById.set(sc.id, sc);
            }
        });

        clientRts.forEach(crt => {
            const serverRt = serverRtById.get(crt.id);
            if (serverRt) {
                if (parseInt(serverRt.last_modified || 0) > clientLastSync) {
                    // ID Collision
                    maxRtId++;
                    const targetId = maxRtId;
                    activeRts.push({
                        id: targetId,
                        account_id: accountId,
                        title: crt.title,
                        amount: crt.amount,
                        type: crt.type,
                        category: crt.category,
                        note: crt.note || '',
                        frequency: crt.frequency,
                        day_of_week: crt.dayOfWeek,
                        day_of_month: crt.dayOfMonth,
                        next_execution_date: crt.nextExecutionDate,
                        is_enabled: crt.isEnabled,
                        created_date: crt.createdDate,
                        last_modified: Date.now()
                    });
                    clientRtIdMap.set(crt.id, targetId);
                } else {
                    // Update
                    const isChanged = serverRt.title !== crt.title ||
                                      parseFloat(serverRt.amount) !== parseFloat(crt.amount) ||
                                      serverRt.type !== crt.type ||
                                      serverRt.category !== crt.category ||
                                      serverRt.note !== crt.note ||
                                      serverRt.frequency !== crt.frequency ||
                                      serverRt.day_of_week !== crt.dayOfWeek ||
                                      serverRt.day_of_month !== crt.dayOfMonth ||
                                      parseInt(serverRt.next_execution_date) !== parseInt(crt.nextExecutionDate) ||
                                      !!serverRt.is_enabled !== !!crt.isEnabled;

                    activeRts.push({
                        id: serverRt.id,
                        account_id: accountId,
                        title: crt.title,
                        amount: crt.amount,
                        type: crt.type,
                        category: crt.category,
                        note: crt.note || '',
                        frequency: crt.frequency,
                        day_of_week: crt.dayOfWeek,
                        day_of_month: crt.dayOfMonth,
                        next_execution_date: crt.nextExecutionDate,
                        is_enabled: crt.isEnabled,
                        created_date: crt.createdDate || parseInt(serverRt.created_date),
                        last_modified: isChanged ? Date.now() : parseInt(serverRt.last_modified || 0)
                    });
                    clientRtIdMap.set(crt.id, serverRt.id);
                    serverRtById.delete(crt.id);
                }
            } else {
                // New Rt
                activeRts.push({
                    id: crt.id,
                    account_id: accountId,
                    title: crt.title,
                    amount: crt.amount,
                    type: crt.type,
                    category: crt.category,
                    note: crt.note || '',
                    frequency: crt.frequency,
                    day_of_week: crt.dayOfWeek,
                    day_of_month: crt.dayOfMonth,
                    next_execution_date: crt.nextExecutionDate,
                    is_enabled: crt.isEnabled,
                    created_date: crt.createdDate,
                    last_modified: Date.now()
                });
                clientRtIdMap.set(crt.id, crt.id);
            }
        });

        serverRtById.forEach(sc => {
            activeRts.push({
                id: sc.id,
                account_id: accountId,
                title: sc.title,
                amount: parseFloat(sc.amount),
                type: sc.type,
                category: sc.category,
                note: sc.note || '',
                frequency: sc.frequency,
                day_of_week: sc.day_of_week,
                day_of_month: sc.day_of_month,
                next_execution_date: parseInt(sc.next_execution_date),
                is_enabled: !!sc.is_enabled,
                created_date: parseInt(sc.created_date),
                last_modified: parseInt(sc.last_modified || 0)
            });
        });

        // Pass 2: Deduplicate by title
        const finalRts = [];
        const rtByTitle = new Map();
        activeRts.forEach(rt => {
            const normTitle = normalizeString(rt.title);
            const existing = rtByTitle.get(normTitle);
            if (existing) {
                existing.amount = rt.amount;
                existing.is_enabled = rt.is_enabled;
                existing.next_execution_date = rt.next_execution_date;
                existing.last_modified = Math.max(existing.last_modified, rt.last_modified);
                clientRtIdMap.forEach((val, key) => {
                    if (val === rt.id) {
                        clientRtIdMap.set(key, existing.id);
                    }
                });
            } else {
                rtByTitle.set(normTitle, rt);
                finalRts.push(rt);
            }
        });

        await client.query('DELETE FROM recurring_transactions WHERE account_id = $1', [accountId]);
        for (const rt of finalRts) {
            await client.query(
                `INSERT INTO recurring_transactions (id, account_id, title, amount, type, category, note, frequency, day_of_week, day_of_month, next_execution_date, is_enabled, created_date, last_modified)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                [
                    rt.id, rt.account_id, rt.title, rt.amount, rt.type, rt.category, rt.note || '',
                    rt.frequency, rt.day_of_week, rt.day_of_month, rt.next_execution_date, rt.is_enabled, rt.created_date, rt.last_modified
                ]
            );
        }

        // ==========================================
        // 5. Synchronize Transactions
        // ==========================================
        const serverTxResult = await client.query('SELECT * FROM transactions WHERE account_id = $1', [accountId]);
        const serverTxs = serverTxResult.rows;
        const clientTxs = transactions || [];

        const deletedTxIds = new Set();
        if (clientLastSync > 0) {
            serverTxs.forEach(sc => {
                const isSent = clientTxs.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedTxIds.add(sc.id);
                }
            });
        }

        let maxTxId = Math.max(0, ...serverTxs.map(r => r.id), ...clientTxs.map(t => t.id));
        const clientTxIdMap = new Map();
        const activeTxs = [];

        const serverTxById = new Map();
        serverTxs.forEach(sc => {
            if (!deletedTxIds.has(sc.id)) {
                serverTxById.set(sc.id, sc);
            }
        });

        clientTxs.forEach(ct => {
            const serverTx = serverTxById.get(ct.id);
            if (serverTx) {
                if (parseInt(serverTx.last_modified || 0) > clientLastSync) {
                    // ID Collision
                    maxTxId++;
                    const targetId = maxTxId;
                    activeTxs.push({
                        id: targetId,
                        account_id: accountId,
                        title: ct.title,
                        amount: ct.amount,
                        type: ct.type,
                        category: ct.category,
                        date: ct.date,
                        note: ct.note || '',
                        last_modified: Date.now()
                    });
                    clientTxIdMap.set(ct.id, targetId);
                } else {
                    // Update
                    const isChanged = serverTx.title !== ct.title ||
                                      parseFloat(serverTx.amount) !== parseFloat(ct.amount) ||
                                      serverTx.type !== ct.type ||
                                      serverTx.category !== ct.category ||
                                      parseInt(serverTx.date) !== parseInt(ct.date) ||
                                      serverTx.note !== ct.note;

                    activeTxs.push({
                        id: serverTx.id,
                        account_id: accountId,
                        title: ct.title,
                        amount: ct.amount,
                        type: ct.type,
                        category: ct.category,
                        date: ct.date,
                        note: ct.note || '',
                        last_modified: isChanged ? Date.now() : parseInt(serverTx.last_modified || 0)
                    });
                    clientTxIdMap.set(ct.id, serverTx.id);
                    serverTxById.delete(ct.id);
                }
            } else {
                // New transaction
                activeTxs.push({
                    id: ct.id,
                    account_id: accountId,
                    title: ct.title,
                    amount: ct.amount,
                    type: ct.type,
                    category: ct.category,
                    date: ct.date,
                    note: ct.note || '',
                    last_modified: Date.now()
                });
                clientTxIdMap.set(ct.id, ct.id);
            }
        });

        serverTxById.forEach(sc => {
            activeTxs.push({
                id: sc.id,
                account_id: accountId,
                title: sc.title,
                amount: parseFloat(sc.amount),
                type: sc.type,
                category: sc.category,
                date: parseInt(sc.date),
                note: sc.note || '',
                last_modified: parseInt(sc.last_modified || 0)
            });
        });

        // Pass 2: Deduplicate by title + date + amount
        const finalTxs = [];
        const getTxKey = (title, date, amount) => {
            const normTitle = normalizeString(title);
            const day = Math.floor(parseInt(date) / (24 * 60 * 60 * 1000));
            const roundedAmount = Math.round(parseFloat(amount));
            return `${normTitle}_${day}_${roundedAmount}`;
        };
        const txByKey = new Map();
        activeTxs.forEach(tx => {
            const key = getTxKey(tx.title, tx.date, tx.amount);
            const existing = txByKey.get(key);
            if (existing) {
                existing.note = tx.note || existing.note;
                existing.last_modified = Math.max(existing.last_modified, tx.last_modified);
                clientTxIdMap.forEach((val, key) => {
                    if (val === tx.id) {
                        clientTxIdMap.set(key, existing.id);
                    }
                });
            } else {
                txByKey.set(key, tx);
                finalTxs.push(tx);
            }
        });

        await client.query('DELETE FROM transactions WHERE account_id = $1', [accountId]);
        for (const tx of finalTxs) {
            await client.query(
                `INSERT INTO transactions (id, account_id, title, amount, type, category, date, note, last_modified)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [tx.id, tx.account_id, tx.title, tx.amount, tx.type, tx.category, tx.date, tx.note || '', tx.last_modified]
            );
        }

        const clientHasChanges = 
            !!isFirstSync ||
            (clientCats.length > 0 && clientCats.some(cc => {
                const s = serverCats.find(sc => sc.id === cc.id);
                return !s || s.name !== cc.name || s.color !== cc.color || s.icon_name !== cc.icon_name || parseInt(s.budget_limit) !== parseInt(cc.budgetLimit);
            })) ||
            (clientSgs.length > 0 && clientSgs.some(csg => {
                const s = serverSgs.find(ss => ss.id === csg.id);
                return !s || s.title !== csg.title || s.color !== csg.color || s.icon_name !== csg.icon_name || parseFloat(s.target_amount) !== parseFloat(csg.targetAmount) || parseFloat(s.current_amount) !== parseFloat(csg.currentAmount);
            })) ||
            (clientMbs.length > 0 && clientMbs.some(cmb => {
                const s = serverMbs.find(sm => sm.id === cmb.id);
                return !s || s.month_year !== cmb.monthYear || parseFloat(s.limit_amount) !== parseFloat(cmb.limitAmount);
            })) ||
            (clientTxs.length > 0 && clientTxs.some(ct => {
                const s = serverTxs.find(st => st.id === ct.id);
                return !s || s.title !== ct.title || parseFloat(s.amount) !== parseFloat(ct.amount) || s.type !== ct.type || s.category !== ct.category || parseInt(s.date) !== parseInt(ct.date) || s.note !== ct.note;
            })) ||
            (clientRts.length > 0 && clientRts.some(crt => {
                const s = serverRts.find(sr => sr.id === crt.id);
                return !s || s.title !== crt.title || parseFloat(s.amount) !== parseFloat(crt.amount) || s.type !== crt.type || s.category !== crt.category || s.note !== crt.note || s.frequency !== crt.frequency || s.day_of_week !== crt.dayOfWeek || s.day_of_month !== crt.dayOfMonth || parseInt(s.next_execution_date) !== parseInt(crt.nextExecutionDate) || !!s.is_enabled !== !!crt.isEnabled;
            })) ||
            (deletedCatIds && deletedCatIds.size > 0) ||
            (deletedSgIds && deletedSgIds.size > 0) ||
            (deletedMbIds && deletedMbIds.size > 0) ||
            (deletedTxIds && deletedTxIds.size > 0) ||
            (deletedRtIds && deletedRtIds.size > 0);

        const syncType = clientHasChanges ? 'UPDATE' : 'GET';
        await client.query('UPDATE users SET last_sync_time = CURRENT_TIMESTAMP, last_sync_type = $1 WHERE id = $2', [syncType, accountId]);

        await client.query(`
            INSERT INTO sync_history (account_id, sync_type, tx_count, cat_count, sg_count, mb_count, rt_count)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [accountId, syncType, clientTxs.length, clientCats.length, clientSgs.length, clientMbs.length, clientRts.length]);

        await client.query('COMMIT');

        // Map lists to response structures matching DTOs
        const responseTxs = finalTxs.map(tx => ({
            id: tx.id,
            title: tx.title,
            amount: parseFloat(tx.amount),
            type: tx.type,
            category: tx.category,
            date: parseInt(tx.date),
            note: tx.note || '',
            accountId: tx.account_id
        }));

        const responseCats = finalCats.map(cat => ({
            id: cat.id,
            name: cat.name,
            color: cat.color,
            iconName: cat.icon_name,
            budgetLimit: parseInt(cat.budget_limit),
            accountId: cat.account_id
        }));

        const responseSgs = finalSgs.map(sg => ({
            id: sg.id,
            title: sg.title,
            targetAmount: parseFloat(sg.target_amount),
            currentAmount: parseFloat(sg.current_amount),
            color: sg.color,
            iconName: sg.icon_name,
            accountId: sg.account_id
        }));

        const responseMbs = finalMbs.map(mb => ({
            id: mb.id,
            monthYear: mb.month_year,
            limitAmount: parseFloat(mb.limit_amount),
            accountId: mb.account_id
        }));

        const responseRts = finalRts.map(rt => ({
            id: rt.id,
            title: rt.title,
            amount: parseFloat(rt.amount),
            type: rt.type,
            category: rt.category,
            note: rt.note || '',
            frequency: rt.frequency,
            dayOfWeek: rt.day_of_week,
            dayOfMonth: rt.day_of_month,
            nextExecutionDate: parseInt(rt.next_execution_date),
            isEnabled: !!rt.is_enabled,
            createdDate: parseInt(rt.created_date),
            accountId: rt.account_id
        }));

        console.log(`Sync complete for accountId ${accountId}: ${responseTxs.length} txs, ${responseCats.length} cats, ${responseSgs.length} sgs, ${responseMbs.length} mbs, ${responseRts.length} rts.`);
        
        res.status(200).json({
            transactions: responseTxs,
            categories: responseCats,
            savingsGoals: responseSgs,
            monthlyBudgets: responseMbs,
            recurringTransactions: responseRts
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Sync error:', err.message);
        res.status(500).json({ message: 'Lỗi đồng bộ: ' + err.message });
    } finally {
        client.release();
    }
});

// 4. API Thống kê cho Admin Dashboard
app.get('/api/admin/summary', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                u.id, 
                u.name, 
                u.email, 
                u.created_at, 
                u.last_sync_time,
                u.last_sync_type,
                (SELECT COUNT(*)::integer FROM transactions WHERE account_id = u.id) as transaction_count,
                (SELECT COUNT(*)::integer FROM categories WHERE account_id = u.id) as category_count,
                (SELECT COUNT(*)::integer FROM savings_goals WHERE account_id = u.id) as savings_goal_count,
                (SELECT COUNT(*)::integer FROM monthly_budgets WHERE account_id = u.id) as monthly_budget_count,
                (SELECT COUNT(*)::integer FROM recurring_transactions WHERE account_id = u.id) as recurring_transaction_count
            FROM users u
            ORDER BY u.created_at DESC
        `);
        
        const totalUsers = result.rows.length;
        const totalTransactionsRes = await pool.query('SELECT COUNT(*)::integer as count FROM transactions');
        const totalTransactions = totalTransactionsRes.rows[0].count;

        res.status(200).json({
            users: result.rows,
            metrics: {
                totalUsers,
                totalTransactions
            }
        });
    } catch (err) {
        console.error('Admin summary error:', err.message);
        res.status(500).json({ message: 'Lỗi hệ thống: ' + err.message });
    }
});

// 5. API Lấy giao dịch chi tiết của 1 user (cho admin)
app.get('/api/admin/users/:id/transactions', async (req, res) => {
    const userId = req.params.id;
    try {
        const result = await pool.query(
            'SELECT id, title, amount, type, category, date, note FROM transactions WHERE account_id = $1 ORDER BY date DESC',
            [userId]
        );
        res.status(200).json({ transactions: result.rows });
    } catch (err) {
        console.error('Admin transactions error:', err.message);
        res.status(500).json({ message: 'Lỗi hệ thống: ' + err.message });
    }
});

// 6. API Lấy lịch sử đồng bộ của 1 user (cho admin)
app.get('/api/admin/users/:id/sync-history', async (req, res) => {
    const userId = req.params.id;
    try {
        const result = await pool.query(
            'SELECT id, sync_time, sync_type, tx_count, cat_count, sg_count, mb_count, rt_count FROM sync_history WHERE account_id = $1 ORDER BY sync_time DESC LIMIT 100',
            [userId]
        );
        res.status(200).json({ history: result.rows });
    } catch (err) {
        console.error('Admin sync history error:', err.message);
        res.status(500).json({ message: 'Lỗi hệ thống: ' + err.message });
    }
});

// Start Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server is running on port ${PORT}`);
    await initDatabase();
});
