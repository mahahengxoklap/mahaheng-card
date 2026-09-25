const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const https = require('https');
const Tesseract = require('tesseract.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '15mb' }));

app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

app.use(express.static('public'));

let userWallets = {}; 
let rooms = {}; 

const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbyEZ6aTPopBLXQ3Y6N8MCz70HNgCKOfPFMKDAOGPWzCtyeZ1XpjMmvww7ScmT7KLCA0zA/exec";

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            let weight = 0;
            if (v === 'A') weight = 1;
            else if (['J', 'Q', 'K', '10'].includes(v)) weight = 0;
            else weight = parseInt(v);
            deck.push({ suit: s, value: v, weight: weight });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function calculateScore(cards) {
    let totalWeight = cards.reduce((sum, card) => sum + card.weight, 0);
    let score = totalWeight % 10;
    let isPokShot = (cards.length === 2 && (score === 8 || score === 9));
    return { score, isPokShot };
}

function sendDepositToGoogleSheet(depositData, socket) {
    const postData = JSON.stringify({
        action: depositData.action || "deposit",
        date: depositData.date || new Date().toLocaleDateString(),
        time: depositData.time || new Date().toLocaleTimeString(),
        username: depositData.username,
        amount: depositData.amount,
        refNo: depositData.refNo,
        type: depositData.type 
    });

    sendPostRequest(postData, (jsonRes) => {
        if (jsonRes.status === 'success') {
            let newBal = Number(jsonRes.balance) || 0;
            userWallets[depositData.username] = newBal;

            for (let [id, sock] of io.sockets.sockets) {
                if (sock.username === depositData.username) {
                    sock.emit('update_balance', { balance: newBal });
                    sock.emit('deposit_auto_success', `🎉 เติມເງິນ ${depositData.amount.toLocaleString()} ກີບ (ເລກໃບບິນ/ອ້າງອີງ: ${depositData.refNo}) ສຳເລັດ!`);
                }
            }
        } else {
            socket.emit('error_msg', jsonRes.message || '❌ ສະລິບນີ້ຖືກໃຊ້ງານໄປແລ້ວ!');
        }
    }, socket);
}

function sendWithdrawToGoogleSheet(withdrawData, socket) {
    const postData = JSON.stringify({
        action: "withdraw",
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        username: withdrawData.username,
        amount: withdrawData.amount,
        type: "ຖອນເງິນ"
    });

    sendPostRequest(postData, (jsonRes) => {
        if (jsonRes.status === 'success') {
            let newBal = Number(jsonRes.balance) || 0;
            userWallets[withdrawData.username] = newBal;
            socket.emit('update_balance', { balance: newBal });
            socket.emit('withdraw_success', { msg: `✅ ບັນທຶກການແຈ້ງຖອນ ${withdrawData.amount.toLocaleString()} ກີບລົງລະບົບສຳເລັດ!`, balance: newBal });
        } else {
            socket.emit('error_msg', jsonRes.message || '❌ ເຄດິດໃນກະເປົາຂອງທ່ານບໍ່ພໍຖອນ!');
        }
    }, socket);
}

function sendGameLogToGoogleSheet(logData) {
    const postData = JSON.stringify({
        action: "game_log",
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        username: logData.username,
        dealerCards: logData.dealerCards,
        playerCards: logData.playerCards,
        scores: logData.scores,
        bet: logData.bet,
        result: logData.result,
        amount: logData.amount,
        balance: logData.balance
    });
    sendPostRequest(postData, () => {}, null);
}

function sendPostRequest(postData, callback, socket) {
    const urlObj = new URL(GOOGLE_SHEET_URL);
    const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            https.get(res.headers.location, (redirectRes) => {
                handleResponse(redirectRes, callback, socket);
            });
            return;
        }
        handleResponse(res, callback, socket);
    });

    req.on('error', (error) => {
        if (socket) socket.emit('error_msg', '❌ ບໍ່ສາມາດເຊື່ອມຕໍ່ Google Sheet ໄດ້');
    });

    req.write(postData);
    req.end();
}

function handleResponse(res, callback, socket) {
    let responseBody = '';
    res.on('data', (chunk) => { responseBody += chunk; });
    res.on('end', () => {
        try {
            let cleanBody = responseBody.trim();
            let jsonRes = JSON.parse(cleanBody);
            if (callback) callback(jsonRes);
        } catch (e) {
            if (socket) {
                if (responseBody.includes("success") || responseBody.length > 0) {
                    if (callback) callback({ status: "success", balance: 0 });
                } else {
                    socket.emit('error_msg', '❌ ບໍ່ສາມາດອ່ານຜົນຕອບກັບໄດ້');
                }
            } else {
                if (callback) callback({ status: "success", balance: 0 });
            }
        }
    });
}

function fetchUserBalanceFromSheet(username, socket) {
    const targetUrl = `${GOOGLE_SHEET_URL}?username=${encodeURIComponent(username)}`;
    
    function makeGetRequest(url) {
        const urlObj = new URL(url);
        https.get({
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            headers: { 'User-Agent': 'NodeJS' }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                makeGetRequest(res.headers.location);
                return;
            }
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    let data = JSON.parse(body.trim());
                    let bal = Number(data.balance) || 0;
                    userWallets[username] = bal; 
                    socket.emit('update_balance', { balance: bal });
                } catch (e) {
                    if (userWallets[username] === undefined) userWallets[username] = 0;
                    socket.emit('update_balance', { balance: userWallets[username] });
                }
            });
        }).on('error', () => {
            if (userWallets[username] === undefined) userWallets[username] = 0;
            socket.emit('update_balance', { balance: userWallets[username] });
        });
    }
    
    makeGetRequest(targetUrl);
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('login_user', (data) => {
        let username = data.username.trim();
        if (!username) return;
        socket.username = username;
        
        if (userWallets[username] !== undefined) {
            socket.emit('update_balance', { balance: userWallets[username] });
        } else {
            socket.emit('update_balance', { balance: 0 });
        }
        
        fetchUserBalanceFromSheet(username, socket); 
    });

    socket.on('send_message', (data) => {
        let room = data.roomId;
        let payload = { username: socket.username || 'Guest', text: data.text };
        if (room) {
            io.to(room).emit('receive_message', payload);
        } else {
            io.emit('receive_message', payload);
        }
    });

    socket.on('play_with_dealer', (data) => {
        let username = socket.username;
        if (!username || userWallets[username] === undefined) {
            socket.emit('error_msg', 'ກະລຸນາປ້ອນຊື່ User ກ່ອນ!');
            return;
        }

        let betAmount = parseInt(data.amount);
        if (isNaN(betAmount) || betAmount < 1000) return;

        if (userWallets[username] < betAmount) {
            socket.emit('error_msg', 'ເຄດິດຂອງທ່ານບໍ່ພໍ! ກະລຸນາຝາກເງິນກ່ອນ');
            return;
        }

        userWallets[username] -= betAmount;

        let deck = createDeck();
        let playerCards = [deck.pop(), deck.pop()];
        let dealerCards = [deck.pop(), deck.pop()];

        let playerCalc = calculateScore(playerCards);
        let dealerCalc = calculateScore(dealerCards);

        let isHighBet = betAmount >= 20000; 
        let dealerBoostChance = isHighBet ? 0.85 : 0.65; 
        let minDealerScoreNeeded = isHighBet ? 6 : 5;     

        if (dealerCalc.score < minDealerScoreNeeded && Math.random() < dealerBoostChance) {
            dealerCards[1] = deck.pop();
            dealerCalc = calculateScore(dealerCards);
        }

        if (isHighBet && playerCalc.isPokShot && dealerCalc.score < 8 && Math.random() < 0.50) {
            dealerCards[1] = deck.pop();
            dealerCalc = calculateScore(dealerCards);
        }

        let result = '';
        let finalPayoutChange = 0; 
        let actualBetDeduced = betAmount;

        let isPlayerPok = playerCalc.isPokShot;
        let isDealerPok = dealerCalc.isPokShot;

        if (isPlayerPok || isDealerPok) {
            if (isPlayerPok && isDealerPok) {
                if (playerCalc.score > dealerCalc.score) {
                    let multiplier = (playerCalc.score >= 8) ? 2 : 1;
                    result = `ຊະນະ! ປ໋ອກຊ໋ອດ ${playerCalc.score} ແຕ້ມ`;
                    finalPayoutChange = betAmount + (betAmount * multiplier); 
                } else if (playerCalc.score < dealerCalc.score) {
                    let multiplier = (dealerCalc.score >= 8) ? 2 : 1;
                    result = `ເສຍ! ເຈົ້າມືປ໋ອກຊ໋ອດ ${dealerCalc.score} ແຕ້ມ`;
                    finalPayoutChange = 0; 
                    actualBetDeduced = betAmount * multiplier; 
                } else {
                    result = 'ສະເໝີ (ປ໋ອກຊ໋ອດທັງຄູ່)';
                    finalPayoutChange = betAmount; 
                }
            } else if (isPlayerPok) {
                let multiplier = (playerCalc.score >= 8) ? 2 : 1;
                result = `ຊະນະ! ປ໋ອກຊ໋ອດ ${playerCalc.score} ແຕ້ມ`;
                finalPayoutChange = betAmount + (betAmount * multiplier); 
            } else {
                let multiplier = (dealerCalc.score >= 8) ? 2 : 1;
                result = `ເສຍ! ເຈົ້າມືປ໋ອກຊ໋ອດ ${dealerCalc.score} ແຕ້ມ`;
                finalPayoutChange = 0; 
                actualBetDeduced = betAmount * multiplier; 
            }
        } else {
            if (playerCalc.score > dealerCalc.score) {
                result = `ຊະນະດ້ວຍ ${playerCalc.score} ແຕ້ມ!`;
                finalPayoutChange = betAmount * 2; 
            } else if (playerCalc.score < dealerCalc.score) {
                result = `ເສຍ! ເຈົ້າມືໄດ້ ${dealerCalc.score} ແຕ້ມ`;
                finalPayoutChange = 0; 
            } else {
                result = 'ສະເໝີ!';
                finalPayoutChange = betAmount; 
            }
        }

        if (finalPayoutChange === 0 && actualBetDeduced > betAmount) {
            let extraLoss = actualBetDeduced - betAmount;
            if (userWallets[username] >= extraLoss) {
                userWallets[username] -= extraLoss;
            } else {
                userWallets[username] = 0; 
            }
        }

        userWallets[username] += finalPayoutChange;
        let netDisplayAmount = finalPayoutChange - actualBetDeduced; 

        sendGameLogToGoogleSheet({
            username: username,
            dealerCards: dealerCards.map(c => c.value + c.suit).join(' '),
            playerCards: playerCards.map(c => c.value + c.suit).join(' '),
            scores: `P:${playerCalc.score} vs D:${dealerCalc.score}`,
            bet: actualBetDeduced,
            result: result,
            amount: netDisplayAmount,
            balance: userWallets[username]
        });

        socket.emit('game_result', {
            playerCards,
            dealerCards,
            playerScore: playerCalc.score,
            dealerScore: dealerCalc.score,
            result,
            payout: netDisplayAmount, 
            balance: userWallets[username]
        });

        socket.emit('update_balance', { balance: userWallets[username] });
    });

    // 🌐 [ເພີ່ມໃໝ່] ລະບົບສ້າງຫ້ອງຊວນໝູ່ແບບເລືອກກົດລະບຽບ Custom Rules
    socket.on('create_custom_room', (data) => {
        let roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        let rules = data.rules || { aaBonus: false, dengBonus: false };
        
        rooms[roomId] = {
            host: socket.username,
            players: [{ username: socket.username, socketId: socket.id }],
            rules: rules,
            status: 'waiting'
        };

        socket.join(roomId);
        socket.currentRoom = roomId;

        socket.emit('room_created', {
            roomId: roomId,
            rules: rules,
            players: rooms[roomId].players.map(p => ({ name: p.username, credit: userWallets[p.username] || 0 }))
        });
    });

    // 🚪 [ເພີ່ມໃໝ່] ລະບົບເຂົ້າຫ້ອງຊວນໝູ່ Custom Room
    socket.on('join_custom_room', (data) => {
        let roomId = data.roomId.toUpperCase();
        if (rooms[roomId]) {
            let room = rooms[roomId];
            let exists = room.players.find(p => p.username === socket.username);
            
            if (!exists) {
                room.players.push({ username: socket.username, socketId: socket.id });
            }

            socket.join(roomId);
            socket.currentRoom = roomId;

            io.to(roomId).emit('update_room_players', {
                roomId: roomId,
                rules: room.rules,
                players: room.players.map(p => ({ name: p.username, credit: userWallets[p.username] || 0 }))
            });
        } else {
            socket.emit('error_msg', '❌ ບໍ່ພົບລະຫັດຫ້ອງນີ້!');
        }
    });

    socket.on('create_room', () => {
        let roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomId] = { host: socket.username, players: [socket.username] };
        socket.join(roomId);
        socket.currentRoom = roomId;
        socket.emit('room_created', { roomId, players: rooms[roomId].players.map(p => ({ name: p, credit: userWallets[p] || 0 })) });
    });

    socket.on('join_room', (data) => {
        let roomId = data.roomId.toUpperCase();
        if (rooms[roomId]) {
            if (!rooms[roomId].players.includes(socket.username)) {
                rooms[roomId].players.push(socket.username);
            }
            socket.join(roomId);
            socket.currentRoom = roomId;
            io.to(roomId).emit('update_room_players', { roomId, players: rooms[roomId].players.map(p => ({ name: p, credit: userWallets[p] || 0 })) });
        } else {
            socket.emit('error_msg', 'ບໍ່ພົບລະຫັດຫ້ອງນີ້!');
        }
    });

    socket.on('request_deposit_auto', async (data) => {
        let username = data.username.trim();
        let amount = parseInt(data.amount);
        let slipBase64 = data.slip;

        if (!username || isNaN(amount) || amount <= 0 || !slipBase64) {
            socket.emit('error_msg', '❌ ຂໍ້ມູນບໍ່ຄົບຖ້ວນ!');
            return;
        }

        try {
            let matches = slipBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/),
                buffer = Buffer.from(matches[2], 'base64');

            socket.emit('deposit_status', '🔍 AI ກຳລັງອ່ານເລກໃບບິນ/ອ້າງອີງຈາກສະລິບ...');

            let { data: { text } } = await Tesseract.recognize(buffer, 'eng+lao');
            
            let billMatch = text.match(/bill\s*(\d{13,15})/i) || 
                            text.match(/reference\s*(\d{10,15})/i) || 
                            text.match(/ref\s*[:\.]?\s*(\d{10,15})/i) || 
                            text.match(/ອ້າງອີງ\s*[:\.]?\s*(\d{10,15})/i) || 
                            text.match(/\b(20\d{11,13})\b/) || 
                            text.match(/\b\d{13,15}\b/);
                            
            let refNo = billMatch ? billMatch[1] || billMatch[0] : '';

            if (!refNo || refNo.length < 8) {
                io.emit('admin_show_failed_slip', {
                    username: username,
                    amount: amount,
                    slip: slipBase64
                });

                socket.emit('deposit_ai_failed', {
                    msg: '❌ AI ອ່ານເລກໃບບິນ/ອ້າງອີງບໍ່ຜ່ານ, ກະລຸນາຄລິກສົ່ງ WhatsApp ຫາແອັດມິນຂ້າງລຸ່ມນີ້',
                    username,
                    amount
                });
                return;
            }

            let depositItem = {
                action: "deposit",
                username: username,
                amount: amount,
                refNo: refNo,
                type: "ລູກຄ້າເຕີມເອງ"
            };

            sendDepositToGoogleSheet(depositItem, socket);

        } catch (err) {
            console.error(err);
            
            io.emit('admin_show_failed_slip', {
                username: username,
                amount: amount,
                slip: slipBase64
            });

            socket.emit('deposit_ai_failed', {
                msg: '❌ ເກີດຂໍ້ຜິດພາດໃນການອ່ານສະລິບ, ກະລຸນາສົ່ງ WhatsApp ຫາແອັດມິນ',
                username,
                amount
            });
        }
    });

    socket.on('admin_deposit_request', (data) => {
        let username = data.username.trim();
        let amount = parseInt(data.amount);
        let refNo = data.refNo.trim();

        if (!username || isNaN(amount) || amount <= 0 || !refNo) {
            socket.emit('admin_deposit_result', { status: 'error', msg: '❌ ຂໍ້ມູນບໍ່ຄົບຖ້ວນ!' });
            return;
        }

        let depositItem = {
            action: "deposit_admin",
            date: new Date().toLocaleDateString(),
            time: new Date().toLocaleTimeString(),
            username: username,
            amount: amount,
            refNo: refNo,
            type: "ແອັດມິນ"
        };

        sendDepositToGoogleSheet(depositItem, socket);
        socket.emit('admin_deposit_result', { status: 'success', msg: `✅ ຢືນຍັນເຕີມເງິນໃຫ້ User "${username}" ຈຳນວນ ${amount.toLocaleString()} ກີບສຳເລັດ!` });
    });

    socket.on('request_withdraw', (data) => {
        let username = data.username.trim();
        let amount = parseInt(data.amount);

        if (!username || isNaN(amount) || amount <= 500) {
            socket.emit('error_msg', '❌ ກະລຸນາໃສ່ຈຳນວນເງິນຖອນໃຫ້ຖືກຕ້ອງ!');
            return;
        }

        if ((userWallets[username] || 0) < amount) {
            socket.emit('error_msg', '❌ ເຄດິດໃນກະເປົາຂອງທ່ານບໍ່ພໍຖອນ!');
            return;
        }

        sendWithdrawToGoogleSheet({ username, amount }, socket);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});