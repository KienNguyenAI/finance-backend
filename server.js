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

// Base Route - Health check
app.get('/', (req, res) => {
    res.send('Finance App API Backend is running! (PostgreSQL connected)');
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

// 3. API Đồng bộ giao dịch (Sync Transactions)
app.post('/api/sync/transactions', async (req, res) => {
    const { accountId, transactions } = req.body;
    if (accountId === undefined || !Array.isArray(transactions)) {
        return res.status(400).json({ message: 'Dữ liệu đồng bộ không hợp lệ' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Step 1: Fetch existing transactions for this account from the server
        const serverResult = await client.query(
            'SELECT * FROM transactions WHERE account_id = $1',
            [accountId]
        );
        const serverMap = new Map();
        serverResult.rows.forEach(row => serverMap.set(row.id, row));

        // Step 2: Merge - Client data takes priority
        transactions.forEach(ct => {
            serverMap.set(ct.id, {
                id: ct.id,
                account_id: ct.accountId,
                title: ct.title,
                amount: ct.amount,
                type: ct.type,
                category: ct.category,
                date: ct.date,
                note: ct.note || ''
            });
        });

        // Step 3: Delete old records and re-insert merged list
        await client.query('DELETE FROM transactions WHERE account_id = $1', [accountId]);

        const mergedList = Array.from(serverMap.values());
        for (const tx of mergedList) {
            await client.query(
                `INSERT INTO transactions (id, account_id, title, amount, type, category, date, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [tx.id, tx.account_id || accountId, tx.title, tx.amount, tx.type, tx.category, tx.date, tx.note || '']
            );
        }

        await client.query('COMMIT');

        // Step 4: Return merged transactions (matching TransactionDto structure)
        const responseList = mergedList.map(tx => ({
            id: tx.id,
            title: tx.title,
            amount: parseFloat(tx.amount),
            type: tx.type,
            category: tx.category,
            date: parseInt(tx.date),
            note: tx.note || '',
            accountId: tx.account_id || accountId
        }));

        console.log(`Sync complete for accountId ${accountId}: ${responseList.length} transactions.`);
        res.status(200).json({ transactions: responseList });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Sync error:', err.message);
        res.status(500).json({ message: 'Lỗi đồng bộ: ' + err.message });
    } finally {
        client.release();
    }
});

// Start Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server is running on port ${PORT}`);
    await initDatabase();
});
