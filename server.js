const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');

const app = express();
const port = 3000;
const saltRounds = 10;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// MySQL connection
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '123456',
    database: 'sensor_data'
});

db.connect((err) => {
    if (err) {
        console.error('Lỗi kết nối với MySQL:', err);
        return;
    }
    console.log('Đã kết nối với cơ sở dữ liệu MySQL');
});

// Lưu trữ trạng thái relay
let relayStates = {
    node1: 'off', // Relay kênh 1 (phun sương) Node1
    node1_bom: 'off', // Relay kênh 2 (máy bơm) Node1
    node2: 'off', // Relay kênh 1 (phun sương) Node2
    node2_bom: 'off' // Relay kênh 2 (máy bơm) Node2
};

// Thiết lập WebSocket server
const wss = new WebSocket.Server({ port: 8080 });
let esp32Client = null;

wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    esp32Client = ws; // Lưu client ESP32

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            console.log('Nhận từ ESP32:', data);

            // Xử lý trạng thái relay từ ESP32
            if (data.type === 'relay-status') {
                const { node, status, channel } = data;
                if (node === 'Node1') {
                    if (channel === '1') {
                        relayStates.node1 = status;
                    } else {
                        relayStates.node1_bom = status;
                    }
                } else if (node === 'Node2') {
                    if (channel === '1') {
                        relayStates.node2 = status;
                    } else {
                        relayStates.node2_bom = status;
                    }
                }
                console.log(`Cập nhật trạng thái relay ${node} kênh ${channel}: ${status}`);
            }
        } catch (err) {
            console.error('Lỗi xử lý tin nhắn WebSocket:', err);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        esp32Client = null;
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

// Endpoint API để nhận dữ liệu cảm biến
app.post('/api/sensors', (req, res) => {
    console.log('Nhận dữ liệu cảm biến:', req.body);
    const { node, mq2, flame, temp, hum } = req.body;

    if (!node || !['Node1', 'Node2'].includes(node)) {
        return res.status(400).json({ error: 'Nút không hợp lệ' });
    }

    const table = node;
    const query = `INSERT INTO ${table} (mq2, flame, temp, hum) VALUES (?, ?, ?, ?)`;
    db.query(query, [mq2, flame, temp, hum], (err, result) => {
        if (err) {
            console.error('Lỗi chèn dữ liệu:', err);
            return res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' });
        }
        res.status(200).json({ message: 'Dữ liệu đã được chèn thành công', id: result.insertId });
    });
});

// Endpoint API để lấy dữ liệu từ Node1
app.get('/api/sensors/node1', (req, res) => {
    const query = 'SELECT * FROM Node1 ORDER BY timestamp DESC LIMIT 50';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Lỗi lấy dữ liệu Node1:', err);
            return res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' });
        }
        const response = results.map(row => ({
            id: row.id,
            mq2: row.mq2,
            flame: row.flame,
            temp: row.temp,
            hum: row.hum,
            timestamp: row.timestamp,
            relay: relayStates.node1,
            relay2: relayStates.node1_bom
        }));
        res.status(200).json(response);
    });
});

// Endpoint API để lấy dữ liệu từ Node2
app.get('/api/sensors/node2', (req, res) => {
    const query = 'SELECT * FROM Node2 ORDER BY timestamp DESC LIMIT 50';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Lỗi lấy dữ liệu Node2:', err);
            return res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' });
        }
        const response = results.map(row => ({
            id: row.id,
            mq2: row.mq2,
            flame: row.flame,
            temp: row.temp,
            hum: row.hum,
            timestamp: row.timestamp,
            relay: relayStates.node2,
            relay2: relayStates.node2_bom
        }));
        res.status(200).json(response);
    });
});

// Endpoint API để gửi lệnh điều khiển
app.post('/api/control', (req, res) => {
    console.log('Nhận yêu cầu /api/control:', req.body);
    const { command } = req.body;
    const validCommands = [
        'Node1:led on', 'Node1:led off', 'Node1:bom on', 'Node1:bom off', 'Node1:auto',
        'Node2:led on', 'Node2:led off', 'Node2:bom on', 'Node2:bom off', 'Node2:auto'
    ];
    if (!validCommands.includes(command)) {
        console.log('Lệnh không hợp lệ:', command);
        return res.status(400).json({ error: 'Lệnh không hợp lệ' });
    }
    if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
        console.error('WebSocket client chưa sẵn sàng hoặc chưa kết nối');
        return res.status(500).json({ error: 'WebSocket client chưa sẵn sàng' });
    }
    // Cập nhật trạng thái relay
    if (command.startsWith('Node1:')) {
        if (command.includes('led')) {
            relayStates.node1 = command.includes('led on') ? 'on' : 'off';
        } else if (command.includes('bom')) {
            relayStates.node1_bom = command.includes('bom on') ? 'on' : 'off';
        }
    } else if (command.startsWith('Node2:')) {
        if (command.includes('led')) {
            relayStates.node2 = command.includes('led on') ? 'on' : 'off';
        } else if (command.includes('bom')) {
            relayStates.node2_bom = command.includes('bom on') ? 'on' : 'off';
        }
    }
    // Gửi lệnh qua WebSocket
    esp32Client.send(JSON.stringify({ type: 'control', command: command }), (err) => {
        if (err) {
            console.error('Lỗi gửi lệnh qua WebSocket:', err);
            return res.status(500).json({ error: 'Không thể gửi lệnh qua WebSocket' });
        }
        console.log('Đã gửi lệnh qua WebSocket:', command);
        res.status(200).json({ message: 'Lệnh gửi thành công' });
    });
});

// Endpoint API để nhận trạng thái relay từ ESP32
app.post('/api/relay-status', (req, res) => {
    console.log('Nhận trạng thái relay:', req.body);
    const { node, status, channel } = req.body;
    if (!node || !['Node1', 'Node2'].includes(node) || !['on', 'off'].includes(status) || !['1', '2'].includes(channel)) {
        return res.status(400).json({ error: 'Dữ liệu trạng thái không hợp lệ' });
    }
    if (node === 'Node1') {
        if (channel === '1') {
            relayStates.node1 = status;
        } else {
            relayStates.node1_bom = status;
        }
    } else {
        if (channel === '1') {
            relayStates.node2 = status;
        } else {
            relayStates.node2_bom = status;
        }
    }
    console.log(`Cập nhật trạng thái relay ${node} kênh ${channel}: ${status}`);
    res.status(200).json({ message: 'Trạng thái relay cập nhật thành công' });
});

// Endpoint API để đăng ký người dùng
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Tên đăng nhập và mật khẩu là bắt buộc' });
    }
    const checkUserQuery = 'SELECT * FROM users WHERE username = ?';
    db.query(checkUserQuery, [username], (err, results) => {
        if (err) {
            console.error('Lỗi kiểm tra người dùng:', err);
            return res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' });
        }
        if (results.length > 0) {
            return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
        }
        bcrypt.hash(password, saltRounds, (err, hash) => {
            if (err) {
                console.error('Lỗi mã hóa mật khẩu:', err);
                return res.status(500).json({ error: 'Lỗi mã hóa mật khẩu' });
            }
            const insertUserQuery = 'INSERT INTO users (username, password) VALUES (?, ?)';
            db.query(insertUserQuery, [username, hash], (err, result) => {
                if (err) {
                    console.error('Lỗi đăng ký:', err);
                    return res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' });
                }
                res.status(201).json({ message: 'Đăng ký thành công! Vui lòng đăng nhập.' });
            });
        });
    });
});

// Endpoint API để lấy tất cả dữ liệu từ cả hai node
app.get('/api/sensors/all', (req, res) => {
    const queryNode1 = 'SELECT * FROM Node1 ORDER BY timestamp DESC';
    const queryNode2 = 'SELECT * FROM Node2 ORDER BY timestamp DESC';

    db.query(queryNode1, (err, resultsNode1) => {
        if (err) {
            console.error('Error fetching Node1 data:', err);
            return res.status(500).json({ error: 'Database error for Node1' });
        }

        db.query(queryNode2, (err, resultsNode2) => {
            if (err) {
                console.error('Error fetching Node2 data:', err);
                return res.status(500).json({ error: 'Database error for Node2' });
            }

            const response = {
                node1: resultsNode1.map(row => ({
                    id: row.id,
                    mq2: row.mq2,
                    flame: row.flame,
                    temp: row.temp,
                    hum: row.hum,
                    timestamp: row.timestamp,
                    relay: relayStates.node1,
                    relay2: relayStates.node1_bom
                })),
                node2: resultsNode2.map(row => ({
                    id: row.id,
                    mq2: row.mq2,
                    flame: row.flame,
                    temp: row.temp,
                    hum: row.hum,
                    timestamp: row.timestamp,
                    relay: relayStates.node2,
                    relay2: relayStates.node2_bom
                }))
            };

            res.status(200).json(response);
        });
    });
});

// Endpoint API để đăng nhập
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Tên đăng nhập và mật khẩu là bắt buộc' });
    }
    const query = 'SELECT * FROM users WHERE username = ?';
    db.query(query, [username], (err, results) => {
        if (err) {
            console.error('Lỗi đăng nhập:', err);
            return res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' });
        }
        if (results.length === 0) {
            return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
        }
        const user = results[0];
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err) {
                console.error('Lỗi kiểm tra mật khẩu:', err);
                return res.status(500).json({ error: 'Lỗi kiểm tra mật khẩu' });
            }
            if (isMatch) {
                res.status(200).json({ message: 'Đăng nhập thành công' });
            } else {
                res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
            }
        });
    });
});

// Phục vụ file tĩnh
app.use(express.static(path.join(__dirname, 'public')));

// Phục vụ file index.html tại trang chủ
app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Phục vụ file login.html
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Khởi động server
app.listen(port, () => {
    console.log(`Server đang chạy trên cổng ${port}`);
    console.log(`WebSocket server đang chạy trên cổng 8080`);
});