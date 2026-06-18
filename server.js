const express = require('express');
const app = express();

app.use(express.json());

// In-memory databases (for testing purposes)
const users = [];
const transactions = [];

// Logger middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Base Route
app.get('/', (req, res) => {
    res.send('Finance App API Backend is running!');
});

// 1. API Đăng ký
app.post('/api/auth/register', (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ message: "Thiếu thông tin đăng ký" });
    }

    const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existingUser) {
        return res.status(400).json({ message: "Email này đã được đăng ký" });
    }

    const newUser = {
        id: users.length + 1,
        name,
        email: email.toLowerCase(),
        password
    };
    users.push(newUser);
    console.log(`Registered user: ${email}`);
    
    // Return response matching RegisterResponse.kt DTO
    res.status(200).json({
        id: newUser.id,
        name: newUser.name,
        email: newUser.email
    });
});

// 2. API Đăng nhập
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: "Thiếu email hoặc mật khẩu" });
    }

    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
        return res.status(404).json({ message: "Email không tồn tại trên hệ thống" });
    }

    if (user.password !== password) {
        return res.status(401).json({ message: "Mật khẩu không chính xác" });
    }

    console.log(`User logged in: ${email}`);
    
    // Return response matching LoginResponse.kt DTO
    res.status(200).json({
        id: user.id,
        name: user.name,
        email: user.email,
        token: "mock-jwt-token"
    });
});

// 3. API Đồng bộ giao dịch (Sync Transactions)
app.post('/api/sync/transactions', (req, res) => {
    const { accountId, transactions: clientTransactions } = req.body;
    if (accountId === undefined || !Array.isArray(clientTransactions)) {
        return res.status(400).json({ message: "Dữ liệu đồng bộ không hợp lệ" });
    }

    console.log(`Sync request from accountId ${accountId} with ${clientTransactions.length} transactions.`);

    // 1. Lọc ra các giao dịch hiện tại của accountId này trên server
    const otherUsersTx = transactions.filter(t => t.accountId !== accountId);
    const serverUserTx = transactions.filter(t => t.accountId === accountId);

    // 2. Merge logic: Gộp danh sách client gửi lên và server đang có.
    // Lấy client làm ưu tiên: nếu trùng ID, ghi đè bằng client. Nếu ID mới, thêm mới.
    const serverTxMap = new Map();
    serverUserTx.forEach(t => serverTxMap.set(t.id, t));
    
    clientTransactions.forEach(ct => {
        // Cập nhật hoặc thêm mới vào map
        serverTxMap.set(ct.id, ct);
    });

    // Chuyển map trở lại thành array
    const mergedUserTx = Array.from(serverTxMap.values());

    // 3. Cập nhật lại "database" của server
    // Xóa dữ liệu cũ của user này và nạp dữ liệu đã gộp mới
    transactions.length = 0; // Clear array
    transactions.push(...otherUsersTx, ...mergedUserTx);

    console.log(`Sync complete. Returning ${mergedUserTx.length} transactions for accountId ${accountId}.`);

    // Trả về danh sách đã đồng bộ
    res.status(200).json({
        transactions: mergedUserTx
    });
});

// Start Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
