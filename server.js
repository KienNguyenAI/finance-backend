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
    const { accountId, transactions, categories, savingsGoals, monthlyBudgets, recurringTransactions } = req.body;
    if (accountId === undefined) {
        return res.status(400).json({ message: 'Thiếu accountId hợp lệ' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ==========================================
        // 1. Synchronize Transactions
        // ==========================================
        const serverTxResult = await client.query(
            'SELECT * FROM transactions WHERE account_id = $1',
            [accountId]
        );
        const serverTxMap = new Map();
        serverTxResult.rows.forEach(row => serverTxMap.set(row.id, row));

        const clientTxs = transactions || [];
        clientTxs.forEach(ct => {
            serverTxMap.set(ct.id, {
                id: ct.id,
                account_id: ct.accountId || accountId,
                title: ct.title,
                amount: ct.amount,
                type: ct.type,
                category: ct.category,
                date: ct.date,
                note: ct.note || ''
            });
        });

        await client.query('DELETE FROM transactions WHERE account_id = $1', [accountId]);
        const mergedTxs = Array.from(serverTxMap.values());
        for (const tx of mergedTxs) {
            await client.query(
                `INSERT INTO transactions (id, account_id, title, amount, type, category, date, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [tx.id, tx.account_id, tx.title, tx.amount, tx.type, tx.category, tx.date, tx.note || '']
            );
        }

        // ==========================================
        // 2. Synchronize Categories
        // ==========================================
        const serverCatResult = await client.query(
            'SELECT * FROM categories WHERE account_id = $1',
            [accountId]
        );
        const serverCatMap = new Map();
        serverCatResult.rows.forEach(row => serverCatMap.set(row.id, row));

        const clientCats = categories || [];
        clientCats.forEach(cc => {
            serverCatMap.set(cc.id, {
                id: cc.id,
                account_id: cc.accountId || accountId,
                name: cc.name,
                color: cc.color,
                icon_name: cc.iconName,
                budget_limit: cc.budgetLimit
            });
        });

        await client.query('DELETE FROM categories WHERE account_id = $1', [accountId]);
        const mergedCats = Array.from(serverCatMap.values());
        for (const cat of mergedCats) {
            await client.query(
                `INSERT INTO categories (id, account_id, name, color, icon_name, budget_limit)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [cat.id, cat.account_id, cat.name, cat.color, cat.icon_name, cat.budget_limit]
            );
        }

        // ==========================================
        // 3. Synchronize Savings Goals
        // ==========================================
        const serverSgResult = await client.query(
            'SELECT * FROM savings_goals WHERE account_id = $1',
            [accountId]
        );
        const serverSgMap = new Map();
        serverSgResult.rows.forEach(row => serverSgMap.set(row.id, row));

        const clientSgs = savingsGoals || [];
        clientSgs.forEach(csg => {
            serverSgMap.set(csg.id, {
                id: csg.id,
                account_id: csg.accountId || accountId,
                title: csg.title,
                target_amount: csg.targetAmount,
                current_amount: csg.currentAmount,
                color: csg.color,
                icon_name: csg.iconName
            });
        });

        await client.query('DELETE FROM savings_goals WHERE account_id = $1', [accountId]);
        const mergedSgs = Array.from(serverSgMap.values());
        for (const sg of mergedSgs) {
            await client.query(
                `INSERT INTO savings_goals (id, account_id, title, target_amount, current_amount, color, icon_name)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [sg.id, sg.account_id, sg.title, sg.target_amount, sg.current_amount, sg.color, sg.icon_name]
            );
        }

        // ==========================================
        // 4. Synchronize Monthly Budgets
        // ==========================================
        const serverMbResult = await client.query(
            'SELECT * FROM monthly_budgets WHERE account_id = $1',
            [accountId]
        );
        const serverMbMap = new Map();
        serverMbResult.rows.forEach(row => serverMbMap.set(row.id, row));

        const clientMbs = monthlyBudgets || [];
        clientMbs.forEach(cmb => {
            serverMbMap.set(cmb.id, {
                id: cmb.id,
                account_id: cmb.accountId || accountId,
                month_year: cmb.monthYear,
                limit_amount: cmb.limitAmount
            });
        });

        await client.query('DELETE FROM monthly_budgets WHERE account_id = $1', [accountId]);
        const mergedMbs = Array.from(serverMbMap.values());
        for (const mb of mergedMbs) {
            await client.query(
                `INSERT INTO monthly_budgets (id, account_id, month_year, limit_amount)
                 VALUES ($1, $2, $3, $4)`,
                [mb.id, mb.account_id, mb.month_year, mb.limit_amount]
            );
        }

        // ==========================================
        // 5. Synchronize Recurring Transactions
        // ==========================================
        const serverRtResult = await client.query(
            'SELECT * FROM recurring_transactions WHERE account_id = $1',
            [accountId]
        );
        const serverRtMap = new Map();
        serverRtResult.rows.forEach(row => serverRtMap.set(row.id, row));

        const clientRts = recurringTransactions || [];
        clientRts.forEach(crt => {
            serverRtMap.set(crt.id, {
                id: crt.id,
                account_id: crt.accountId || accountId,
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
                created_date: crt.createdDate
            });
        });

        await client.query('DELETE FROM recurring_transactions WHERE account_id = $1', [accountId]);
        const mergedRts = Array.from(serverRtMap.values());
        for (const rt of mergedRts) {
            await client.query(
                `INSERT INTO recurring_transactions (id, account_id, title, amount, type, category, note, frequency, day_of_week, day_of_month, next_execution_date, is_enabled, created_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                    rt.id, rt.account_id, rt.title, rt.amount, rt.type, rt.category, rt.note || '',
                    rt.frequency, rt.day_of_week, rt.day_of_month, rt.next_execution_date, rt.is_enabled, rt.created_date
                ]
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
