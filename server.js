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
        const mergedCats = [];
        const clientCatIdMap = new Map(); // Maps client original ID -> target ID

        const deletedCatIds = new Set();
        if (clientLastSync > 0) {
            serverCats.forEach(sc => {
                const isSent = clientCats.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedCatIds.add(sc.id);
                }
            });
        }

        const activeServerCats = serverCats.filter(sc => !deletedCatIds.has(sc.id));
        const activeServerCatByName = new Map();
        activeServerCats.forEach(row => {
            activeServerCatByName.set(normalizeString(row.name), row);
        });

        let maxCatId = Math.max(0, ...serverCats.map(r => r.id), ...clientCats.map(c => c.id));

        clientCats.forEach(cc => {
            const normName = normalizeString(cc.name);
            const serverCat = activeServerCatByName.get(normName);

            if (serverCat) {
                const isChanged = serverCat.color !== cc.color ||
                                  serverCat.icon_name !== cc.iconName ||
                                  parseInt(serverCat.budget_limit) !== parseInt(cc.budgetLimit);
                
                const mergedCat = {
                    id: serverCat.id,
                    account_id: accountId,
                    name: cc.name,
                    color: cc.color,
                    icon_name: cc.iconName,
                    budget_limit: Math.max(parseInt(serverCat.budget_limit || 0), parseInt(cc.budgetLimit || 0)),
                    last_modified: isChanged ? Date.now() : parseInt(serverCat.last_modified || 0)
                };
                mergedCats.push(mergedCat);
                clientCatIdMap.set(cc.id, serverCat.id);
                activeServerCatByName.delete(normName);
            } else {
                const idExists = activeServerCats.some(sc => sc.id === cc.id);
                let targetId = cc.id;
                if (idExists) {
                    maxCatId++;
                    targetId = maxCatId;
                }
                const newCat = {
                    id: targetId,
                    account_id: accountId,
                    name: cc.name,
                    color: cc.color,
                    icon_name: cc.iconName,
                    budget_limit: cc.budgetLimit || 0,
                    last_modified: Date.now()
                };
                mergedCats.push(newCat);
                clientCatIdMap.set(cc.id, targetId);
            }
        });

        activeServerCatByName.forEach(sc => {
            mergedCats.push({
                id: sc.id,
                account_id: accountId,
                name: sc.name,
                color: sc.color,
                icon_name: sc.icon_name,
                budget_limit: parseInt(sc.budget_limit || 0),
                last_modified: parseInt(sc.last_modified || 0)
            });
        });

        await client.query('DELETE FROM categories WHERE account_id = $1', [accountId]);
        for (const cat of mergedCats) {
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
        const mergedSgs = [];

        const deletedSgIds = new Set();
        if (clientLastSync > 0) {
            serverSgs.forEach(sc => {
                const isSent = clientSgs.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedSgIds.add(sc.id);
                }
            });
        }

        const activeServerSgs = serverSgs.filter(sc => !deletedSgIds.has(sc.id));
        const activeServerSgByTitle = new Map();
        activeServerSgs.forEach(row => {
            activeServerSgByTitle.set(normalizeString(row.title), row);
        });

        let maxSgId = Math.max(0, ...serverSgs.map(r => r.id), ...clientSgs.map(s => s.id));

        clientSgs.forEach(csg => {
            const normTitle = normalizeString(csg.title);
            const serverSg = activeServerSgByTitle.get(normTitle);

            if (serverSg) {
                const isChanged = serverSg.color !== csg.color ||
                                  serverSg.icon_name !== csg.iconName ||
                                  parseFloat(serverSg.target_amount) !== parseFloat(csg.targetAmount) ||
                                  parseFloat(serverSg.current_amount) !== parseFloat(csg.currentAmount);

                const progressServer = parseFloat(serverSg.current_amount || 0) / parseFloat(serverSg.target_amount || 1);
                const progressClient = parseFloat(csg.currentAmount || 0) / parseFloat(csg.targetAmount || 1);
                const keepClientAmount = progressClient >= progressServer;

                const mergedSg = {
                    id: serverSg.id,
                    account_id: accountId,
                    title: csg.title,
                    target_amount: keepClientAmount ? csg.targetAmount : parseFloat(serverSg.target_amount),
                    current_amount: keepClientAmount ? csg.currentAmount : parseFloat(serverSg.current_amount),
                    color: csg.color,
                    icon_name: csg.iconName,
                    last_modified: isChanged ? Date.now() : parseInt(serverSg.last_modified || 0)
                };
                mergedSgs.push(mergedSg);
                activeServerSgByTitle.delete(normTitle);
            } else {
                const idExists = activeServerSgs.some(sc => sc.id === csg.id);
                let targetId = csg.id;
                if (idExists) {
                    maxSgId++;
                    targetId = maxSgId;
                }
                mergedSgs.push({
                    id: targetId,
                    account_id: accountId,
                    title: csg.title,
                    target_amount: csg.targetAmount,
                    current_amount: csg.currentAmount || 0,
                    color: csg.color,
                    icon_name: csg.iconName,
                    last_modified: Date.now()
                });
            }
        });

        activeServerSgByTitle.forEach(sc => {
            mergedSgs.push({
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

        await client.query('DELETE FROM savings_goals WHERE account_id = $1', [accountId]);
        for (const sg of mergedSgs) {
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
        const mergedMbs = [];

        const deletedMbIds = new Set();
        if (clientLastSync > 0) {
            serverMbs.forEach(sc => {
                const isSent = clientMbs.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedMbIds.add(sc.id);
                }
            });
        }

        const activeServerMbs = serverMbs.filter(sc => !deletedMbIds.has(sc.id));
        const activeServerMbByMonth = new Map();
        activeServerMbs.forEach(row => {
            activeServerMbByMonth.set(row.month_year, row);
        });

        let maxMbId = Math.max(0, ...serverMbs.map(r => r.id), ...clientMbs.map(b => b.id));

        clientMbs.forEach(cmb => {
            const serverMb = activeServerMbByMonth.get(cmb.monthYear);

            if (serverMb) {
                const isChanged = parseFloat(serverMb.limit_amount) !== parseFloat(cmb.limitAmount);
                const mergedMb = {
                    id: serverMb.id,
                    account_id: accountId,
                    month_year: cmb.monthYear,
                    limit_amount: cmb.limitAmount,
                    last_modified: isChanged ? Date.now() : parseInt(serverMb.last_modified || 0)
                };
                mergedMbs.push(mergedMb);
                activeServerMbByMonth.delete(cmb.monthYear);
            } else {
                const idExists = activeServerMbs.some(sc => sc.id === cmb.id);
                let targetId = cmb.id;
                if (idExists) {
                    maxMbId++;
                    targetId = maxMbId;
                }
                mergedMbs.push({
                    id: targetId,
                    account_id: accountId,
                    month_year: cmb.monthYear,
                    limit_amount: cmb.limitAmount,
                    last_modified: Date.now()
                });
            }
        });

        activeServerMbByMonth.forEach(sc => {
            mergedMbs.push({
                id: sc.id,
                account_id: accountId,
                month_year: sc.month_year,
                limit_amount: parseFloat(sc.limit_amount),
                last_modified: parseInt(sc.last_modified || 0)
            });
        });

        await client.query('DELETE FROM monthly_budgets WHERE account_id = $1', [accountId]);
        for (const mb of mergedMbs) {
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
        const mergedRts = [];

        const deletedRtIds = new Set();
        if (clientLastSync > 0) {
            serverRts.forEach(sc => {
                const isSent = clientRts.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedRtIds.add(sc.id);
                }
            });
        }

        const activeServerRts = serverRts.filter(sc => !deletedRtIds.has(sc.id));
        const activeServerRtByTitle = new Map();
        activeServerRts.forEach(row => {
            activeServerRtByTitle.set(normalizeString(row.title), row);
        });

        let maxRtId = Math.max(0, ...serverRts.map(r => r.id), ...clientRts.map(r => r.id));

        clientRts.forEach(crt => {
            const normTitle = normalizeString(crt.title);
            const serverRt = activeServerRtByTitle.get(normTitle);

            if (serverRt) {
                const isChanged = parseFloat(serverRt.amount) !== parseFloat(crt.amount) ||
                                  serverRt.type !== crt.type ||
                                  serverRt.category !== crt.category ||
                                  serverRt.note !== crt.note ||
                                  serverRt.frequency !== crt.frequency ||
                                  serverRt.day_of_week !== crt.dayOfWeek ||
                                  serverRt.day_of_month !== crt.dayOfMonth ||
                                  parseInt(serverRt.next_execution_date) !== parseInt(crt.nextExecutionDate) ||
                                  !!serverRt.is_enabled !== !!crt.isEnabled;

                const mergedRt = {
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
                };
                mergedRts.push(mergedRt);
                activeServerRtByTitle.delete(normTitle);
            } else {
                const idExists = activeServerRts.some(sc => sc.id === crt.id);
                let targetId = crt.id;
                if (idExists) {
                    maxRtId++;
                    targetId = maxRtId;
                }
                mergedRts.push({
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
            }
        });

        activeServerRtByTitle.forEach(sc => {
            mergedRts.push({
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

        await client.query('DELETE FROM recurring_transactions WHERE account_id = $1', [accountId]);
        for (const rt of mergedRts) {
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
        const mergedTxs = [];

        const getTxKey = (title, date, amount) => {
            const normTitle = normalizeString(title);
            const day = Math.floor(parseInt(date) / (24 * 60 * 60 * 1000));
            const roundedAmount = Math.round(parseFloat(amount));
            return `${normTitle}_${day}_${roundedAmount}`;
        };

        const deletedTxIds = new Set();
        if (clientLastSync > 0) {
            serverTxs.forEach(sc => {
                const isSent = clientTxs.some(cc => cc.id === sc.id);
                if (!isSent && parseInt(sc.last_modified || 0) <= clientLastSync) {
                    deletedTxIds.add(sc.id);
                }
            });
        }

        const activeServerTxs = serverTxs.filter(sc => !deletedTxIds.has(sc.id));
        const activeServerTxByKey = new Map();
        activeServerTxs.forEach(row => {
            const key = getTxKey(row.title, row.date, row.amount);
            activeServerTxByKey.set(key, row);
        });

        let maxTxId = Math.max(0, ...serverTxs.map(r => r.id), ...clientTxs.map(t => t.id));

        clientTxs.forEach(ct => {
            const key = getTxKey(ct.title, ct.date, ct.amount);
            const serverTx = activeServerTxByKey.get(key);

            if (serverTx) {
                const isChanged = serverTx.note !== ct.note ||
                                  serverTx.category !== ct.category ||
                                  serverTx.type !== ct.type;

                const mergedTx = {
                    id: serverTx.id,
                    account_id: accountId,
                    title: ct.title,
                    amount: ct.amount,
                    type: ct.type,
                    category: ct.category,
                    date: ct.date,
                    note: ct.note || '',
                    last_modified: isChanged ? Date.now() : parseInt(serverTx.last_modified || 0)
                };
                mergedTxs.push(mergedTx);
                activeServerTxByKey.delete(key);
            } else {
                const idExists = activeServerTxs.some(sc => sc.id === ct.id);
                let targetId = ct.id;
                if (idExists) {
                    maxTxId++;
                    targetId = maxTxId;
                }
                mergedTxs.push({
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
            }
        });

        activeServerTxByKey.forEach(sc => {
            mergedTxs.push({
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

        await client.query('DELETE FROM transactions WHERE account_id = $1', [accountId]);
        for (const tx of mergedTxs) {
            await client.query(
                `INSERT INTO transactions (id, account_id, title, amount, type, category, date, note, last_modified)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [tx.id, tx.account_id, tx.title, tx.amount, tx.type, tx.category, tx.date, tx.note || '', tx.last_modified]
            );
        }

        await client.query('COMMIT');

        // Map lists to response structures matching DTOs
        const responseTxs = mergedTxs.map(tx => ({
            id: tx.id,
            title: tx.title,
            amount: parseFloat(tx.amount),
            type: tx.type,
            category: tx.category,
            date: parseInt(tx.date),
            note: tx.note || '',
            accountId: tx.account_id
        }));

        const responseCats = mergedCats.map(cat => ({
            id: cat.id,
            name: cat.name,
            color: cat.color,
            iconName: cat.icon_name,
            budgetLimit: parseInt(cat.budget_limit),
            accountId: cat.account_id
        }));

        const responseSgs = mergedSgs.map(sg => ({
            id: sg.id,
            title: sg.title,
            targetAmount: parseFloat(sg.target_amount),
            currentAmount: parseFloat(sg.current_amount),
            color: sg.color,
            iconName: sg.icon_name,
            accountId: sg.account_id
        }));

        const responseMbs = mergedMbs.map(mb => ({
            id: mb.id,
            monthYear: mb.month_year,
            limitAmount: parseFloat(mb.limit_amount),
            accountId: mb.account_id
        }));

        const responseRts = mergedRts.map(rt => ({
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

// Start Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server is running on port ${PORT}`);
    await initDatabase();
});
